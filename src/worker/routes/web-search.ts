// 联网搜索 - 使用 Unsplash API 返回真实图片

import { json, verifyAdmin } from "../utils";
import type { Env } from "../index";

// Unsplash 免费 API（无需密钥，有速率限制）
async function searchUnsplash(query: string): Promise<Array<{ url: string; title: string; source: string }>> {
  const resp = await fetch(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=10&client_id=demo`,
    { headers: { "Accept-Version": "v1" } }
  );
  if (!resp.ok) return [];
  const data = await resp.json() as any;
  return (data.results || []).map((r: any) => ({
    url: r.urls?.small || r.urls?.regular || "",
    title: r.alt_description || query,
    source: r.user?.name || "",
  })).filter((i: any) => i.url);
}

// 使用 Bing 图片搜索解析（备用）
async function searchBing(query: string): Promise<Array<{ url: string; title: string; source: string }>> {
  const resp = await fetch(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  const html = await resp.text();
  const images: Array<{ url: string; title: string; source: string }> = [];
  // 提取 murl（真实图片地址）
  const murlRegex = /"murl":"(https?:\/\/[^"]+)"/g;
  let match;
  while ((match = murlRegex.exec(html)) !== null && images.length < 10) {
    images.push({ url: match[1], title: query, source: "" });
  }
  return images;
}

export async function handleWebSearch(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q");
    if (!query) return json({ error: "缺少搜索关键词" }, 400);

    const type = url.searchParams.get("type") || "images";

    if (type === "images") {
      // 先尝试 Unsplash，失败则用 Bing
      let images = await searchUnsplash(query);
      if (images.length === 0) {
        images = await searchBing(query);
      }
      return json({ images, query });
    }

    // 文本搜索 - 返回搜索链接
    const links = [
      { name: "Bing", url: `https://www.bing.com/search?q=${encodeURIComponent(query)}` },
      { name: "Google", url: `https://www.google.com/search?q=${encodeURIComponent(query)}` },
      { name: "Wikipedia", url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(query)}` },
    ];
    return json({ links, query });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}
