// 联网搜索 - 图片搜索

import { json, verifyAdmin } from "../utils";
import type { Env } from "../index";

export async function handleWebSearch(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q");
    if (!query) return json({ error: "缺少搜索关键词" }, 400);

    const type = url.searchParams.get("type") || "images";

    if (type === "images") {
      // 使用 DuckDuckGo Lite HTML 搜索提取图片
      const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
      const resp = await fetch(searchUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      });
      const html = await resp.text();

      const images: Array<{ url: string; title: string; source: string }> = [];

      // 从搜索结果链接中提取
      const linkRegex = /<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>([^<]*)<\/a>/gi;
      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        const href = match[1];
        const title = match[2].trim();
        if (href && title && !href.includes("duckduckgo") && images.length < 10) {
          images.push({ url: href, title: title || query, source: "" });
        }
      }

      return json({ images, query });
    }

    // 文本搜索
    const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const resp = await fetch(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });
    const html = await resp.text();

    const results: Array<{ title: string; snippet: string; url: string }> = [];
    const resultRegex = /<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>([^<]*)<\/a>/gi;
    let match;
    while ((match = resultRegex.exec(html)) !== null) {
      if (results.length < 10) {
        results.push({ url: match[1], title: match[2].trim() || query, snippet: "" });
      }
    }

    return json({ results, query });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}
