// 聊天记录跨浏览器同步 - 使用 D1 存储

import { json, verifyAdmin } from "../utils";
import type { Env } from "../index";

const MAX_MESSAGES = 100;

let tableReady = false;

async function ensureTable(db: D1Database) {
  if (tableReady) return;
  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    tableReady = true;
  } catch (e: any) {
    console.error("[chat-messages] ensureTable failed:", e.message);
  }
}

export async function handleChatMessages(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  await ensureTable(env.DB);

  try {
    if (request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT role, text FROM chat_messages ORDER BY created_at ASC LIMIT ?`).bind(MAX_MESSAGES).all();
      const messages = (results || []).map((r: any) => ({ role: r.role, text: r.text }));
      return json({ messages });
    }

    if (request.method === "POST") {
      const body = await request.json() as { messages: Array<{ role: string; text: string }> };
      if (!Array.isArray(body.messages)) {
        return json({ error: "无效的消息格式" }, 400);
      }
      await env.DB.exec(`DELETE FROM chat_messages`);
      const now = Date.now();
      const trimmed = body.messages.slice(-MAX_MESSAGES);
      for (let i = 0; i < trimmed.length; i++) {
        await env.DB.prepare(`INSERT INTO chat_messages (role, text, created_at) VALUES (?, ?, ?)`).bind(trimmed[i].role, trimmed[i].text, now + i).run();
      }
      return json({ ok: true, count: trimmed.length });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}
