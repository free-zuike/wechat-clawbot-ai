// 二维码路由 - 获取登录二维码 + 轮询扫码状态
// 优化：qrcode_key 改用 Upstash Redis 存储（支持 TTL）

import { json, verifyAdmin, generateSessionToken, createSessionCookie } from "../utils";
import { Logger } from "../utils/error";
import { fetchQRCode, getQRCodeStatus } from "../services/ilink";
import { getUpstashService } from "../services/upstash";
import type { Env } from "../index";

// 1. 获取二维码
export async function handleQRCode(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  Logger.info("[qrcode] fetching QR code");
  try {
    const data = await fetchQRCode();

    // 使用 Upstash 存储（TTL 5 分钟）
    const upstash = getUpstashService(env);
    await upstash.set("clawbot:qrcode_key", data.qrcode, { ex: 5 * 60 });

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
    const upstash = getUpstashService(env);

    // 优先从 Upstash 读取 qrcode_key，兜底从 KV 读
    let key = await upstash.get("clawbot:qrcode_key");
    if (!key) {
      key = await env.CLAWBOT_KV.get("clawbot:qrcode_key") || undefined;
    }
    if (!key) {
      key = url.searchParams.get("qrcode") || undefined;
    }
    if (!key) return json({ status: "unknown" });

    const status = await getQRCodeStatus(key);
    Logger.info("[qrcode-status] poll", { status: status.status });

    if (status.status === "confirmed" && status.bot_token && status.ilink_bot_id) {
      const baseUrl = status.baseurl || "https://ilinkai.weixin.qq.com";

      // 保存凭证（标准 ILinkCredentials 结构）
      const creds = {
        botToken: status.bot_token,
        accountId: status.ilink_bot_id,
        userId: status.ilink_user_id,
        baseUrl,
        syncBuf: "",
        rawLoginResponse: status.raw,
        createdAt: Date.now(),
      };

      // 保存到 KV（DO SQLite 会在首次轮询时自动迁移，这里保留写入确保兼容性）
      await env.CLAWBOT_KV.put("clawbot:credentials", JSON.stringify(creds));

      // 触发 DO：从 KV 读到新凭证 → 同步到 SQLite → 启动轮询循环
      // （DO 的 initCredentials 发现 SQLite 为空时会 fallback 读 KV，并写入 SQLite）
      try {
        const doId = env.ILINK_CONNECTION.idFromName("main");
        const doStub = env.ILINK_CONNECTION.get(doId);
        await doStub.fetch(new Request("http://localhost/poll"));
        Logger.info("[qrcode-status] DO triggered successfully");
      } catch (e: any) {
        Logger.warn("[qrcode-status] DO trigger failed (will retry on next cron)", { error: e.message });
      }

      // session cookie（存储到 Upstash，TTL 24 小时）
      const sessionToken = generateSessionToken();
      await upstash.set(`clawbot:session:${sessionToken}`, "valid", { ex: 24 * 60 * 60 });

      // 删除 qrcode_key
      await upstash.del("clawbot:qrcode_key");
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
