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
      const userId = status.ilink_user_id || "";
      const fullToken = status.bot_token;
      const tokenParts = fullToken.split(":");
      const tokenAfterColon = tokenParts.length >= 2 ? tokenParts.slice(1).join(":") : fullToken;

      // 扫码确认后，系统探测连接/激活类接口（可能需要先建立连接）
      const probeResults: any[] = [];
      const connectPaths = [
        "/ilink/bot/connect", "/ilink/bot/open", "/ilink/bot/register",
        "/ilink/bot/activate", "/ilink/bot/login",
        "/ilink/bot/health", "/ilink/bot/status",
      ];
      for (const p of connectPaths) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 4000);
          const headers: Record<string, string> = { "Content-Type": "application/json", "iLink-App-ClientVersion": "1" };
          const body = JSON.stringify({ bot_token: fullToken, ilink_bot_id: botId });
          const r = await fetch(`${baseUrl}${p}`, { method: "POST", headers, body, signal: ctrl.signal });
          clearTimeout(t);
          const text = await r.text();
          let parsed: any = null;
          try { parsed = JSON.parse(text); } catch {}
          probeResults.push({
            path: p, httpStatus: r.status,
            keys: parsed ? Object.keys(parsed) : null,
            ret: parsed?.ret !== undefined ? parsed.ret : parsed?.errcode,
            preview: text.slice(0, 200),
          });
        } catch (e: any) { probeResults.push({ path: p, error: e.message }); }
      }

      // 然后尝试多种 getupdates 格式
      const sessionAttempts: any[] = [];
      let workingAuth: string | null = null;
      let workingBody: any = null;
      let workingResponse: any = null;

      const updatesAttempts = [
        { auth: `Bearer ${fullToken}`, body: { get_updates_buf: "" }, name: "full-Bearer" },
        { auth: `Bearer ${fullToken}`, body: { get_updates_buf: "", ilink_bot_id: botId }, name: "full-Bearer-bot" },
        { auth: `Bearer ${tokenAfterColon}`, body: { get_updates_buf: "" }, name: "short-Bearer" },
        { auth: `Bearer ${tokenAfterColon}`, body: { get_updates_buf: "", ilink_bot_id: botId }, name: "short-Bearer-bot" },
        { auth: `Bearer ${tokenAfterColon}`, body: { get_updates_buf: "", ilink_bot_id: botId, ilink_user_id: userId }, name: "short-Bearer-both" },
        { auth: `Bot ${tokenAfterColon}`, body: { get_updates_buf: "", ilink_bot_id: botId }, name: "short-Bot" },
        { auth: `Token ${tokenAfterColon}`, body: { get_updates_buf: "", ilink_bot_id: botId }, name: "short-Token" },
        { auth: null, body: { get_updates_buf: "", token: tokenAfterColon, ilink_bot_id: botId }, name: "body-token-short" },
        { auth: null, body: { get_updates_buf: "", bot_token: fullToken, ilink_bot_id: botId }, name: "body-bot_token" },
        { auth: `${botId} ${tokenAfterColon}`, body: { get_updates_buf: "" }, name: "prefix-botId" },
      ];

      for (let i = 0; i < updatesAttempts.length; i++) {
        const a = updatesAttempts[i];
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 5000);
          const headers: Record<string, string> = { "Content-Type": "application/json", "iLink-App-ClientVersion": "1" };
          if (a.auth) headers["Authorization"] = a.auth;
          const r = await fetch(`${baseUrl}/ilink/bot/getupdates`, {
            method: "POST", headers, body: JSON.stringify(a.body), signal: ctrl.signal,
          });
          clearTimeout(timer);
          const text = await r.text();
          let ret: any = null;
          let responseData: any = null;
          try { responseData = JSON.parse(text); ret = responseData.ret !== undefined ? responseData.ret : responseData.errcode; } catch {}
          sessionAttempts.push({
            name: a.name, httpStatus: r.status, ret,
            responseKeys: responseData ? Object.keys(responseData) : [],
            preview: text.slice(0, 200),
          });
          if (ret === 0) {
            workingAuth = a.auth; workingBody = a.body; workingResponse = responseData; break;
          }
        } catch (e: any) { sessionAttempts.push({ name: a.name, error: e.message }); }
      }

      const creds = {
        token: fullToken, tokenAfterColon, workingAuth, workingBody,
        accountId: botId, userId, baseUrl,
        createdAt: Date.now(),
        rawLoginResponse: status.raw,
        probeResults, sessionAttempts,
        sessionOk: !!workingResponse,
      };
      await env.CLAWBOT_KV.put("clawbot:credentials", JSON.stringify(creds));
      console.log("[qrcode-status] credentials saved, session ok:", !!workingResponse);

      const sessionToken = generateSessionToken();
      await env.CLAWBOT_KV.put(`clawbot:session:${sessionToken}`, "valid", { expirationTtl: 24 * 60 * 60 });
      await env.CLAWBOT_KV.delete("clawbot:qrcode_key");

      return json({ status: "confirmed", ok: true, sessionOk: !!workingResponse,
        probe: probeResults.length, updates: sessionAttempts.length }, 200, {
        "Set-Cookie": createSessionCookie(sessionToken),
      });
    }
    
    return json(status);
  } catch (e: any) {
    console.error("[qrcode-status] error:", e);
    return json({ error: String(e) }, 500);
  }
}
