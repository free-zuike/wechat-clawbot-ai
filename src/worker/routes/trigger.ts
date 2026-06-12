import { json, verifyAdmin } from "../utils";
import type { Env } from "../index";

// 不再直接走 messaging.ts 的旧 KV 路径，统一委托给 Durable Object 处理
export async function handleTriggerPoll(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  const doId = env.ILINK_CONNECTION.idFromName("main");
  const doStub = env.ILINK_CONNECTION.get(doId);

  // 转发到 DO 的 /poll：会初始化凭证 + 启动轮询循环 + 返回挂起消息
  const doResponse = await doStub.fetch(new Request("http://localhost/poll"));
  const data = await doResponse.json();
  return json(data);
}
