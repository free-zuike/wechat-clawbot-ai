// AI 服务 - 纯函数工具与常量
// 从 ai.ts 拆出：无副作用、无 AI 调用依赖的通用工具

// 从 API baseUrl 中提取 base 和 version，用于构建其他端点
// 例: "https://open.bigmodel.cn/api/paas/v4/chat/completions"
//   → { base: "https://open.bigmodel.cn/api/paas", version: "v4" }
export function parseApiUrl(baseUrl: string): { base: string; version: string } {
  const url = baseUrl.trim().replace(/\/+$/, "");
  const match = url.match(/(.*?)\/(v\d+)\/(chat\/completions|images\/generations|videos?)\/?$/i);
  if (match) {
    return { base: match[1], version: match[2] };
  }
  const vMatch = url.match(/(.*?)\/(v\d+)\/?$/);
  if (vMatch) {
    return { base: vMatch[1], version: vMatch[2] };
  }
  return { base: url, version: "v1" };
}

export const TOOL_HONESTY_RULE =
  "【重要规则】当用户请求需要调用工具来完成操作（查询数据、修改配置、发送消息、创建定时任务等）时，必须实际调用对应工具。" +
  "只有在工具调用成功且返回成功结果时，才能声称操作已完成。\n" +
  "如果出现以下任一情况：1) 没有可用的工具；2) 工具调用失败或返回错误；3) 工具返回数据不完整——" +
  "都必须如实告诉用户，说明具体原因或错误信息，绝不能编造成功的结果、数据或『已启用/已修改/已发送』之类的假确认。";

export const DEFAULT_SYSTEM_PROMPT =
  "你是爪爪（ClawBot AI），一个微信机器人助手。" +
  "你的性格友好、简洁、幽默，回答要符合微信阅读习惯，段落清晰，语气亲切。" +
  "始终使用中文回答，不要使用英文。" +
  "如果用户问的问题你不知道，就直接说不知道。不要编造信息。" +
  "【重要规则】当你有工具返回的数据时，必须严格按工具返回的实际数值来回答。不要编造、夸大或缩小任何数字。" +
  "如果工具返回的数据中包含总金额、交易笔数、分类等统计信息，直接引用原文，不要自己计算或推断。" +
  "【重要规则】天气查询时，只回答工具返回的城市，不要擅自添加其他城市的数据。如果用户问的是「大同」，不要编造北京、上海等任何其他城市的信息。" +
  TOOL_HONESTY_RULE;

const QUICK_REPLIES: Record<string, string> = {
  "你好": "你好呀 👋 我是爪爪 AI，有什么能帮你的吗？",
  "你好啊": "你好呀 👋 我是爪爪 AI，有什么能帮你的吗？",
  "在吗": "在的 👋 有什么能帮你的？",
  "早上好": "早上好 ☀️ 新的一天，有什么需要帮你查的吗？",
  "晚上好": "晚上好 🌙 这么晚还没睡？有什么能帮你的？",
  "谢谢": "不客气 😊",
  "感谢": "应该的，不客气～",
  "再见": "再见！需要的时候再回来找我 👋",
  "拜拜": "拜拜 👋",
  "你是谁": "我是爪爪 ClawBot AI —— 个人微信机器人。",
  "版本": "爪爪 ClawBot AI v2.0",
  "帮助": "我可以帮你：\n1. 回答问题\n2. 陪你聊天\n3. 写文本草稿\n4. 中英互译\n\n直接发送你想问的问题即可。",
};

const COMMANDS: Record<string, string> = {
  "/help": "📖 使用指南\n- 直接发送问题，AI 会回复\n- '重置' 清空对话上下文\n- '关于' 查看机器人信息",
  "/clear": "✅ 已清空对话上下文，我们重新开始吧。",
  "/reset": "✅ 已重置对话，我们重新开始吧。",
  "/about": "🦞 爪爪 ClawBot AI v2.0\n基于 Cloudflare Workers 构建",
};

export function tryQuickReply(text: string): string | null {
  const clean = text.trim().toLowerCase();
  if (COMMANDS[clean]) return COMMANDS[clean];
  if (QUICK_REPLIES[clean]) return QUICK_REPLIES[clean];
  return null;
}

// 检测模糊回指：用户用简短短语指代上一条回复中的内容
// 如"列出来"、"展开说说"、"是哪一条"等，不依赖 AI 模型理解上下文
export function isVagueFollowUp(text: string): boolean {
  const clean = text.trim().toLowerCase();
  if (clean.length > 20) return false;
  const vaguePatterns = [
    "列出来", "列一下", "列", "展开", "具体", "详细", "说说",
    "是哪", "哪个", "哪条", "这条", "那个", "上一条", "还有呢", "然后呢",
    "继续", "接着", "所以", "什么意思", "为什么",
    "给我看", "看看", "看看详情", "具体内容",
  ];
  if (vaguePatterns.some(p => clean.includes(p))) return true;
  // 通用序数回指：第X条/第X个（X 为数字或中文数字）
  return /第[一二三四五六七八九十百\d]+[条个]/.test(clean);
}

// 过滤内置工具列表：只在对应外部服务已配置时保留工具
// 当前规则：web_search 已有内置兜底搜索源，始终可用
export function filterBuiltinTools(
  builtinTools: Array<{ type: string; function: { name: string; [key: string]: any } }>,
  searchBaseUrl?: string,
  extraTools?: any[],
): any[] {
  return [...builtinTools, ...(extraTools || [])];
}

// 获取当前日期时间字符串（中国时区 Asia/Shanghai），通用辅助函数
export function getCurrentTimeStr(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", weekday: "long", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value || "";
  const weekdayMap: Record<string, string> = { "Sunday": "日", "Monday": "一", "Tuesday": "二", "Wednesday": "三", "Thursday": "四", "Friday": "五", "Saturday": "六" };
  return `${get("year")}年${get("month")}月${get("day")}日 ${get("hour")}:${get("minute")}:${get("second")}（星期${weekdayMap[get("weekday")] || get("weekday")}，中国时区）`;
}