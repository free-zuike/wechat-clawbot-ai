// 联网搜索 - 使用 Bing 图片搜索

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

    // 使用 Bing 搜索
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}${type === "images" ? "&form=HDRSC2&first=1" : ""}`;
    const resp = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });
    const html = await resp.text();

    if (type === "images") {
      const images: Array<{ url: string; title: string; source: string }> = [];
      // 提取 Bing 图片搜索结果
      const imgRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>\s*<img[^>]+src="(https?:\/\/[^"]+)"[^>]*>/gi;
      let match;
      while ((match = imgRegex.exec(html)) !== null) {
        if (images.length < 10 && !match[2].includes("bing.com")) {
          images.push({ url: match[2], title: "", source: match[1] });
        }
      }
      // 备用：提取所有图片
      if (images.length === 0) {
        const simpleImgRegex = /src="(https?:\/\/[^"]+\.(jpg|jpeg|png|gif|webp)[^"]*)"/gi;
        let m;
        while ((m = simpleImgRegex.exec(html)) !== null) {
          if (images.length < 10 && !m[1].includes("bing.com") && !m[1].includes("microsoft")) {
            images.push({ url: m[1], title: query, source: "" });
          }
        }
      }
      return json({ images, query });
    }

    // 文本搜索
    const results: Array<{ title: string; snippet: string; url: string }> = [];
    const resultRegex = /<h2[^>]*><a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a><\/h2>/gi;
    let match;
    while ((match = resultRegex.exec(html)) !== null) {
      if (results.length < 10) {
        results.push({ url: match[1], title: match[2].replace(/<[^>]+>/g, "").trim(), snippet: "" });
      }
    }
    return json({ results, query });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}
