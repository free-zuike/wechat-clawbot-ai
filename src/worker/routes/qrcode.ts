import { json, verifyAdmin } from "../utils";
import { getQRCode, getQRCodeStatus } from "../services/ilink";
import type { Env } from "../index";

// 1. 获取二维码
export async function handleQRCode(request: Request, env: Env): Promise<Response> {
  const v = verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);
  try {
    const data = await getQRCode();
    await env.CLAWBOT_KV.put("clawbot:qrcode_key", data.key, {
      expirationTtl: 5 * 60,
    });
    return json({ qrcode: data.key });
  } catch (e: any) {
    return json({ error: String(e) }, 500);
  }
}

// 3. 轮询扫码状态
export async function handleQRCodeStatus(request: Request, env: Env): Promise<Response> {
  const v = verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);
  try {
    const url = new URL(request.url);
    const key =
      (await env.CLAWBOT_KV.get("clawbot:qrcode_key")) ||
      url.searchParams.get("qrcode") ||
      "";
    console.log("[qrcode-status] checking status for key:", key);
    if (!key) {
      console.log("[qrcode-status] no qrcode key found");
      return json({ status: "unknown" });
    }
    const status = await getQRCodeStatus(key);
    console.log("[qrcode-status] received status:", JSON.stringify(status));
    
    if (status.status === "confirmed" && status.bot_token) {
      const creds = {
        token: status.bot_token,
        accountId: status.ilink_bot_id || "",
        userId: status.ilink_user_id || "",
        baseUrl: status.baseurl || "https://ilinkai.weixin.qq.com",
        createdAt: Date.now(),
      };
      await env.CLAWBOT_KV.put("clawbot:credentials", JSON.stringify(creds));
      await env.CLAWBOT_KV.delete("clawbot:qrcode_key");
      console.log("[qrcode-status] login confirmed, credentials saved");
      return json({ status: "confirmed", ok: true });
    }
    
    return json(status);
  } catch (e: any) {
    console.error("[qrcode-status] error:", e);
    return json({ error: String(e) }, 500);
  }
}
