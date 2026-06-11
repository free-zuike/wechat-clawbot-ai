import { json, verifyAdmin, generateSessionToken, createSessionCookie } from "../utils";
import { getQRCode, getQRCodeStatus } from "../services/ilink";
import type { Env } from "../index";

// 1. 获取二维码（需要管理员密码）
export async function handleQRCode(request: Request, env: Env): Promise<Response> {
  console.log("[qrcode] handleQRCode called");
  const v = await verifyAdmin(request, env);
  if (!v.ok) {
    console.warn("[qrcode] auth failed:", v.error);
    return json({ error: v.error }, 401);
  }
  try {
    const data = await getQRCode();
    await env.CLAWBOT_KV.put("clawbot:qrcode_key", data.key, {
      expirationTtl: 5 * 60,
    });
    console.log("[qrcode] QR code saved to KV:", data.key);
    return json({ qrcode: data.key, qrcode_url: data.imgUrl });
  } catch (e: any) {
    console.error("[qrcode] error:", e);
    return json({ error: String(e) }, 500);
  }
}

// 3. 轮询扫码状态（通过二维码key验证，无需密码）
export async function handleQRCodeStatus(request: Request, env: Env): Promise<Response> {
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
      const baseUrl = status.baseurl || "https://ilinkai.weixin.qq.com";
      const botId = status.ilink_bot_id || "";
      const fullToken = status.bot_token;
      const tokenParts = fullToken.split(":");
      const tokenAfterColon = tokenParts.length >= 2 ? tokenParts.slice(1).join(":") : fullToken;

      // 扫码确认后，立即尝试多种方式建立 session（token 有效期可能只有几秒）
      const sessionAttempts: any[] = [];
      let workingToken: string | null = null;
      let workingAuth: string | null = null;
      let workingBody: any = null;
      let workingResponse: any = null;

      const attempts = [
        { auth: `Bearer ${fullToken}`, body: { get_updates_buf: "" } },
        { auth: `Bearer ${tokenAfterColon}`, body: { get_updates_buf: "" } },
        { auth: `Bearer ${tokenAfterColon}`, body: { get_updates_buf: "", ilink_bot_id: botId } },
        { auth: `Bot ${tokenAfterColon}`, body: { get_updates_buf: "", ilink_bot_id: botId } },
        { auth: null, body: { get_updates_buf: "", token: tokenAfterColon, ilink_bot_id: botId } },
        { auth: null, body: { get_updates_buf: "", bot_token: fullToken, ilink_bot_id: botId } },
        { auth: `${botId} ${tokenAfterColon}`, body: { get_updates_buf: "" } },
        { auth: `Bearer ${fullToken}`, body: { get_updates_buf: "", ilink_bot_id: botId, ilink_user_id: status.ilink_user_id || "" } },
      ];

      for (let i = 0; i < attempts.length; i++) {
        const a = attempts[i];
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 6000);
          const headers: Record<string, string> = { "Content-Type": "application/json", "iLink-App-ClientVersion": "1" };
          if (a.auth) headers["Authorization"] = a.auth;
          const r = await fetch(`${baseUrl}/ilink/bot/getupdates`, {
            method: "POST",
            headers,
            body: JSON.stringify(a.body),
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          const text = await r.text();
          let ret: any = null;
          let responseData: any = null;
          try {
            responseData = JSON.parse(text);
            ret = responseData.ret !== undefined ? responseData.ret : responseData.errcode;
          } catch {}
          sessionAttempts.push({
            index: i,
            auth: a.auth ? a.auth.split(" ")[0] + " " + (a.auth.split(" ")[1]?.slice(0, 10) || "...") : "none",
            httpStatus: r.status,
            ret,
            hasMsgs: responseData?.msgs?.length > 0,
            responseKeys: responseData ? Object.keys(responseData) : [],
            responsePreview: text.slice(0, 150),
          });
          if (ret === 0) {
            workingToken = a.auth ? (a.auth.includes("Bearer") || a.auth.includes("Bot") ? a.auth.split(" ").slice(1).join(" ") : a.auth) : null;
            workingAuth = a.auth;
            workingBody = a.body;
            workingResponse = responseData;
            break;
          }
        } catch (e: any) {
          sessionAttempts.push({ index: i, error: e.message });
        }
      }

      const creds = {
        token: fullToken,
        tokenAfterColon,
        workingToken,
        workingAuth,
        workingBody,
        accountId: botId,
        userId: status.ilink_user_id || "",
        baseUrl,
        createdAt: Date.now(),
        rawLoginResponse: status.raw,
        sessionAttempts,
        sessionOk: !!workingResponse,
      };
      await env.CLAWBOT_KV.put("clawbot:credentials", JSON.stringify(creds));
      console.log("[qrcode-status] credentials saved, session ok:", !!workingResponse, "attempts:", sessionAttempts.length);

      const sessionToken = generateSessionToken();
      await env.CLAWBOT_KV.put(`clawbot:session:${sessionToken}`, "valid", {
        expirationTtl: 24 * 60 * 60,
      });

      await env.CLAWBOT_KV.delete("clawbot:qrcode_key");

      return json({ status: "confirmed", ok: true, sessionOk: !!workingResponse, attempts: sessionAttempts.length }, 200, {
        "Set-Cookie": createSessionCookie(sessionToken),
      });
    }
    
    return json(status);
  } catch (e: any) {
    console.error("[qrcode-status] error:", e);
    return json({ error: String(e) }, 500);
  }
}
