// 聊天记录跨浏览器同步 - 使用 KV 存储

import { json, verifyAdmin } from "../utils";
import type { Env } from "../index";

const MAX_MESSAGES = 100;
const KV_KEY = "clawbot:chat-messages";

export async function handleChatMessages(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    if (request.method === "GET") {
      const raw = await env.CLAWBOT_KV.get(KV_KEY);
      const messages = raw ? JSON.parse(raw) : [];
      return json({ messages });
    }

    if (request.method === "POST") {
      const body = await request.json() as { messages: Array<{ role: string; text: string }> };
      if (!Array.isArray(body.messages)) {
        return json({ error: "无效的消息格式" }, 400);
      }
      // 只保留最近 100 条
      const trimmed = body.messages.slice(-MAX_MESSAGES);
      await env.CLAWBOT_KV.put(KV_KEY, JSON.stringify(trimmed));
      return json({ ok: true, count: trimmed.length });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}
