// 定时消息 + 用户事实 管理路由（后台面板）
// 定时消息走 DO 代理（增删后需要重排 Alarm）；事实直连 D1

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";
import { loadAllFacts, saveFact, deleteFact, ensureFactsTable } from "../services/facts";

// ============ 定时消息 ============

async function proxyToDO(request: Request, env: Env): Promise<Response> {
  const doId = env.ILINK_CONNECTION.idFromName("main");
  const doStub = env.ILINK_CONNECTION.get(doId);
  const url = new URL(request.url);
  const doUrl = new URL("http://localhost/scheduled-messages");
  url.searchParams.forEach((val, key) => doUrl.searchParams.set(key, val));
  const doRequest = new Request(doUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
  });
  const doResponse = await doStub.fetch(doRequest);
  const data = await doResponse.json();
  return json(data, doResponse.status);
}

export async function handleScheduledMessagesRoute(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);
  try {
    return await proxyToDO(request, env);
  } catch (e: any) {
    Logger.error("[Scheduled] proxy error", { error: e?.message });
    return json({ error: e.message }, 500);
  }
}

// ============ 用户事实 ============

export async function handleFacts(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    await ensureFactsTable(env.DB);
    const method = request.method;
    const url = new URL(request.url);

    if (method === "GET") {
      const facts = await loadAllFacts(env.DB);
      return json({ ok: true, facts });
    }

    if (method === "POST") {
      const body = await request.json() as { userId?: string; fact?: string };
      const userId = (body.userId || "").trim();
      const fact = (body.fact || "").trim();
      if (!userId || !fact) return json({ ok: false, error: "userId 和 fact 必填" }, 400);
      await saveFact(env.DB, userId, fact);
      return json({ ok: true });
    }

    if (method === "DELETE") {
      const userId = url.searchParams.get("userId") || "";
      const fact = url.searchParams.get("fact") || "";
      if (!userId || !fact) return json({ ok: false, error: "缺少 userId/fact" }, 400);
      const ok = await deleteFact(env.DB, userId, fact);
      return json({ ok });
    }

    return json({ error: "Method Not Allowed" }, 405);
  } catch (e: any) {
    Logger.error("[Facts] route error", { error: e?.message });
    return json({ error: e.message }, 500);
  }
}
