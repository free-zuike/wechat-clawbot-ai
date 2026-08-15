import { describe, it, expect, vi, afterEach } from "vitest";
import { handleTemplates } from "./templates";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeEnv(stored: any[] = []) {
  const kvStore = new Map<string, string>();
  if (stored.length > 0) kvStore.set("clawbot:templates", JSON.stringify(stored));
  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      const val = kvStore.get(key);
      if (val === undefined) return null;
      return type === "json" ? JSON.parse(val) : val;
    }),
    put: vi.fn(async (key: string, val: string) => { kvStore.set(key, val); }),
  };
  return { kv, kvStore };
}

const AUTH = { Authorization: "Basic " + btoa("admin:secret123") };

function envWith(env: any) {
  return { CLAWBOT_KV: env.kv, ADMIN_PASSWORD: "secret123", ...env };
}

describe("handleTemplates", () => {
  it("should return 401 without auth", async () => {
    const env = envWith(makeEnv());
    const resp = await handleTemplates(new Request("http://localhost/api/templates"), env);
    expect(resp.status).toBe(401);
  });

  it("should list empty templates", async () => {
    const env = envWith(makeEnv());
    const resp = await handleTemplates(
      new Request("http://localhost/api/templates", { headers: AUTH }), env
    );
    const body = await resp.json();
    expect(body.templates).toEqual([]);
  });

  it("should create a template", async () => {
    const env = envWith(makeEnv());
    const resp = await handleTemplates(
      new Request("http://localhost/api/templates", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "模板1", content: "你好${name}" }),
      }), env
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.template.name).toBe("模板1");
    expect(body.template.id).toMatch(/^tpl_/);
    // 已持久化
    expect(await env.kv.get("clawbot:templates", "json")).toHaveLength(1);
  });

  it("should reject empty name/content", async () => {
    const env = envWith(makeEnv());
    const resp = await handleTemplates(
      new Request("http://localhost/api/templates", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "", content: "" }),
      }), env
    );
    expect(resp.status).toBe(400);
  });

  it("should update an existing template", async () => {
    const tpl = { id: "tpl_1", name: "旧", content: "旧内容", createdAt: 1, updatedAt: 1 };
    const env = envWith(makeEnv([tpl]));
    const resp = await handleTemplates(
      new Request("http://localhost/api/templates", {
        method: "PUT",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ id: "tpl_1", content: "新内容" }),
      }), env
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.template.content).toBe("新内容");
    expect(body.template.name).toBe("旧"); // name 未变
  });

  it("should return 404 updating missing template", async () => {
    const env = envWith(makeEnv());
    const resp = await handleTemplates(
      new Request("http://localhost/api/templates", {
        method: "PUT",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ id: "nope", content: "x" }),
      }), env
    );
    expect(resp.status).toBe(404);
  });

  it("should delete a template", async () => {
    const tpl = { id: "tpl_1", name: "旧", content: "旧内容", createdAt: 1, updatedAt: 1 };
    const env = envWith(makeEnv([tpl]));
    const resp = await handleTemplates(
      new Request("http://localhost/api/templates?id=tpl_1", {
        method: "DELETE",
        headers: AUTH,
      }), env
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(await env.kv.get("clawbot:templates", "json")).toHaveLength(0);
  });

  it("should return 404 deleting missing template", async () => {
    const env = envWith(makeEnv());
    const resp = await handleTemplates(
      new Request("http://localhost/api/templates?id=nope", {
        method: "DELETE",
        headers: AUTH,
      }), env
    );
    expect(resp.status).toBe(404);
  });

  it("should return 405 for unsupported method", async () => {
    const env = envWith(makeEnv());
    const resp = await handleTemplates(
      new Request("http://localhost/api/templates", {
        method: "PATCH",
        headers: AUTH,
      }), env
    );
    expect(resp.status).toBe(405);
  });
});