import { json, verifyAdmin } from "../utils";
import { getQRCode, getQRCodeStatus } from "../services/ilink";
import type { Env } from "../index";

// 1. 获取二维码
export async function handleQRCode(request: Request, env: Env): Promise<Response> {
  const v = verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);
  try {
    const data = await getQRCode();
    // 保存 key 和图片 URL 到 KV，5 分钟过期
    await env.CLAWBOT_KV.put("clawbot:qrcode_key", data.key, {
      expirationTtl: 5 * 60,
    });
    if (data.imgUrl.startsWith("http")) {
      await env.CLAWBOT_KV.put("clawbot:qrcode_img_url", data.imgUrl, {
        expirationTtl: 5 * 60,
      });
    }
    
    return json({ qrcode: data.key, qrcode_img_content: "/api/qrcode-image" });
  } catch (e: any) {
    return json({ error: String(e) }, 500);
  }
}

// 2. 图片代理（避免 CORS）
export async function handleQRCodeImage(request: Request, env: Env): Promise<Response> {
  try {
    const imgUrl = await env.CLAWBOT_KV.get("clawbot:qrcode_img_url");
    if (!imgUrl) {
      return new Response("图片未找到", { status: 404 });
    }
    const imgRes = await fetch(imgUrl);
    if (!imgRes.ok) {
      return new Response("图片获取失败", { status: imgRes.status });
    }
    // 获取原始 Content-Type，默认为 image/png
    const contentType = imgRes.headers.get("Content-Type") || "image/png";
    return new Response(imgRes.body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Expires": "0",
        "Pragma": "no-cache",
      },
    });
  } catch (e: any) {
    console.error("[qrcode-image] error:", e);
    return new Response(String(e), { status: 500 });
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
