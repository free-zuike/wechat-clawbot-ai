// 搜索测试路由 - 通过 Worker 调用浏览器搜索，供管理后台测试使用
import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";

export async function handleSearchTest(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();
  if (!q) return json({ error: "缺少搜索关键词 q" }, 400);

  if (!env.BROWSER) {
    return json({ ok: false, error: "浏览器搜索未配置（BROWSER binding 不存在）" });
  }

  try {
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=10`;
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
    // 查找搜索结果区域（第一个 <li class="b_algo">）
    const resultsStart = html.indexOf('<li class="b_algo"');
    const resultsSample = resultsStart !== -1 ? html.slice(resultsStart, resultsStart + 800) : "未找到 b_algo";
    console.log(`[search-test] HTML length: ${html.length}, results sample: ${resultsSample}`);
    const items: Array<{ title: string; url: string; description: string }> = [];
    // Bing 搜索结果的多种格式
    const linkRe = /<h2[^>]*>.*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) !== null && items.length < 10) {
      const itemUrl = m[1];
      const title = m[2].replace(/<[^>]*>/g, "").trim();
      if (title && !itemUrl.includes("bing.com")) {
        items.push({ title, url: itemUrl, description: "" });
      }
    }

    return json({ ok: true, items, count: items.length });
  } catch (e: any) {
    return json({ ok: false, error: `搜索失败: ${e?.message || "未知错误"}` });
  }
}