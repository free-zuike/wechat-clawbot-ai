// 消息模板路由 - KV 存储

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";

const TEMPLATES_KEY = "clawbot:templates";

interface Template {
  id: string;
  name: string;
  content: string;
  category?: string;
  createdAt: number;
  updatedAt: number;
}

function getTemplatesFromKV(env: Env): Promise<Template[]> {
  return env.CLAWBOT_KV.get(TEMPLATES_KEY, "json").then((d) => (d as Template[]) || []).catch(() => []);
}

export async function handleTemplates(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  const method = request.method;

  if (method === "GET") {
    const templates = await getTemplatesFromKV(env);
    return json({ templates });
  }

  if (method === "POST") {
    try {
      const body = await request.json() as { name: string; content: string; category?: string };
      if (!body.name || !body.content) return json({ error: "名称和内容不能为空" }, 400);

      const templates = await getTemplatesFromKV(env);
      const template: Template = {
        id: `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: body.name,
        content: body.content,
        category: body.category || "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      templates.push(template);
      try { await env.CLAWBOT_KV.put(TEMPLATES_KEY, JSON.stringify(templates)); } catch {}
      return json({ ok: true, template });
    } catch (e: any) {
      Logger.error("[templates] create error", { error: e.message });
      return json({ error: e.message }, 500);
    }
  }

  if (method === "DELETE") {
    try {
      const url = new URL(request.url);
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "缺少 id" }, 400);

      const templates = await getTemplatesFromKV(env);
      const filtered = templates.filter((t) => t.id !== id);
      if (filtered.length === templates.length) return json({ error: "模板不存在" }, 404);
      try { await env.CLAWBOT_KV.put(TEMPLATES_KEY, JSON.stringify(filtered)); } catch {}
      return json({ ok: true });
    } catch (e: any) {
      Logger.error("[templates] delete error", { error: e.message });
      return json({ error: e.message }, 500);
    }
  }

  if (method === "PUT") {
    try {
      const body = await request.json() as { id: string; name?: string; content?: string; category?: string };
      if (!body.id) return json({ error: "缺少 id" }, 400);

      const templates = await getTemplatesFromKV(env);
      const idx = templates.findIndex((t) => t.id === body.id);
      if (idx === -1) return json({ error: "模板不存在" }, 404);

      if (body.name !== undefined) templates[idx].name = body.name;
      if (body.content !== undefined) templates[idx].content = body.content;
      if (body.category !== undefined) templates[idx].category = body.category;
      templates[idx].updatedAt = Date.now();
      try { await env.CLAWBOT_KV.put(TEMPLATES_KEY, JSON.stringify(templates)); } catch {}
      return json({ ok: true, template: templates[idx] });
    } catch (e: any) {
      Logger.error("[templates] update error", { error: e.message });
      return json({ error: e.message }, 500);
    }
  }

  return json({ error: "Method not allowed" }, 405);
}
