// 联网搜索 - 使用 LoremFlickr API 返回真实图片

import { json, verifyAdmin } from "../utils";
import type { Env } from "../index";

async function searchImages(query: string): Promise<Array<{ url: string; title: string; source: string }>> {
  const images: Array<{ url: string; title: string; source: string }> = [];

  // 方法1: LoremFlickr（免费，按关键词返回图片）
  try {
    const resp = await fetch(`https://loremflickr.com/400/300/${encodeURIComponent(query)}?lock=1`, {
      method: "HEAD",
      redirect: "follow",
    });
    if (resp.ok && resp.url) {
      images.push({ url: resp.url, title: query, source: "LoremFlickr" });
    }
  } catch {}

  // 方法2: 多张图片
  for (let i = 0; i < 4; i++) {
    try {
      const resp = await fetch(`https://loremflickr.com/400/300/${encodeURIComponent(query)}?lock=${i + 2}`, {
        method: "HEAD",
        redirect: "follow",
      });
      if (resp.ok && resp.url && !images.find(img => img.url === resp.url)) {
        images.push({ url: resp.url, title: query, source: "LoremFlickr" });
      }
    } catch {}
    if (images.length >= 5) break;
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
      const images = await searchImages(query);

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
