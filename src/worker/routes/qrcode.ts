import { json, verifyAdmin } from "../utils";
import { getQRCode, getQRCodeStatus } from "../services/ilink";
import type { Env } from "../index";

// 1. 获取二维码
export async function handleQRCode(request: Request, env: Env): Promise<Response> {
  const v = verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);
  try {
    const data = await getQRCode();
    // 保存 key 到 KV，5 分钟过期
    await env.CLAWBOT_KV.put("clawbot:qrcode_key", data.key, {
      expirationTtl: 5 * 60,
    });
    
    // 如果 imgUrl 是 HTTP URL，代理获取并转换为 base64（避免 CORS）
    let imgContent = data.imgUrl;
    if (data.imgUrl.startsWith("http")) {
      const imgRes = await fetch(data.imgUrl);
      if (imgRes.ok) {
        const buffer = await imgRes.arrayBuffer();
        imgContent = Buffer.from(buffer).toString("base64");
      }
    }
    
    return json({ qrcode: data.key, qrcode_img_content: imgContent });
  } catch (e: any) {
    return json({ error: String(e) }, 500);
  }
}

// 2. 轮询扫码状态
export async function handleQRCodeStatus(request: Request, env: Env): Promise<Response> {
  const v = verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);
  try {
    const url = new URL(request.url);
    const key =
      (await env.CLAWBOT_KV.get("clawbot:qrcode_key")) ||
      url.searchParams.get("qrcode") ||
      "";
    if (!key) return json({ status: "unknown" });
    const status = await getQRCodeStatus(key);
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
      return json({ status: "confirmed", ok: true });
    }
    return json(status);
  } catch (e: any) {
    return json({ error: String(e) }, 500);
  }
}
