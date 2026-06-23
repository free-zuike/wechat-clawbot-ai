// 联网搜索 - 返回图片搜索链接

import { json, verifyAdmin } from "../utils";
import type { Env } from "../index";

export async function handleWebSearch(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q");
    if (!query) return json({ error: "缺少搜索关键词" }, 400);

    const links = [
      { name: "Bing 图片搜索", url: `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&FORM=HDRSC2` },
      { name: "Google 图片搜索", url: `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch` },
      { name: "Pixabay 免费图片", url: `https://pixabay.com/images/search/${encodeURIComponent(query)}/` },
      { name: "Unsplash 免费图片", url: `https://unsplash.com/s/photos/${encodeURIComponent(query)}` },
    ];

    return json({ links, query });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}
