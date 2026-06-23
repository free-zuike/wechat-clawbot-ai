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

    const type = url.searchParams.get("type") || "images"; // images | web

    if (type === "images") {
      // 使用 DuckDuckGo 图片搜索
      const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images&format=json`;
      const resp = await fetch(searchUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const data = await resp.json() as any;

      const images = (data?.RelatedTopics || [])
        .filter((t: any) => t?.Image)
        .slice(0, 10)
        .map((t: any) => ({
          url: t.Image,
          title: t.Text || "",
          source: t.FirstURL || "",
        }));

      return json({ images, query });
    }

    // 文本搜索
    const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
    const resp = await fetch(searchUrl);
    const data = await resp.json() as any;

    const results = [];
    if (data.AbstractText) {
      results.push({ title: data.Heading, snippet: data.AbstractText, url: data.AbstractURL });
    }
    for (const t of (data.RelatedTopics || []).slice(0, 5)) {
      if (t.Text && t.FirstURL) {
        results.push({ title: t.Text.split(" - ")[0], snippet: t.Text, url: t.FirstURL });
      }
    }

    return json({ results: results.slice(0, 10), query });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}
