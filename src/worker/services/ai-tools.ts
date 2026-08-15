// AI 服务 - 内置工具（function calling 用的工具定义与执行）
// 从 ai.ts 拆出：BUILTIN_TOOLS + 各工具的执行逻辑（搜索/天气/新闻/图片视频生成）

import { Logger } from "../utils/error";
import type { MCPToolResult } from "./mcp";
import { generateImage, submitVideoTask } from "./ai-media";

// 内置工具：获取当前日期时间 + 中文新闻 + 网页搜索 + 天气
export const BUILTIN_TOOLS = [{
  type: "function",
  function: {
    name: "get_current_datetime",
    description: "获取当前日期和时间（中国时区 Asia/Shanghai, UTC+8），当用户问到「今天/昨天/明天/上个月/本月/上周/下周」等相对时间时，调用此工具获取准确日期后再回答",
    parameters: { type: "object", properties: {} },
  },
}, {
  type: "function",
  function: {
    name: "get_weather",
    description: "获取指定城市的实时天气和未来预报（最多 3 天），通过 wttr.in 获取。当用户问到「天气、气温、下雨、刮风、今天冷不冷、明天适合出门吗、本周天气、未来几天天气」等天气相关问题时调用此工具，不要再调用 web_search",
    parameters: { type: "object", properties: { city: { type: "string", description: "城市名（必填），如 北京/上海/广州/大同，支持中文城市名" }, days: { type: "number", description: "可选：预报天数，1=今天，2=今明两天，3=未来三天，默认 1" } }, required: ["city"] },
  },
}, {
  type: "function",
  function: {
    name: "get_news",
    description: "获取中文实时新闻和热点，从微博热搜、知乎热榜、今日头条、澎湃新闻、36氪、IT之家、B站等中文源聚合。当用户问到「今天有什么新闻/热点/热搜」时调用",
    parameters: { type: "object", properties: { source: { type: "string", description: "新闻源，可选：weibo/zhihu/baidu/toutiao/thepaper/36kr/ithome/bilibili/tencent/ifeng/sspai/juejin/douyin/hupu，留空返回全部热门" } } },
  },
}, {
  type: "function",
  function: {
    name: "web_search",
    description: "搜索互联网获取实时信息，调用 cloudflare-search 聚合搜索引擎（Google/Brave/DuckDuckGo），返回带标题、描述和链接的搜索结果。当用户需要查询最新信息、知识、网站时调用",
    parameters: { type: "object", properties: { q: { type: "string", description: "搜索关键词（必填）" } }, required: ["q"] },
  },
}, {
  type: "function",
  function: {
    name: "search_image",
    description: "搜索图片。当用户想「找/查询/搜索某张图片、某某的照片、某某的图片」时调用，通过浏览器搜索 Bing 图片，返回图片链接",
    parameters: { type: "object", properties: { q: { type: "string", description: "图片搜索关键词（必填）" } }, required: ["q"] },
  },
}, {
  type: "function",
  function: {
    name: "generate_image",
    description: "AI 生成图片。当用户说「画/生成/制作一张图片」时调用此工具，根据描述生成图片。如果用户搜索到了参考图 URL（如从 search_image 搜到的），传入 refImages 参数做以图生图",
    parameters: { type: "object", properties: { prompt: { type: "string", description: "图片描述（必填）" }, size: { type: "string", description: "可选：图片尺寸，如 1024x1024" }, refImages: { type: "array", items: { type: "string" }, description: "可选：参考图片 URL 列表，用于以图生图（如从 search_image 搜到的图片链接，可传多张）" } }, required: ["prompt"] },
  },
}, {
  type: "function",
  function: {
    name: "generate_video",
    description: "AI 生成视频。当用户说「生成视频/制作视频」时调用此工具，根据描述生成视频",
    parameters: { type: "object", properties: { prompt: { type: "string", description: "视频描述（必填）" } }, required: ["prompt"] },
  },
}, {
  type: "function",
  function: {
    name: "fetch_url",
    description: "获取指定 URL 的网页内容（纯文本）。支持多种 HTTP 方法。当用户说「帮我看看这个链接/访问这个页面/打开这个网址」时调用此工具，返回网页的文本内容",
    parameters: { type: "object", properties: { url: { type: "string", description: "目标 URL（必填），如 https://example.com/page" }, method: { type: "string", description: "HTTP 方法，可选 GET/POST/PUT/DELETE/PATCH，默认 GET" }, body: { type: "string", description: "请求体（仅 POST/PUT/PATCH 时需要），JSON 格式字符串" } }, required: ["url"] },
  },
}];

// 网页搜索：调用 cloudflare-search 聚合搜索引擎
async function executeWebSearch(query: string, searchBaseUrl?: string, searchToken?: string, browserBinding?: any, searchEngine?: string): Promise<string> {
  const q = (query || "").trim();
  if (!q) return "搜索关键词为空";
  const base = (searchBaseUrl || "").trim().replace(/\/+$/, "");
  const preferBrowser = searchEngine === "browser";

  // 按优先级尝试搜索源
  async function tryCloudflare(): Promise<string | null> {
    if (!base) return null;
    try {
      const url = searchToken
        ? `${base}/search?q=${encodeURIComponent(q)}&token=${encodeURIComponent(searchToken)}`
        : `${base}/search?q=${encodeURIComponent(q)}`;
      const resp = await fetch(url, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(15000) });
      if (resp.ok) {
        const data = await resp.json() as any;
        const items = data?.results;
        if (Array.isArray(items) && items.length > 0) {
          return items.slice(0, 10).map((it: any, i: number) =>
            `${i + 1}. ${it.title || "无标题"}\n   ${it.url || ""}\n   ${it.description || ""}`
          ).join("\n\n");
        }
      }
    } catch {}
    return null;
  }

  async function tryBrowser(): Promise<string | null> {
    if (!browserBinding) return null;
    try {
      const result = await executeBrowserSearch(browserBinding, q);
      return result;
    } catch {}
    return null;
  }

  // 根据优先级顺序尝试
  let result: string | null = null;
  let source = "";
  if (preferBrowser && browserBinding) {
    result = await tryBrowser();
    source = "浏览器搜索";
  }
  if (!result && base) {
    result = await tryCloudflare();
    source = "cloudflare-search";
  }
  if (!result && !preferBrowser && browserBinding) {
    result = await tryBrowser();
    source = "浏览器搜索";
  }

  return result ? `【来源: ${source}】\n${result}` : "没有找到相关结果";
}

// 天气查询：调用 wttr.in 免费 API（无需 API Key），days 表示预报天数（1-3）
async function executeWeatherQuery(city: string, days = 1): Promise<string> {
  try {
    const resp = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return `天气查询失败（${resp.status}），请稍后重试`;

    const data = await resp.json() as any;
    const current = data?.current_condition?.[0];
    if (!current) return `未找到 ${city} 的天气数据`;

    const cityName = data?.nearest_area?.[0]?.areaName?.[0]?.value || city;
    const weatherDesc = current.weatherDesc?.[0]?.value || "";
    const temp = current.temp_C || "";
    const feelsLike = current.FeelsLikeC || "";
    const humidity = current.humidity || "";
    const windSpeed = current.windspeedKmph || "";
    const windDir = current.winddir16Point || "";
    const visibility = current.visibility || "";
    const pressure = current.pressure || "";
    const uvIndex = current.uvIndex || "";

    // 未来预报
    const forecasts = data?.weather || [];
    const forecastLines = forecasts.slice(0, days).map((day: any) => {
      const date = day.date || "";
      const hi = day.tempMaxC || "";
      const lo = day.tempMinC || "";
      const desc = day.hourly?.[0]?.weatherDesc?.[0]?.value || "";
      // 取全天最高/最低
      const allHi = Math.max(...(day.hourly || []).map((h: any) => parseInt(h.tempC) || 0));
      const allLo = Math.min(...(day.hourly || []).filter((h: any) => h.tempC).map((h: any) => parseInt(h.tempC)));
      const maxHi = allHi > 0 ? allHi : hi;
      const minLo = allLo < 99 ? allLo : lo;
      // 取主要天气描述（取白天的，忽略夜间）
      const dayDesc = day.hourly?.filter((_: any, i: number) => i >= 2 && i <= 5).map((h: any) => h.weatherDesc?.[0]?.value).filter(Boolean).join("→") || desc;
      const windInfo = day.hourly?.[3]?.windspeedKmph ? ` ${day.hourly[3].winddir16Point || ""}${day.hourly[3].windspeedKmph}km/h` : "";
      return `${date} ${dayDesc} ${minLo}~${maxHi}°C${windInfo}`;
    }).join("\n");

    const result = `【${cityName} 实时天气】${weatherDesc}
气温: ${temp}°C（体感 ${feelsLike}°C）
湿度: ${humidity}% | 风: ${windDir} ${windSpeed}km/h
能见度: ${visibility}km | 气压: ${pressure}hPa | 紫外线: ${uvIndex}`;

    if (forecastLines.length > 0) {
      const label = days === 1 ? "今日" : `未来 ${days} 天`;
      return `${result}\n\n【${label}预报】\n${forecastLines}`;
    }
    return result;
  } catch (e: any) {
    return `天气查询失败: ${e?.message || "请求超时"}`;
  }
}

// 获取指定 URL 的网页内容（支持多种 HTTP 方法）
async function executeFetchUrl(url: string, method = "GET", body?: string): Promise<string> {
  if (!url) return "URL 不能为空";
  const httpMethod = method.toUpperCase();
  const validMethods = ["GET", "POST", "PUT", "DELETE", "PATCH"];
  if (!validMethods.includes(httpMethod)) return `不支持的 HTTP 方法: ${method}`;
  try {
    const init: RequestInit = {
      method: httpMethod,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(15000),
    };
    if (body && ["POST", "PUT", "PATCH"].includes(httpMethod)) {
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
      init.body = body;
    }
    const resp = await fetch(url, init);
    if (!resp.ok) return `访问失败 (HTTP ${resp.status})\n${(await resp.text().catch(() => "")).slice(0, 500)}`;
    const text = await resp.text();
    // 提取纯文本：去掉 HTML 标签，限制长度
    const cleaned = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#\d+;/g, "")
      .replace(/\s+/g, " ").trim();
    return `HTTP ${httpMethod} ${url} → ${resp.status}\n\n${cleaned.slice(0, 5000) || "（页面没有文本内容）"}`;
  } catch (e: any) {
    return `访问失败: ${e?.message || "请求超时"}`;
  }
}

// 用 Cloudflare Browser Run 搜索 Bing（免费版每天 10 分钟，不会被限流）
async function executeBrowserSearch(browserBinding: any, query: string): Promise<string | null> {
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const resp = await browserBinding.quickAction("content", {
    url: searchUrl,
  });
  if (!resp.ok) return null;
  const data = await resp.json() as any;
  if (!data?.success || !data?.result) return null;

  const html = data.result as string;
  const results: string[] = [];
  // 复用 cloudflare-search 的 Bing 解析正则
  const resultRegex =
    /<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g;
  let match: RegExpExecArray | null;
  while ((match = resultRegex.exec(html)) !== null) {
    let url = match[1];
    // 解码 Bing 重定向链接
    if (url.includes("bing.com/ck/a?")) {
      try {
        const decodedUrl = url.replace(/&amp;/g, "&");
        const uParam = new URL(decodedUrl).searchParams.get("u");
        if (uParam?.startsWith("a1")) {
          url = atob(uParam.slice(2));
        }
      } catch {}
    }
    const title = match[2].replace(/<[^>]+>/g, "").trim();
    const description = match[3].replace(/<[^>]+>/g, "").trim();
    if (title && url) {
      results.push(`${results.length + 1}. ${title}\n   ${url}\n   ${description}`);
      if (results.length >= 8) break;
    }
  }
  return results.length > 0 ? results.join("\n\n") : null;
}

// 用 Cloudflare Browser Run 搜索 Bing 图片（免费版每天 10 分钟）
async function executeImageSearch(browserBinding: any, query: string): Promise<string> {
  const q = (query || "").trim();
  if (!q) return "图片搜索关键词为空";
  if (!browserBinding) return "图片搜索需要浏览器搜索支持（BROWSER binding）";
  try {
    const searchUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(q)}`;
    const resp = await browserBinding.quickAction("content", {
      url: searchUrl,
    });
    if (!resp.ok) return `图片搜索失败 (HTTP ${resp.status})`;
    const data = await resp.json() as any;
    if (!data?.success || !data?.result) return "图片搜索返回空结果";

    const html = data.result as string;
    const results: string[] = [];
    // Bing 图片搜索：m 属性中的原始图片 URL（data-src 或 murl）
    const imgRe = /data-src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|gif|webp)[^"]*)"/gi;
    let m: RegExpExecArray | null;
    while ((m = imgRe.exec(html)) !== null && results.length < 6) {
      results.push(`${results.length + 1}. ${m[1]}`);
    }

    // 兜底：匹配 murl 参数中的图片 URL
    if (results.length === 0) {
      const murlRe = /murl\\?"?:\s*\\?"(https?:\/\/[^"\\]+\.(?:jpg|jpeg|png|gif|webp)[^"\\]*)"/gi;
      while ((m = murlRe.exec(html)) !== null && results.length < 6) {
        results.push(`${results.length + 1}. ${m[1]}`);
      }
    }

    if (results.length === 0) return "没有找到相关图片";
    return `搜索结果如下（浏览器搜索 Bing 图片）：\n${results.join("\n\n")}`;
  } catch (e: any) {
    return `图片搜索失败: ${e?.message || String(e)}`;
  }
}

// 获取今日热门新闻（HN 前端 RSS + Wikipedia 每日大事）
export async function executeBuiltinTool(
  toolCall: { id: string; function: { name: string; arguments: string } },
  newsnowBaseUrl?: string,
  searchBaseUrl?: string,
  searchToken?: string,
  mediaConfig?: { aiBinding: any; provider: string; model: string; baseUrl: string; apiKey: string; allKeys: string[]; maxRetries: number; responseConfig: any },
  browserBinding?: any,
  searchEngine?: string,
): Promise<MCPToolResult | null> {
  if (toolCall.function.name === "get_current_datetime") {
    const now = new Date();
    const tz = "Asia/Shanghai";
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(now);
    const get = (t: string) => parts.find(p => p.type === t)?.value || "";
    const weekdayMap: Record<string, string> = { "Sunday": "日", "Monday": "一", "Tuesday": "二", "Wednesday": "三", "Thursday": "四", "Friday": "五", "Saturday": "六" };
    const dateStr = `${get("year")}年${get("month")}月${get("day")}日`;
    const weekdayStr = weekdayMap[get("weekday")] || get("weekday");
    const timeStr = `${get("hour")}:${get("minute")}:${get("second")}`;
    return { callId: toolCall.id, name: "get_current_datetime", content: `当前日期: ${dateStr}（星期${weekdayStr}），当前时间: ${timeStr}（中国时区）` };
  }
  if (toolCall.function.name === "get_weather") {
    let args: Record<string, any> = {};
    try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch {}
    const city = (args.city || "").trim();
    if (!city) return { callId: toolCall.id, name: "get_weather", content: "请指定城市名", isError: true };
    const days = Math.min(Math.max(parseInt(args.days) || 1, 1), 3);
    const content = await executeWeatherQuery(city, days);
    return { callId: toolCall.id, name: "get_weather", content };
  }
  if (toolCall.function.name === "web_search") {
    let args: Record<string, any> = {};
    try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch {}
    const content = await executeWebSearch(args.q || "", searchBaseUrl, searchToken, browserBinding, searchEngine);
    return { callId: toolCall.id, name: "web_search", content };
  }
  if (toolCall.function.name === "search_image") {
    let args: Record<string, any> = {};
    try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch {}
    const content = await executeImageSearch(browserBinding, args.q || "");
    return { callId: toolCall.id, name: "search_image", content };
  }
  if (toolCall.function.name === "get_news") {
    let args: Record<string, any> = {};
    try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch {}
    const content = await executeNewsNow(args.source || "", newsnowBaseUrl);
    return { callId: toolCall.id, name: "get_news", content };
  }
  if (toolCall.function.name === "generate_image") {
    let args: Record<string, any> = {};
    try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch {}
    if (!mediaConfig?.aiBinding) return { callId: toolCall.id, name: "generate_image", content: "图片生成服务未配置", isError: true };
    const result = await generateImage(mediaConfig.aiBinding, args.prompt || "", mediaConfig.model, mediaConfig.provider, mediaConfig.baseUrl, mediaConfig.apiKey, undefined, args.size, mediaConfig.allKeys, mediaConfig.maxRetries, args.refImages, mediaConfig.responseConfig);
    if (result.data) {
      const dataStr = typeof result.data === "string" ? result.data : `[图片数据 ${result.data.length} 字节]`;
      return { callId: toolCall.id, name: "generate_image", content: `✅ 图片已生成\n${dataStr.slice(0, 500)}` };
    }
    return { callId: toolCall.id, name: "generate_image", content: "图片生成失败", isError: true };
  }
  if (toolCall.function.name === "generate_video") {
    let args: Record<string, any> = {};
    try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch {}
    if (!mediaConfig?.aiBinding) return { callId: toolCall.id, name: "generate_video", content: "视频生成服务未配置", isError: true };
    const result = await submitVideoTask(mediaConfig.aiBinding, args.prompt || "", mediaConfig.model, mediaConfig.provider, mediaConfig.baseUrl, mediaConfig.apiKey, undefined, undefined, undefined);
    if (result) {
      return { callId: toolCall.id, name: "generate_video", content: result.url ? `✅ 视频已生成: ${result.url}` : `✅ 视频任务已提交: ${result.taskId}` };
    }
    return { callId: toolCall.id, name: "generate_video", content: "视频生成失败", isError: true };
  }
  if (toolCall.function.name === "fetch_url") {
    let args: Record<string, any> = {};
    try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch {}
    const url = (args.url || "").trim();
    if (!url) return { callId: toolCall.id, name: "fetch_url", content: "URL 不能为空", isError: true };
    const method = (args.method || "GET").trim();
    const body = typeof args.body === "string" ? args.body.trim() : undefined;
    const content = await executeFetchUrl(url, method, body);
    return { callId: toolCall.id, name: "fetch_url", content };
  }
  return null;
}

// 获取中文新闻：调用 NewsNow 实例（默认公共实例，失败时回退 HN）
// NewsNow API: GET /api/s?id=<source>，source 如 weibo/zhihu/baidu/toutiao/thepaper/36kr/ithome/bilibili/tencent/ifeng/sspai/juejin/douyin/hupu
const NEWS_NOW_DEFAULT = "https://newsnow.busiyi.world";
async function executeNewsNow(source: string, baseUrl?: string): Promise<string> {
  const base = (baseUrl || NEWS_NOW_DEFAULT).trim().replace(/\/+$/, "");
  try {
    // 未指定源时，并行拉取几个主流中文源，选最成功的一个
    const requested = (source || "").trim();
    const sourceList = requested ? [requested] : ["weibo", "zhihu", "baidu", "toutiao", "thepaper"];
    const results = await Promise.all(
      sourceList.map(async (src) => {
        try {
          const resp = await fetch(`${base}/api/s?id=${encodeURIComponent(src)}`, {
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json, text/plain, */*",
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Referer": base + "/",
            },
            signal: AbortSignal.timeout(8000),
          });
          if (!resp.ok) return null;
          const data = await resp.json() as any;
          const items = data?.items;
          if (Array.isArray(items) && items.length > 0) {
            return { src, items: items.slice(0, 10) };
          }
          return null;
        } catch { return null; }
      })
    );
    const ok = results.filter(Boolean) as Array<{ src: string; items: any[] }>;
    if (ok.length > 0) {
      // 合并所有成功源的新闻，去重
      const seen = new Set<string>();
      const lines: string[] = [];
      let count = 0;
      for (const { src, items } of ok) {
        for (const it of items) {
          const title = it.title || "";
          if (!title || seen.has(title)) continue;
          seen.add(title);
          lines.push(`${count + 1}. [${src}] ${title}\n   ${it.url || ""}`);
          count++;
          if (count >= 15) break;
        }
        if (count >= 15) break;
      }
      if (lines.length > 0) return lines.join("\n\n");
    }
    // NewsNow 失败（如 D1 过载），回退到 HN 热门（用通用搜索词）
    if (requested) {
      return `NewsNow 暂不可用，请稍后重试`;
    }
    return "没有获取到新闻";
  } catch (e: any) {
    return `新闻获取失败: ${e?.message || String(e)}`;
  }
}

// 将工具返回的 JSON 转成自然语言，避免 AI 解析 JSON 时编造数字
export function formatToolContent(raw: string): string {
  if (!raw) return raw;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return raw;

  try {
    const obj = JSON.parse(trimmed);
    return flattenToText(obj);
  } catch {
    return raw;
  }
}

// 常见字段名翻译，让 AI 更易理解工具返回的数据
const FIELD_LABELS: Record<string, string> = {
  ledger: "账本", scope: "范围", period: "期间", income: "收入", expense: "支出",
  balance: "结余", transaction_count: "交易笔数", total: "总计", top_categories: "主要分类",
  name: "名称", items: "记录", amount: "金额", tx_type: "交易类型", happened_at: "发生时间",
  note: "备注", category_name: "分类", account_name: "账户", sync_id: "记录ID",
  date_from: "开始日期", date_to: "结束日期", category: "分类", account: "账户", q: "关键词", limit: "条数",
  items_total: "总条数", title: "标题", content: "内容", status: "状态", message: "消息",
};

// 把 JSON 对象递归展开成 "key: value" 的易读文本
function flattenToText(value: any, depth = 0): string {
  if (value === null || value === undefined) return "无";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    if (value.length === 0) return "无";
    return value.map(v => flattenToText(v, depth + 1)).join("；");
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    return entries
      .map(([k, v]) => `${FIELD_LABELS[k] || k}: ${flattenToText(v, depth + 1)}`)
      .join("；");
  }

  return String(value);
}