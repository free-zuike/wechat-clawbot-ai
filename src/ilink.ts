// ======================================================================
//  iLink 协议（微信 ClawBot）核心客户端 —— Cloudflare Worker 版
// ----------------------------------------------------------------------
//  参考: @tencent-weixin/openclaw-weixin 官方插件源码
//  API 基址: https://ilinkai.weixin.qq.com
// ======================================================================

export const I_LINK_BASE = "https://ilinkai.weixin.qq.com";
export const BOT_TYPE = "3";

// ---------------------- 类型定义 ----------------------

export interface QRCodeResponse {
  ret: number;
  qrcode: string;
  qrcode_img_content: string;
}

export interface QRCodeStatus {
  ret: number;
  status: "wait" | "scaned" | "expired" | "confirmed" | string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  errmsg?: string;
}

export interface WechatMessageItem {
  type: number; // 1=text
  text_item?: { text: string };
  image_item?: {
    resource_url?: string;
    thumb_url?: string;
  };
  file_item?: {
    name?: string;
    resource_url?: string;
    size?: number;
  };
  sys_item?: { content?: string };
}

export interface WechatMessage {
  msg_id: string;
  from_user_id: string; // 发送者 openid / user id
  to_user_id: string;   // 机器人 id
  create_time: number;
  msg_type: number;     // 一般 1
  context_token: string;
  item_list: WechatMessageItem[];
  session_info?: { session_id?: string };
}

export interface GetUpdatesResponse {
  ret: number;
  errcode?: number;
  errmsg?: string;
  msgs: WechatMessage[];
  get_updates_buf: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageRequest {
  msg: {
    to_user_id: string;
    context_token: string;
    item_list: {
      type: number;
      text_item?: { text: string };
    }[];
  };
}

export interface SendMessageResponse {
  ret: number;
  errcode?: number;
  errmsg?: string;
}

export interface LoginCredentials {
  token: string;
  accountId: string;
  userId: string;
  baseUrl: string;
  createdAt: number;
}

// ---------------------- 工具函数 ----------------------

function randomUint32Base64(): string {
  // 生成随机 uint32 并做 base64
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  let n = 0;
  for (let i = 0; i < 4; i++) n = (n * 256) + buf[i];
  // 注意: uint32 超出 JS 安全整数(> 2^53-1)不会发生在 32 位,所以直接处理
  const strN = n.toString();
  // base64 encode string
  const bytes = new TextEncoder().encode(strN);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomUint32Base64(),
    "iLink-App-ClientVersion": "1",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// 带 1 次重试的 fetch —— 防止网络抖动导致整轮拉取失败
async function fetchOnce(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs = 5000,
  tries = 2
): Promise<Response> {
  let lastErr: unknown = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchOnce(url, init, timeoutMs);
      // 5xx 才重试，其他状态码返回给上层处理
      if (r.status >= 500 && i < tries - 1) continue;
      return r;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  // 全部失败 —— 抛出，由调用方兜底
  throw lastErr instanceof Error ? lastErr : new Error("fetch failed");
}

// ---------------------- 扫码登录 ----------------------

export async function getQRCode(): Promise<{ key: string; imgUrl: string }> {
  const url = `${I_LINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  const r = await fetch(url, {
    method: "GET",
    headers: { "iLink-App-ClientVersion": "1" },
    // 避免 Cloudflare 缓存
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!r.ok) throw new Error(`获取二维码失败 HTTP ${r.status}`);
  const data = (await r.json()) as QRCodeResponse;
  if (data.ret !== 0) throw new Error(`获取二维码失败 ret=${data.ret}`);
  return { key: data.qrcode, imgUrl: data.qrcode_img_content };
}

export async function getQRCodeStatus(
  qrCodeKey: string
): Promise<QRCodeStatus> {
  const url = `${I_LINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(
    qrCodeKey
  )}`;
  const r = await fetch(url, {
    method: "GET",
    headers: { "iLink-App-ClientVersion": "1" },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!r.ok) return { ret: r.status, status: "wait" };
  return (await r.json()) as QRCodeStatus;
}

// ---------------------- 消息接收 ----------------------

// Worker on free tier has strict wall-clock limits (~30s max per request).
// 把 getUpdates 轮询时间从默认 25s 降到 4s —— cron 每分钟都会跑,
// 不需要在单次请求里长时间等待。
export async function getUpdates(
  token: string,
  buf: string = "",
  baseUrl = I_LINK_BASE,
  timeoutMs = 4000
): Promise<GetUpdatesResponse> {
  const url = `${baseUrl}/ilink/bot/getupdates`;
  try {
    const r = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: buildHeaders(token),
        body: JSON.stringify({ get_updates_buf: buf }),
      },
      timeoutMs,
      2
    );
    if (r.status === 200) {
      const data = (await r.json()) as GetUpdatesResponse;
      return data || { ret: 0, msgs: [], get_updates_buf: buf };
    }
    return { ret: r.status, msgs: [], get_updates_buf: buf };
  } catch (e) {
    return { ret: -1, msgs: [], get_updates_buf: buf };
  }
}

// ---------------------- 消息发送 ----------------------

// ---------------------- 微信文本格式化 ----------------------
// 把 markdown / AI 输出转成微信易读文本：
//   - 折叠 3+ 连续换行为双换行
//   - 去掉 ``` 代码块标记，改为 "--- code ---" 分隔线
//   - 去掉表格、HTML 标签
//   - [text](url) → text (url)
//   - **粗体** → 『粗体』
//   - *斜体* / _斜体_ → 保留文字
//   - # 标题 → 【标题】
//   - 开头数字列表 → 简化
//   - 末尾空白行删除
//   - 去掉行尾多余空格
function wechatifyText(src: string): string {
  if (!src) return "";
  let s = src;

  // 1. 代码块：用分隔线 + 保留内容
  s = s.replace(/```(?:[a-zA-Z0-9_+\-]*)\n?([\s\S]*?)```/g, (_, code) => {
    const trimmed = String(code).trim();
    if (!trimmed) return "";
    // 如果代码很短，内联；否则用分隔线包起来
    if (trimmed.length <= 120 && !trimmed.includes("\n")) {
      return `\n『${trimmed}』\n`;
    }
    const lines = trimmed.split("\n").slice(0, 30).join("\n");
    return `\n— — — code — — —\n${lines}\n— — — — — — — —\n`;
  });

  // 2. 表格（以 |...| 行 + --- 分隔）整段移除
  s = s.replace(/(?:^|\n)\|(?:.|\n)*?\|\n?/g, (block) => {
    // 只在看起来是表格时才删除：至少两行都是以 | 开头且含 |，中间一行有 ---
    const rows = block.trim().split("\n");
    const hasSep = rows.some((r) => /^\s*\|?\s*-{2,}/.test(r));
    const allStartPipe = rows.every((r) => r.trim().startsWith("|"));
    return hasSep && allStartPipe ? "\n（表格略）\n" : block;
  });

  // 3. 内联格式：粗体 / 斜体 / 标题 / 链接
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 （$2）");
  s = s.replace(/\*\*([^*]+)\*\*/g, "『$1』");
  s = s.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?;:])/g, "$1$2");
  s = s.replace(/_([^_\n]+)_/g, "$1");
  s = s.replace(/^#{1,6}\s*([^\n]+)/gm, "【$1】");

  // 4. HTML <tag>...</tag>（简单去 tag 保留文字）
  s = s.replace(/<[^>]+>/g, "");

  // 5. 行尾空白、连续空白行
  s = s.replace(/[ \t]+$/gm, "");
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

export async function sendMessage(
  token: string,
  payload: SendMessageRequest,
  baseUrl = I_LINK_BASE
): Promise<SendMessageResponse> {
  const url = `${baseUrl}/ilink/bot/sendmessage`;
  try {
    const r = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: buildHeaders(token),
        body: JSON.stringify(payload),
      },
      5000,
      2
    );
    if (r.status === 200) {
      const data = (await r.json()) as SendMessageResponse;
      return data || { ret: 0 };
    }
    return { ret: r.status, errmsg: `HTTP ${r.status}` };
  } catch (e) {
    return { ret: -1, errmsg: String(e) };
  }
}

// ---------------------- 便捷 reply 封装 ----------------------
// 微信单条消息上限约 2000 字；为避免触发分块, 我们硬上限 800 字 + 智能分段
const SOFT_TEXT_LIMIT = 800;
const HARD_TEXT_LIMIT = 1800;

export async function replyText(
  token: string,
  toUserId: string,
  contextToken: string,
  text: string,
  baseUrl = I_LINK_BASE
): Promise<SendMessageResponse> {
  // 先把 AI 输出（markdown / 表格 / 代码块）转成微信可读样式
  let safe = wechatifyText(text || "");

  // 长度归一: 超过 HARD_LIMIT 时在句末截断
  if (safe.length > HARD_TEXT_LIMIT) {
    const cut = safe.slice(0, HARD_TEXT_LIMIT);
    const lastNl = cut.lastIndexOf("\n");
    const lastPeriod = Math.max(
      cut.lastIndexOf("。"),
      cut.lastIndexOf("."),
      cut.lastIndexOf("！"),
      cut.lastIndexOf("!"),
      cut.lastIndexOf("？"),
      cut.lastIndexOf("?")
    );
    const endAt = Math.max(lastNl, lastPeriod, HARD_TEXT_LIMIT - 40);
    safe = cut.slice(0, endAt).trimEnd() + "\n…";
  }

  // 按 SOFT_LIMIT 分段，过长内容拆成多条消息
  const chunks: string[] = [];
  if (safe.length <= SOFT_TEXT_LIMIT) {
    chunks.push(safe);
  } else {
    // 按换行先拆成"段", 再按段合并不超限
    let cur = "";
    const segments = safe.split(/\n/);
    for (const seg of segments) {
      if ((cur + "\n" + seg).trim().length > SOFT_TEXT_LIMIT) {
        if (cur) chunks.push(cur.trim());
        cur = seg;
      } else {
        cur = cur ? cur + "\n" + seg : seg;
      }
    }
    if (cur) chunks.push(cur.trim());
  }

  // 3) 分条发送 —— 第一条带 [1/N], 最后一条关掉 typing
  let last: SendMessageResponse = { ret: 0 };
  for (let i = 0; i < chunks.length; i++) {
    const prefixed =
      chunks.length > 1 ? `[${i + 1}/${chunks.length}] ${chunks[i]}` : chunks[i];
    last = await sendMessage(
      token,
      {
        msg: {
          to_user_id: toUserId,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text: prefixed } }],
        },
      },
      baseUrl
    );
    // 非最后一条中间隔一点, 最后一条不 sleep
    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 180));
    }
  }

  // 4) 发送完成后自动发 "typing off" —— 不阻塞
  sendTyping(token, toUserId, false, baseUrl).catch(() => {});
  return last;
}

// ---------------------- 输入状态 ----------------------

export async function sendTyping(
  token: string,
  toUserId: string,
  typing = true,
  baseUrl = I_LINK_BASE
): Promise<SendMessageResponse> {
  const url = `${baseUrl}/ilink/bot/sendtyping`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify({
        to_user_id: toUserId,
        is_typing: typing ? 1 : 0,
      }),
    });
    if (r.status === 200) {
      const data = (await r.json()) as SendMessageResponse;
      return data || { ret: 0 };
    }
    return { ret: r.status };
  } catch {
    return { ret: -1 };
  }
}

// ---------------------- 消息提取 ----------------------

export function extractText(msg: WechatMessage): string {
  const parts: string[] = [];
  for (const it of msg.item_list || []) {
    if (it.type === 1 && it.text_item?.text) parts.push(it.text_item.text);
    else if (it.image_item) parts.push("[图片]");
    else if (it.file_item) parts.push(`[文件: ${it.file_item.name || "未知"}]`);
    else if (it.sys_item?.content) parts.push(`[系统: ${it.sys_item.content}]`);
  }
  return parts.join("\n").trim();
}
