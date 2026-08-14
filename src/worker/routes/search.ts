// 搜索测试路由 - 通过 Worker 调用浏览器搜索，供管理后台测试使用
import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";

export async function handleSearchTest(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();
  const type = url.searchParams.get("type") || "web";
  if (!q) return json({ error: "缺少搜索关键词 q" }, 400);

  if (!env.BROWSER) {
    return json({ ok: false, error: "浏览器搜索未配置（BROWSER binding 不存在）" });
  }

  try {
    // 图片搜索：Bing Images
    if (type === "image") {
      const searchUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(q)}`;
      const resp = await env.BROWSER.quickAction("content", { url: searchUrl });
      if (!resp.ok) {
        return json({ ok: false, error: `图片搜索失败 (HTTP ${resp.status})` });
      }
      const data = await resp.json() as any;
      if (!data?.success || !data?.result) {
        return json({ ok: false, error: "图片搜索返回空结果" });
      }
      const html = data.result as string;
      const items: Array<{ url: string; thumb?: string; title: string }> = [];
      // Bing 图片搜索：murl 是原图 URL，m 是缩略图
      const imgRe = /class="iusc"[^>]*m="([^"]+)"/g;
      let match: RegExpExecArray | null;
      while ((match = imgRe.exec(html)) !== null && items.length < 12) {
        try {
          const meta = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/\\"/g, '"'));
          if (meta.murl) {
            items.push({
              url: meta.murl,
              thumb: meta.m || undefined,
              title: meta.t || "",
            });
            if (items.length >= 12) break;
          }
        } catch {}
      }
      // 兜底：data-src 缩略图
      if (items.length === 0) {
        const thumbRe = /data-src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|gif|webp)[^"]*)"/gi;
        while ((match = thumbRe.exec(html)) !== null && items.length < 12) {
          items.push({ url: match[1], title: "" });
        }
      }
      return json({ ok: true, type: "image", items, count: items.length });
    }

    // 网页搜索
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
    const resp = await env.BROWSER.quickAction("content", {
      url: searchUrl,
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      return json({ ok: false, error: `浏览器搜索失败 (HTTP ${resp.status}): ${errBody.slice(0, 300)}` });
    }

    const data = await resp.json() as any;
    if (!data?.success || !data?.result) {
      return json({ ok: false, error: "浏览器搜索返回空结果" });
    }

    const html = data.result as string;
    const items: Array<{ title: string; url: string; description: string }> = [];
    // 复用 cloudflare-search 的 Bing 解析正则
    const resultRegex =
      /<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g;
    let match: RegExpExecArray | null;
    while ((match = resultRegex.exec(html)) !== null && items.length < 10) {
      let url = match[1];
      // 解码 Bing 重定向链接
      if (url.includes("bing.com/ck/a?")) {
        try {
          const decodedUrl = url.replace(/&amp;/g, "&");
          const uParam = new URL(decodedUrl).searchParams.get("u");
          if (uParam?.startsWith("a1")) {
            url = atob(uParam.slice(2));
          }
        } catch {}
      }
      const title = match[2].replace(/<[^>]+>/g, "").trim();
      const description = match[3].replace(/<[^>]+>/g, "").trim();
      // 过滤微软推广页和 Bing 自身链接（无 cookie 会话时 Bing 会返回微软官网/Office 等无关结果）
      const msDomains = /(^|\.)(microsoft|office|live|outlook|msn|bing|windows|sharepoint)\.com$/i;
      let hostname = "";
      try { hostname = new URL(url).hostname; } catch {}
      if (title && url && !msDomains.test(hostname)) {
        items.push({ title, url, description });
      }
    }

    return json({ ok: true, type: "web", items, count: items.length });
  } catch (e: any) {
    return json({ ok: false, error: `搜索失败: ${e?.message || "未知错误"}` });
  }
}