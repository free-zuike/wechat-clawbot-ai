import { json, verifyAdmin, generateSessionToken, createSessionCookie } from "../utils";
import { fetchQRCode, getQRCodeStatus } from "../services/ilink";
import type { Env } from "../index";

// 1. 获取二维码
export async function handleQRCode(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);
  try {
    const data = await fetchQRCode();
    await env.CLAWBOT_KV.put("clawbot:qrcode_key", data.qrcode, { expirationTtl: 5 * 60 });
    return json({ qrcode: data.qrcode, qrcode_url: data.qrcode_img_content });
  } catch (e: any) {
    return json({ error: String(e) }, 500);
  }
}

// 2. 轮询扫码状态
export async function handleQRCodeStatus(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const key = (await env.CLAWBOT_KV.get("clawbot:qrcode_key")) || url.searchParams.get("qrcode") || "";
    if (!key) return json({ status: "unknown" });
    const status = await getQRCodeStatus(key);
    
    // 调试日志
    console.log("[qrcode-status] key:", key, "status:", JSON.stringify(status));

    if (status.status === "confirmed" && status.bot_token && status.ilink_bot_id) {
      const baseUrl = status.baseurl || "https://ilinkai.weixin.qq.com";

      // 保存凭证（标准 ILinkCredentials 结构）
      const creds = {
        botToken: status.bot_token,
        accountId: status.ilink_bot_id,
        userId: status.ilink_user_id,
        baseUrl,
        // 消息游标 - 用于断点续传
        syncBuf: "",
        // 原始响应 - 用于调试
        rawLoginResponse: status.raw,
        createdAt: Date.now(),
      };
      await env.CLAWBOT_KV.put("clawbot:credentials", JSON.stringify(creds));

      // session cookie (用于前端面板鉴权)
      const sessionToken = generateSessionToken();
      await env.CLAWBOT_KV.put(`clawbot:session:${sessionToken}`, "valid", { expirationTtl: 24 * 60 * 60 });
      await env.CLAWBOT_KV.delete("clawbot:qrcode_key");

      return json({ status: "confirmed", ok: true, accountId: status.ilink_bot_id }, 200, {
        "Set-Cookie": createSessionCookie(sessionToken),
      });
    }

    return json({ status: status.status });
  } catch (e: any) {
    return json({ error: String(e) }, 500);
  }
}
