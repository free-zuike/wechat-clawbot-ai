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
      const candidates: Array<{ url: string; thumb?: string; title: string }> = [];
      // Bing 图片搜索：murl 是原图 URL，m 是缩略图
      const imgRe = /class="iusc"[^>]*m="([^"]+)"/g;
      let match: RegExpExecArray | null;
      while ((match = imgRe.exec(html)) !== null && candidates.length < 20) {
        try {
          const meta = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/\\"/g, '"'));
          if (meta.murl) {
            candidates.push({
              url: meta.murl,
              thumb: meta.m || undefined,
              title: meta.t || "",
            });
            if (candidates.length >= 20) break;
          }
        } catch {}
      }
      // 兜底：data-src 缩略图
      if (candidates.length === 0) {
        const thumbRe = /data-src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|gif|webp)[^"]*)"/gi;
        while ((match = thumbRe.exec(html)) !== null && candidates.length < 20) {
          candidates.push({ url: match[1], title: "" });
        }
      }

      // 验证原图 URL 是否可访问，只返回真正能打开的图片
      const items: Array<{ url: string; thumb?: string; title: string }> = [];
      for (const c of candidates) {
        const ok = await verifyImageUrl(c.url);
        if (ok) {
          items.push(c);
          if (items.length >= 10) break;
        }
      }

      // 如果验证后结果太少，直接返回未验证的候选（避免过滤掉所有可用图片）
      if (items.length < 3 && candidates.length > 0) {
        return json({ ok: true, type: "image", items: candidates.slice(0, 10), count: candidates.length, note: "图片未经验证，部分可能无法加载" });
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

// 验证图片 URL 是否真的可访问（GET 前 100 字节，超时 5 秒）
async function verifyImageUrl(url: string): Promise<boolean> {
  try {
    const resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Referer": "https://www.bing.com/",
        "Range": "bytes=0-99",
      },
      signal: AbortSignal.timeout(5000),
    });
    // 206 Partial Content 或 200 OK 都算可访问
    if (resp.status !== 200 && resp.status !== 206) return false;
    const contentType = resp.headers.get("content-type") || "";
    // 接受 image/* 或 octet-stream（很多 CDN 把图片标为 octet-stream）
    return contentType.startsWith("image/") || contentType === "application/octet-stream";
  } catch {
    return false;
  }
}