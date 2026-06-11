// iLink 协议集成 - 微信官方消息 API
// 参考: https://ilink.weixin.qq.com/doc/

const I_LINK_BASE = "https://ilinkai.weixin.qq.com";

export interface ILinkCredentials {
  token: string;
  accountId: string;
  userId: string;
  baseUrl: string;
  createdAt: number;
}

export interface ILinkMessage {
  msg_id: string;
  from_user_id: string;
  context_token: string;
  create_time: number;
  items: Array<{ type: number; text_item?: { text: string } }>;
}

export interface ILinkUpdatesResponse {
  ret: number;
  msgs: ILinkMessage[];
}

// 获取二维码（用于扫码登录）
export async function getQRCode(): Promise<{ key: string; imgUrl: string }> {
  const r = await fetch(`${I_LINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    headers: { "iLink-App-ClientVersion": "1" },
    cf: { cacheTtl: 0, cacheEverything: false } as any,
  });
  if (!r.ok) throw new Error(`获取二维码失败 HTTP ${r.status}`);
  return r.json() as Promise<{ key: string; imgUrl: string }>;
}

// 轮询扫码状态
export async function getQRCodeStatus(key: string): Promise<{
  status: "pending" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
}> {
  const r = await fetch(
    `${I_LINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(key)}`,
    {
      headers: { "iLink-App-ClientVersion": "1" },
      cf: { cacheTtl: 0, cacheEverything: false } as any,
    }
  );
  if (!r.ok) return { status: "pending" };
  return r.json() as Promise<any>;
}

// 获取消息更新（轮询拉取）
export async function getUpdates(
  token: string,
  baseUrl = I_LINK_BASE,
  timeoutMs = 4000
): Promise<ILinkUpdatesResponse> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${baseUrl}/ilink/bot/getupdates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "iLink-App-ClientVersion": "1",
      },
      body: JSON.stringify({ get_updates_buf: "" }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (r.status === 200) return r.json() as Promise<ILinkUpdatesResponse>;
    return { ret: r.status, msgs: [] };
  } catch {
    return { ret: -1, msgs: [] };
  }
}

// 发送文本回复
export async function sendTextMessage(
  token: string,
  toUserId: string,
  contextToken: string,
  text: string,
  baseUrl = I_LINK_BASE
): Promise<{ ret: number }> {
  try {
    const r = await fetch(`${baseUrl}/ilink/bot/sendmessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "iLink-App-ClientVersion": "1",
      },
      body: JSON.stringify({
        msg: {
          to_user_id: toUserId,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text } }],
        },
      }),
    });
    if (r.status === 200) return r.json() as Promise<{ ret: number }>;
    return { ret: r.status };
  } catch {
    return { ret: -1 };
  }
}

// 从消息中提取文本
export function extractMessageText(msg: ILinkMessage): string {
  const parts: string[] = [];
  for (const it of msg.items || []) {
    if (it.type === 1 && it.text_item?.text) {
      parts.push(it.text_item.text);
    }
  }
  return parts.join("\n").trim();
}
