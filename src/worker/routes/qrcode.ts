// 二维码路由 - 获取登录二维码 + 轮询扫码状态

import { json, verifyAdmin, generateSessionToken, createSessionCookie } from "../utils";
import { Logger } from "../utils/error";
import { fetchQRCode, getQRCodeStatus } from "../services/ilink";
import type { Env } from "../index";

// 1. 获取二维码
export async function handleQRCode(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  Logger.info("[qrcode] fetching QR code");
  try {
    const data = await fetchQRCode();

    // 存储 qrcode_key 到 KV（TTL 5 分钟）
    await env.CLAWBOT_KV.put("clawbot:qrcode_key", data.qrcode, { expirationTtl: 5 * 60 });

    // 触发 DO 开始轮询 QR 码状态（后台每3秒调 iLink API）
    // 不 await，fire-and-forget，避免阻塞 Worker
    const doId = env.ILINK_CONNECTION.idFromName("main");
    const doStub = env.ILINK_CONNECTION.get(doId);
    doStub.fetch(new Request(`http://localhost/qr-poll?qrcode=${data.qrcode}`)).catch((e: any) => {
      Logger.warn("[qrcode] DO QR poll trigger failed", { error: e.message });
    });

    Logger.info("[qrcode] obtained", { hasUrl: !!data.qrcode_img_content });
    return json({ qrcode: data.qrcode, qrcode_url: data.qrcode_img_content });
  } catch (e: any) {
    Logger.error("[qrcode] error", { error: e?.message || String(e) });
    return json({ error: String(e) }, 500);
  }
}

// 2. 轮询扫码状态
export async function handleQRCodeStatus(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);

    // 从 KV 读取 qrcode_key
    let key = await env.CLAWBOT_KV.get("clawbot:qrcode_key");
    if (!key) {
      key = url.searchParams.get("qrcode") || undefined;
    }
    if (!key) return json({ status: "unknown" });

    const status = await getQRCodeStatus(key);
    Logger.info("[qrcode-status] poll", { status: status.status });

    if (status.status === "confirmed" && status.bot_token && status.ilink_bot_id) {
      const baseUrl = status.baseurl || "https://ilinkai.weixin.qq.com";

      // 保存凭证
      const creds = {
        botToken: status.bot_token,
        accountId: status.ilink_bot_id,
        userId: status.ilink_user_id,
        baseUrl,
        syncBuf: "",
        rawLoginResponse: status.raw,
        createdAt: Date.now(),
      };

      await env.CLAWBOT_KV.put("clawbot:credentials", JSON.stringify(creds));

      // 触发 DO
      try {
        const doId = env.ILINK_CONNECTION.idFromName("main");
        const doStub = env.ILINK_CONNECTION.get(doId);
        await doStub.fetch(new Request("http://localhost/poll"));
        Logger.info("[qrcode-status] DO triggered successfully");
      } catch (e: any) {
        Logger.warn("[qrcode-status] DO trigger failed (will retry on next cron)", { error: e.message });
      }

      // session cookie 存储到 KV（TTL 24 小时）
      const sessionToken = generateSessionToken();
      await env.CLAWBOT_KV.put(`clawbot:session:${sessionToken}`, "valid", { expirationTtl: 24 * 60 * 60 });

      // 删除 qrcode_key
      await env.CLAWBOT_KV.delete("clawbot:qrcode_key");

      Logger.info("[qrcode-status] login confirmed", { accountId: status.ilink_bot_id });

      return json({ status: "confirmed", ok: true, accountId: status.ilink_bot_id }, 200, {
        "Set-Cookie": createSessionCookie(sessionToken),
      });
    }

    return json({ status: status.status });
  } catch (e: any) {
    Logger.error("[qrcode-status] error", { error: e?.message || String(e) });
    return json({ error: String(e) }, 500);
  }
}
