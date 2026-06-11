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
    
    // 代理获取图片并转换为 base64
    if (data.imgUrl.startsWith("http")) {
      try {
        const imgRes = await fetch(data.imgUrl);
        if (imgRes.ok) {
          const buffer = await imgRes.arrayBuffer();
          const base64 = arrayBufferToBase64(buffer);
          const contentType = imgRes.headers.get("Content-Type") || "image/png";
          const dataUrl = `data:${contentType};base64,${base64}`;
          return json({ qrcode: data.key, qrcode_img_content: dataUrl });
        }
      } catch (e) {
        console.error("[qrcode] proxy image error:", e);
      }
    }
    
    // 失败则返回原始 URL（浏览器可能无法显示，但至少能返回）
    return json({ qrcode: data.key, qrcode_img_content: data.imgUrl });
  } catch (e: any) {
    return json({ error: String(e) }, 500);
  }
}

// ArrayBuffer 转 Base64（Workers 环境兼容）
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const len = bytes.length;
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  
  for (let i = 0; i < len; i += 3) {
    const b1 = bytes[i];
    const b2 = bytes[i + 1] || 0;
    const b3 = bytes[i + 2] || 0;
    
    const c1 = (b1 >> 2) & 0x3F;
    const c2 = ((b1 & 0x03) << 4) | ((b2 >> 4) & 0x0F);
    const c3 = ((b2 & 0x0F) << 2) | ((b3 >> 6) & 0x03);
    const c4 = b3 & 0x3F;
    
    result += chars[c1] + chars[c2] + chars[c3] + chars[c4];
  }
  
  const padding = len % 3;
  if (padding === 1) {
    result = result.slice(0, -2) + "==";
  } else if (padding === 2) {
    result = result.slice(0, -1) + "=";
  }
  
  return result;
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
