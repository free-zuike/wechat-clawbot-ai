// Durable Object 代理路由 - 前端通过 Worker 访问 DO
// DO 替代 Cron 轮询，实现真正的实时消息接收

import { json, verifyAdmin } from "../utils";
import type { Env } from "../index";

// 获取 DO 实例 ID（使用固定名称确保单实例）
function getDOId(): string {
  return "main";
}

export async function handleDOPoll(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    const doId = env.ILINK_CONNECTION.idFromName(getDOId());
    const doStub = env.ILINK_CONNECTION.get(doId);

    // 转发请求到 DO
    const doRequest = new Request(`http://localhost/poll`, {
      method: "GET",
      headers: request.headers,
    });

    const doResponse = await doStub.fetch(doRequest);
    const data = await doResponse.json();
    return json(data);
  } catch (e: any) {
    console.error("[DO Proxy] poll error:", e);
    return json({ error: e.message }, 500);
  }
}

export async function handleDOSend(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    const body = await request.json() as { toUserId?: string; contextToken?: string; text?: string };
    const { toUserId, contextToken, text } = body;

    if (!toUserId || !text) {
      return json({ error: "缺少参数：toUserId 和 text 必填" }, 400);
    }

    const doId = env.ILINK_CONNECTION.idFromName(getDOId());
    const doStub = env.ILINK_CONNECTION.get(doId);

    const doRequest = new Request(`http://localhost/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toUserId, contextToken, text }),
    });

    const doResponse = await doStub.fetch(doRequest);
    const data = await doResponse.json();
    return json(data);
  } catch (e: any) {
    console.error("[DO Proxy] send error:", e);
    return json({ error: e.message }, 500);
  }
}

export async function handleDOStatus(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    const doId = env.ILINK_CONNECTION.idFromName(getDOId());
    const doStub = env.ILINK_CONNECTION.get(doId);

    const doRequest = new Request(`http://localhost/status`, {
      method: "GET",
    });

    const doResponse = await doStub.fetch(doRequest);
    const data = await doResponse.json();
    return json(data);
  } catch (e: any) {
    console.error("[DO Proxy] status error:", e);
    return json({ error: e.message }, 500);
  }
}

export async function handleDOFlush(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    const doId = env.ILINK_CONNECTION.idFromName(getDOId());
    const doStub = env.ILINK_CONNECTION.get(doId);

    const doRequest = new Request(`http://localhost/flush`, {
      method: "POST",
    });

    const doResponse = await doStub.fetch(doRequest);
    const data = await doResponse.json();
    return json(data);
  } catch (e: any) {
    console.error("[DO Proxy] flush error:", e);
    return json({ error: e.message }, 500);
  }
}
