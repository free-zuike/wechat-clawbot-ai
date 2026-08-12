import { describe, it, expect } from "vitest";
import { parseApiUrl, formatToolContent, extractImageSize } from "./ai";

describe("parseApiUrl", () => {
  it("should parse standard OpenAI URL", () => {
    const result = parseApiUrl("https://api.openai.com/v1/chat/completions");
    expect(result).toEqual({ base: "https://api.openai.com", version: "v1" });
  });

  it("should parse Zhipu AI URL", () => {
    const result = parseApiUrl("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    expect(result).toEqual({ base: "https://open.bigmodel.cn/api/paas", version: "v4" });
  });

  it("should parse image generation URL", () => {
    const result = parseApiUrl("https://api.openai.com/v1/images/generations");
    expect(result).toEqual({ base: "https://api.openai.com", version: "v1" });
  });

  it("should return default v1 when no version found", () => {
    const result = parseApiUrl("https://api.example.com/chat");
    expect(result).toEqual({ base: "https://api.example.com/chat", version: "v1" });
  });

  it("should handle trailing slashes", () => {
    const result = parseApiUrl("https://api.openai.com/v1/chat/completions/");
    expect(result).toEqual({ base: "https://api.openai.com", version: "v1" });
  });
});

describe("formatToolContent", () => {
  it("should return raw text unchanged for non-JSON", () => {
    const result = formatToolContent("这是一段普通文本");
    expect(result).toBe("这是一段普通文本");
  });

  it("should return raw text unchanged for empty string", () => {
    expect(formatToolContent("")).toBe("");
    expect(formatToolContent(undefined as any)).toBe(undefined);
  });

  it("should flatten JSON object with translated field names", () => {
    const result = formatToolContent('{"name":"测试","amount":100,"note":"备注"}');
    expect(result).toContain("名称");
    expect(result).toContain("测试");
    expect(result).toContain("金额");
    expect(result).toContain("100");
  });

  it("should flatten JSON array", () => {
    const result = formatToolContent('[{"name":"A","amount":50},{"name":"B","amount":30}]');
    expect(result).toContain("A");
    expect(result).toContain("B");
    expect(result).toContain("50");
    expect(result).toContain("30");
  });

  it("should handle invalid JSON gracefully", () => {
    const result = formatToolContent("{invalid json}");
    expect(result).toBe("{invalid json}");
  });
});

describe("extractImageSize", () => {
  it("should parse 1024x1024", () => {
    expect(extractImageSize("1024x1024")).toBe("1024x1024");
  });

  it("should parse 1024*1024", () => {
    expect(extractImageSize("1024*1024")).toBe("1024x1024");
  });

  it("should parse 1024 × 1024", () => {
    expect(extractImageSize("1024 × 1024")).toBe("1024x1024");
  });

  it("should return 1024x1024 for 正方形", () => {
    expect(extractImageSize("正方形")).toBe("1024x1024");
  });

  it("should return 1440x720 for 横版", () => {
    expect(extractImageSize("横版图片")).toBe("1440x720");
  });

  it("should return 720x1440 for 竖屏", () => {
    expect(extractImageSize("竖屏图片")).toBe("720x1440");
  });

  it("should return undefined for unrecognized text", () => {
    expect(extractImageSize("随便")).toBeUndefined();
  });

  it("should clamp to closest valid size", () => {
    expect(extractImageSize("1920x1920")).toBe("1024x1024");
  });
});