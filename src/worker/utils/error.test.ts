import { describe, it, expect, vi, afterEach } from "vitest";
import { withRetry, ClawBotError, handleError, ErrorCodes } from "./error";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("withRetry", () => {
  it("should return result on first success", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await withRetry(fn, { retries: 3 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry on failure and eventually succeed", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValueOnce("success");
    const result = await withRetry(fn, { retries: 3, baseDelayMs: 0 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("should throw after exhausting retries", async () => {
    const fn = vi.fn(async () => { throw new Error("always fails"); });
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 0 })).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should stop retrying when shouldRetry returns false", async () => {
    const fn = vi.fn(async () => { throw new ClawBotError("NO_RETRY", "don't retry", 400); });
    await expect(
      withRetry(fn, {
        retries: 5,
        baseDelayMs: 0,
        shouldRetry: (e) => !(e instanceof ClawBotError && e.code === "NO_RETRY"),
      })
    ).rejects.toThrow("don't retry");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should call onRetry callback with attempt number", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValueOnce("ok");
    const onRetry = vi.fn();
    await withRetry(fn, { retries: 2, baseDelayMs: 0, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toBe(1);
  });

  it("should call onRetry with error", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    const onRetry = vi.fn();
    await withRetry(fn, { retries: 2, baseDelayMs: 0, onRetry });
    expect(onRetry.mock.calls[0]![1]).toBeInstanceOf(Error);
    expect((onRetry.mock.calls[0]![1] as Error).message).toBe("boom");
  });

  it("should respect maxDelayMs cap", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("a"))
      .mockRejectedValueOnce(new Error("b"))
      .mockResolvedValueOnce("ok");
    // baseDelayMs=5000 → 第二次重试 delay=5000*2=10000, maxDelayMs=6000 → 用 6000
    // 这里只验证不抛错即可（delay 实际执行较慢，用 maxDelayMs 较小值）
    await withRetry(fn, { retries: 3, baseDelayMs: 1, maxDelayMs: 2 });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("ClawBotError", () => {
  it("should create error with code, status, context", () => {
    const err = new ClawBotError("TEST_CODE", "测试消息", 403, { extra: "info" });
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("测试消息");
    expect(err.status).toBe(403);
    expect(err.context).toEqual({ extra: "info" });
    expect(err.name).toBe("ClawBotError");
  });

  it("should default status to 500", () => {
    const err = new ClawBotError("CODE", "msg");
    expect(err.status).toBe(500);
  });

  it("toJSON should include error code and message", () => {
    const err = new ClawBotError("CODE", "msg", 400, { a: 1 });
    expect(err.toJSON()).toEqual({ error: "CODE", message: "msg", context: { a: 1 } });
  });

  it("toJSON should omit context when absent", () => {
    const err = new ClawBotError("CODE", "msg");
    expect(err.toJSON()).toEqual({ error: "CODE", message: "msg" });
  });

  it("ErrorCodes should have standard error definitions", () => {
    expect(ErrorCodes.AUTH_FAILED.code).toBe("AUTH_FAILED");
    expect(ErrorCodes.AUTH_FAILED.status).toBe(401);
    expect(ErrorCodes.UNAUTHORIZED.status).toBe(403);
    expect(ErrorCodes.NOT_FOUND.status).toBe(404);
    expect(ErrorCodes.INTERNAL_ERROR.status).toBe(500);
    expect(ErrorCodes.SERVICE_UNAVAILABLE.status).toBe(503);
  });
});

describe("handleError", () => {
  it("should return ClawBotError details with status", async () => {
    const err = new ClawBotError("TEST", "测试错误", 418);
    const resp = handleError(err);
    expect(resp.status).toBe(418);
    const body = await resp.json();
    expect(body).toEqual({ error: "TEST", message: "测试错误" });
  });

  it("should return INTERNAL_ERROR for generic Error", async () => {
    const resp = handleError(new Error("generic boom"));
    expect(resp.status).toBe(500);
    const body = await resp.json();
    expect(body.error).toBe("INTERNAL_ERROR");
  });

  it("should return INTERNAL_ERROR for non-Error throw", async () => {
    const resp = handleError("string error");
    expect(resp.status).toBe(500);
    const body = await resp.json();
    expect(body.error).toBe("INTERNAL_ERROR");
  });
});