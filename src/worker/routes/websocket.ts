// WebSocket 路由 - 实时消息推送

import type { Env } from "../index";

export async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  if (!upgradeHeader || upgradeHeader !== "websocket") {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }

  // WebSocket 只推送消息，不做敏感操作，跳过认证检查
  const doId = env.ILINK_CONNECTION.idFromName("main");
  const doStub = env.ILINK_CONNECTION.get(doId);

  return doStub.fetch(request);
}
