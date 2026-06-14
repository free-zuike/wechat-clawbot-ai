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

    // 不再写入KV（省写入配额），前端轮询时直接传qrcode key

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
    if (!key) {
      // qrcode_key 不存在，检查是否已登录（DO可能已先完成确认）
      const creds = await env.CLAWBOT_KV.get("clawbot:credentials");
      if (creds) {
        return json({ status: "confirmed", ok: true });
      }
      return json({ status: "unknown" });
    }

    const status = await getQRCodeStatus(key);
    Logger.info("[qrcode-status] poll", { status: status.status });

    // 如果已确认或KV中已有凭证（DO可能先保存了），返回确认
    if (status.status === "confirmed" && status.bot_token && status.ilink_bot_id) {
      const baseUrl = status.baseurl || "https://ilinkai.weixin.qq.com";

      const creds = {
        botToken: status.bot_token,
        accountId: status.ilink_bot_id,
        userId: status.ilink_user_id,
        baseUrl,
        syncBuf: "",
        rawLoginResponse: status.raw,
        createdAt: Date.now(),
      };

      // 保存凭证到KV（失败不阻塞）
      try {
        await env.CLAWBOT_KV.put("clawbot:credentials", JSON.stringify(creds));
      } catch (e: any) {
        Logger.warn("[qrcode-status] KV put credentials failed", { error: e.message });
      }

      // 保存凭证到 DO（fire-and-forget，不阻塞响应）
      const doId = env.ILINK_CONNECTION.idFromName("main");
      const doStub = env.ILINK_CONNECTION.get(doId);
      doStub.fetch(new Request("http://localhost/save-creds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creds),
      })).catch((e: any) => Logger.warn("[qrcode-status] DO save-creds failed", { error: e.message }));

      // 触发 DO 启动轮询（fire-and-forget，不阻塞响应）
      const pollDoId = env.ILINK_CONNECTION.idFromName("main");
      const pollDoStub = env.ILINK_CONNECTION.get(pollDoId);
      pollDoStub.fetch(new Request("http://localhost/poll")).catch(() => {});

      // 存session到KV（失败不阻塞）
      const sessionToken = generateSessionToken();
      try {
        await env.CLAWBOT_KV.put(`clawbot:session:${sessionToken}`, "valid", { expirationTtl: 24 * 60 * 60 });
      } catch (_) {}

      // 清理 qrcode_key（失败忽略）
      await env.CLAWBOT_KV.delete("clawbot:qrcode_key").catch(() => {});

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
