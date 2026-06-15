// 二维码路由 - 只用 DO 存凭证

import { json, verifyAdmin, generateSessionToken, createSessionCookie } from "../utils";
import { Logger } from "../utils/error";
import { fetchQRCode, getQRCodeStatus } from "../services/ilink";
import type { Env } from "../index";

export async function handleQRCode(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  Logger.info("[qrcode] fetching QR code");
  try {
    const data = await fetchQRCode();
    Logger.info("[qrcode] obtained", { hasUrl: !!data.qrcode_img_content });
    return json({ qrcode: data.qrcode, qrcode_url: data.qrcode_img_content });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    Logger.error("[qrcode] error", { error: msg });
    return json({ error: msg }, 500);
  }
}

export async function handleQRCodeStatus(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);

    let key = url.searchParams.get("qrcode") || undefined;
    if (!key) {
      return json({ status: "unknown" });
    }

    const status = await getQRCodeStatus(key);
    Logger.info("[qrcode-status] poll", { status: status.status });

    if (status.status === "confirmed" && status.bot_token && status.ilink_bot_id) {
      const creds = {
        botToken: status.bot_token,
        accountId: status.ilink_bot_id,
        userId: status.ilink_user_id,
        baseUrl: status.baseurl || "https://ilinkai.weixin.qq.com",
        syncBuf: "",
        rawLoginResponse: status.raw,
        createdAt: Date.now(),
      };

      // 凭证只存 DO
      try {
        const doId = env.ILINK_CONNECTION.idFromName("main");
        const doStub = env.ILINK_CONNECTION.get(doId);
        await doStub.fetch(new Request("http://localhost/save-creds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(creds),
        }));
      } catch (e: unknown) {
        Logger.error("[qrcode-status] DO save-creds failed", { error: (e as Error).message });
      }

      // 触发 DO 启动轮询
      const doId = env.ILINK_CONNECTION.idFromName("main");
      const doStub = env.ILINK_CONNECTION.get(doId);
      doStub.fetch(new Request("http://localhost/poll")).catch(() => {});

      // 生成并存储 admin session（与 bot_token 完全独立）
      const sessionToken = generateSessionToken();
      try {
        await env.CLAWBOT_KV.put(`clawbot:session:${sessionToken}`, "valid", { expirationTtl: 24 * 60 * 60 });
      } catch (_e) {}

      Logger.info("[qrcode-status] login confirmed", { accountId: status.ilink_bot_id });

      return json({ status: "confirmed", ok: true, accountId: status.ilink_bot_id }, 200, {
        "Set-Cookie": createSessionCookie(sessionToken),
      });
    }

    return json({ status: status.status });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    Logger.error("[qrcode-status] error", { error: msg });
    return json({ error: msg }, 500);
  }
}

export async function handleUnbindWechat(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    const doId = env.ILINK_CONNECTION.idFromName("main");
    const doStub = env.ILINK_CONNECTION.get(doId);
    await doStub.fetch(new Request("http://localhost/clear-creds", { method: "POST" }));
    Logger.info("[unbind] WeChat unbound");
    return json({ ok: true, message: "微信已解绑" });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    Logger.error("[unbind] error", { error: msg });
    return json({ error: msg }, 500);
  }
}
