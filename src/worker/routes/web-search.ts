// 联网搜索 - 返回搜索平台链接

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
      const links = [
        { name: "Bing 图片", url: `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2` },
        { name: "Google 图片", url: `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch` },
        { name: "Pixabay", url: `https://pixabay.com/images/search/${encodeURIComponent(query)}/` },
        { name: "Unsplash", url: `https://unsplash.com/s/photos/${encodeURIComponent(query)}` },
      ];
      return json({ links, query, message: "点击链接搜索图片，找到喜欢的图片后右键复制图片地址即可使用" });
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
