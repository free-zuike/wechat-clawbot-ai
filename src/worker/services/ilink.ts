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
  console.log("[ilink] fetching QR code...");
  const r = await fetch(`${I_LINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    headers: { "iLink-App-ClientVersion": "1" },
    cf: { cacheTtl: 0, cacheEverything: false } as any,
  });
  console.log("[ilink] QR code response status:", r.status);
  if (!r.ok) {
    const text = await r.text();
    console.error("[ilink] QR code fetch failed:", text);
    throw new Error(`获取二维码失败 HTTP ${r.status}`);
  }
  const data = await r.json();
  console.log("[ilink] QR code response data:", JSON.stringify(data));
  
  const key = data?.key || data?.qrcode;
  let imgUrl = data?.imgUrl || data?.qrcode_img_content;
  
  if (typeof imgUrl === "string") {
    imgUrl = imgUrl.trim().replace(/^`+|`+$/g, "").trim();
  }
  
  if (!key || !imgUrl) {
    throw new Error(`获取二维码失败: 返回数据无效 (${JSON.stringify(data)})`);
  }
  
  console.log("[ilink] QR code key:", key);
  console.log("[ilink] QR code imgUrl:", imgUrl);
  return { key, imgUrl };
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
  const data = await r.json();
  console.log("[ilink] qrcode status raw response:", JSON.stringify(data));
  
  const status = data?.status || data?.ret;
  const token = data?.bot_token || data?.token;
  
  if (status === "confirmed" || status === 1 || (token && status !== "expired")) {
    return {
      status: "confirmed",
      bot_token: token,
      ilink_bot_id: data?.ilink_bot_id || data?.bot_id,
      ilink_user_id: data?.ilink_user_id || data?.user_id,
      baseurl: data?.baseurl || data?.base_url,
    };
  }
  if (status === "scaned" || status === "scanned" || status === 2) {
    return { status: "scaned" };
  }
  if (status === "expired" || status === 4) {
    return { status: "expired" };
  }
  return { status: "pending" };
}

// 获取消息更新（轮询拉取）
export async function getUpdates(
  token: string,
  baseUrl = I_LINK_BASE,
  timeoutMs = 4000
): Promise<ILinkUpdatesResponse> {
  console.log("[ilink] getUpdates called, baseUrl:", baseUrl);
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
    console.log("[ilink] getUpdates status:", r.status);
    const text = await r.text();
    console.log("[ilink] getUpdates response:", text.slice(0, 500));
    if (r.status === 200) {
      try {
        return JSON.parse(text) as ILinkUpdatesResponse;
      } catch (e) {
        console.error("[ilink] getUpdates JSON parse error:", e);
        return { ret: r.status, msgs: [] };
      }
    }
    return { ret: r.status, msgs: [] };
  } catch (e: any) {
    console.error("[ilink] getUpdates error:", e);
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
  console.log("[ilink] sendTextMessage to:", toUserId, "text:", text.slice(0, 100));
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
    console.log("[ilink] sendTextMessage status:", r.status);
    const textResp = await r.text();
    console.log("[ilink] sendTextMessage response:", textResp.slice(0, 300));
    if (r.status === 200) {
      try {
        return JSON.parse(textResp) as { ret: number };
      } catch {
        return { ret: r.status };
      }
    }
    return { ret: r.status };
  } catch (e: any) {
    console.error("[ilink] sendTextMessage error:", e);
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
