import { describe, it, expect, vi, afterEach } from "vitest";
import { handleQRCode, handleQRCodeStatus, handleUnbindWechat } from "./qrcode";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeEnv() {
  const doStub = {
    fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
  };
  const kv = { put: vi.fn(async () => true) };
  return {
    env: {
      ADMIN_PASSWORD: "secret123",
      CLAWBOT_KV: kv,
      ILINK_CONNECTION: { idFromName: () => "main", get: () => doStub },
    } as any,
    doStub,
    kv,
  };
}

const AUTH = { Authorization: "Basic " + btoa("admin:secret123") };

describe("handleQRCode", () => {
  it("should return 401 without auth", async () => {
    const { env } = makeEnv();
    const resp = await handleQRCode(new Request("http://localhost/api/qrcode"), env);
    expect(resp.status).toBe(401);
  });

  it("should return qrcode data with valid auth", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ qrcode: "QR_123", qrcode_img_content: "data:image/png;base64,xxx" }), { status: 200 })
    ));
    const { env } = makeEnv();
    const resp = await handleQRCode(new Request("http://localhost/api/qrcode", { headers: AUTH }), env);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.qrcode).toBe("QR_123");
    expect(body.qrcode_url).toContain("data:image/png");
  });

  it("should return 500 when QR fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("fail", { status: 500 })));
    const { env } = makeEnv();
    const resp = await handleQRCode(new Request("http://localhost/api/qrcode", { headers: AUTH }), env);
    expect(resp.status).toBe(500);
  });
});

describe("handleQRCodeStatus", () => {
  it("should return unknown without qrcode param", async () => {
    const { env } = makeEnv();
    const resp = await handleQRCodeStatus(new Request("http://localhost/api/qrcode-status"), env);
    const body = await resp.json();
    expect(body.status).toBe("unknown");
  });

  it("should return wait status when not confirmed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ status: "wait" }), { status: 200 })
    ));
    const { env, doStub } = makeEnv();
    const resp = await handleQRCodeStatus(
      new Request("http://localhost/api/qrcode-status?qrcode=QR_1"), env
    );
    const body = await resp.json();
    expect(body.status).toBe("wait");
    // 未确认不应保存凭证
    expect(doStub.fetch).not.toHaveBeenCalled();
  });

  it("should save creds and issue session when confirmed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        status: "confirmed",
        bot_token: "bot_tok",
        ilink_bot_id: "bot_id",
        ilink_user_id: "user_id",
        baseurl: "https://ilinkai.weixin.qq.com",
      }), { status: 200 })
    ));
    const { env, doStub, kv } = makeEnv();
    const resp = await handleQRCodeStatus(
      new Request("http://localhost/api/qrcode-status?qrcode=QR_2"), env
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("confirmed");
    expect(body.ok).toBe(true);
    expect(body.accountId).toBe("bot_id");
    // 应保存凭证到 DO
    const saveCall = doStub.fetch.mock.calls.find(([r]: any) =>
      (r as Request).url.includes("save-creds"));
    expect(saveCall).toBeTruthy();
    // 应写入 session kv 并设置 cookie
    expect(kv.put).toHaveBeenCalled();
    expect(resp.headers.get("Set-Cookie")).toContain("clawbot_session=");
  });

  it("should gracefully return wait when polling errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net down"); }));
    const { env } = makeEnv();
    const resp = await handleQRCodeStatus(
      new Request("http://localhost/api/qrcode-status?qrcode=QR_3"), env
    );
    // getQRCodeStatus 内部捕获 fetch 错误并返回 wait，不抛给路由
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("wait");
  });
});

describe("handleUnbindWechat", () => {
  it("should return 401 without auth", async () => {
    const { env } = makeEnv();
    const resp = await handleUnbindWechat(
      new Request("http://localhost/api/unbind-wechat", { method: "POST" }), env
    );
    expect(resp.status).toBe(401);
  });

  it("should clear DO creds on unbind", async () => {
    const { env, doStub } = makeEnv();
    const resp = await handleUnbindWechat(
      new Request("http://localhost/api/unbind-wechat", { method: "POST", headers: AUTH }), env
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    const clearCall = doStub.fetch.mock.calls.find(([r]: any) =>
      (r as Request).url.includes("clear-creds"));
    expect(clearCall).toBeTruthy();
  });
});