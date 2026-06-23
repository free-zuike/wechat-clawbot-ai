// 联网搜索 - 使用 Wikipedia API 返回真实图片

import { json, verifyAdmin } from "../utils";
import type { Env } from "../index";

async function searchWikipedia(query: string): Promise<Array<{ url: string; title: string; source: string }>> {
  const images: Array<{ url: string; title: string; source: string }> = [];

  // 中文 Wikipedia 搜索
  try {
    const zhResp = await fetch(`https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
    if (zhResp.ok) {
      const data = await zhResp.json() as any;
      if (data.thumbnail?.source) {
        images.push({ url: data.thumbnail.source, title: data.extract?.slice(0, 100) || query, source: "Wikipedia" });
      }
      if (data.originalimage?.source && data.originalimage.source !== data.thumbnail?.source) {
        images.push({ url: data.originalimage.source, title: data.extract?.slice(0, 100) || query, source: "Wikipedia" });
      }
    }
  } catch {}

  // 英文 Wikipedia 搜索（补充）
  if (images.length === 0) {
    try {
      const enResp = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
      if (enResp.ok) {
        const data = await enResp.json() as any;
        if (data.thumbnail?.source) {
          images.push({ url: data.thumbnail.source, title: data.extract?.slice(0, 100) || query, source: "Wikipedia" });
        }
        if (data.originalimage?.source && data.originalimage.source !== data.thumbnail?.source) {
          images.push({ url: data.originalimage.source, title: data.extract?.slice(0, 100) || query, source: "Wikipedia" });
        }
      }
    } catch {}
  }

  // Wikipedia 搜索相关页面
  try {
    const searchResp = await fetch(`https://zh.wikipedia.org/api/rest_v1/page/search/${encodeURIComponent(query)}?limit=5`);
    if (searchResp.ok) {
      const data = await searchResp.json() as any;
      for (const page of (data.pages || [])) {
        if (page.thumbnail?.source && images.length < 10) {
          images.push({ url: page.thumbnail.source, title: page.title || query, source: "Wikipedia" });
        }
      }
    }
  } catch {}

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
      const images = await searchWikipedia(query);

      if (images.length === 0) {
        const links = [
          { name: "Bing 图片", url: `https://www.bing.com/images/search?q=${encodeURIComponent(query)}` },
          { name: "Google 图片", url: `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch` },
          { name: "Pixabay", url: `https://pixabay.com/images/search/${encodeURIComponent(query)}/` },
        ];
        return json({ images: [], links, query, message: "暂无直接图片结果，请点击链接搜索" });
      }

      return json({ images, query });
    }

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
