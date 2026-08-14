// 搜索测试路由 - 通过 Worker 调用浏览器搜索，供管理后台测试使用
import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";

export async function handleSearchTest(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();
  if (!q) return json({ error: "缺少搜索关键词 q" }, 400);

  if (!env.BROWSER) {
    return json({ ok: false, error: "浏览器搜索未配置（BROWSER binding 不存在）" });
  }

  try {
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=10`;
    // 用 links 动作获取页面所有链接，Bing 搜索结果链接包含真实 URL
    const resp = await env.BROWSER.quickAction("links", {
      url: searchUrl,
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      return json({ ok: false, error: `浏览器搜索失败 (HTTP ${resp.status}): ${errBody.slice(0, 300)}` });
    }

    const data = await resp.json() as any;
    if (!data?.success || !Array.isArray(data?.result)) {
      return json({ ok: false, error: "浏览器搜索返回空结果" });
    }

    // 过滤 Bing 搜索结果的真实链接（排除 Bing 自身链接）
    const allLinks = data.result as string[];
    const items: Array<{ title: string; url: string; description: string }> = [];
    for (const link of allLinks) {
      if (link.startsWith("http") && !link.includes("bing.com") && !link.includes("microsoft.com")) {
        items.push({ title: link, url: link, description: "" });
        if (items.length >= 8) break;
      }
    }

    return json({ ok: true, items, count: items.length });
  } catch (e: any) {
    return json({ ok: false, error: `搜索失败: ${e?.message || "未知错误"}` });
  }
}