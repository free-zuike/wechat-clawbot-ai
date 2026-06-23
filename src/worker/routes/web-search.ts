// 联网搜索 - 360 图片搜索（免费，无需 key，中文搜索最佳）

import { json, verifyAdmin } from "../utils";
import type { Env } from "../index";

export async function handleWebSearch(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q");
    if (!query) return json({ error: "缺少搜索关键词" }, 400);

    const images: Array<{ url: string; title: string }> = [];

    // 360 图片搜索 JSON API
    try {
      const resp = await fetch(`https://image.so.com/j?q=${encodeURIComponent(query)}&sn=10`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json",
          "Referer": "https://image.so.com/",
        },
      });
      const data = await resp.json() as any;
      if (data.list) {
        for (const item of data.list) {
          const imgUrl = item.img || item.thumb;
          const title = item.title || query;
          if (imgUrl && images.length < 10) {
            images.push({ url: imgUrl, title });
          }
        }
      }
    } catch {}

    if (images.length > 0) {
      return json({ images, query });
    }

    const links = [
      { name: "360 图片搜索", url: `https://image.so.com/j?q=${encodeURIComponent(query)}` },
      { name: "百度图片搜索", url: `https://image.baidu.com/search/index?tn=baiduimage&word=${encodeURIComponent(query)}` },
    ];
    return json({ images: [], links, query, message: "暂无直接图片结果" });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}
