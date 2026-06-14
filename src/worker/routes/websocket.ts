// WebSocket 路由 - 实时消息推送

import { verifyAdmin } from "../utils";
import type { Env } from "../index";

export async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return new Response("Unauthorized", { status: 401 });

  const upgradeHeader = request.headers.get("Upgrade");
  if (!upgradeHeader || upgradeHeader !== "websocket") {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }

  const doId = env.ILINK_CONNECTION.idFromName("main");
  const doStub = env.ILINK_CONNECTION.get(doId);

  return doStub.fetch(request);
}
