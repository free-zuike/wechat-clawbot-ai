// 联网搜索 - Bing 图片搜索 HTML 提取真实图片

import { json, verifyAdmin } from "../utils";
import type { Env } from "../index";

async function searchBingImages(query: string): Promise<Array<{ url: string; title: string }>> {
  const images: Array<{ url: string; title: string }> = [];
  try {
    const resp = await fetch(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
    });
    const html = await resp.text();
    // 提取 turl（缩略图）和 murl（原图）
    const turlRegex = /"turl":"(https?:\/\/[^"]+)"/g;
    const murlRegex = /"murl":"(https?:\/\/[^"]+)"/g;
    const turls: string[] = [];
    const murls: string[] = [];
    let match;
    while ((match = turlRegex.exec(html)) !== null && turls.length < 5) {
      turls.push(match[1]);
    }
    while ((match = murlRegex.exec(html)) !== null && murls.length < 5) {
      murls.push(match[1]);
    }
    for (let i = 0; i < Math.min(turls.length, murls.length); i++) {
      images.push({ url: murls[i], title: query });
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

    const images = await searchBingImages(query);

    if (images.length > 0) {
      return json({ images, query });
    }

    const links = [
      { name: "Bing 图片搜索", url: `https://www.bing.com/images/search?q=${encodeURIComponent(query)}` },
      { name: "Google 图片搜索", url: `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch` },
    ];
    return json({ images: [], links, query, message: "暂无直接图片结果，请点击链接搜索" });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}
