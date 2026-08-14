import { describe, it, expect } from "vitest";
import { parseApiUrl, formatToolContent, extractImageSize, isVagueFollowUp, filterBuiltinTools } from "./ai";

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

describe("isVagueFollowUp", () => {
  it("should detect '列出来' as vague follow-up", () => {
    expect(isVagueFollowUp("给我列出来")).toBe(true);
  });

  it("should detect '是哪一条' as vague follow-up", () => {
    expect(isVagueFollowUp("是哪一条")).toBe(true);
  });

  it("should detect '我需要详细记录' as vague follow-up (contains 详细)", () => {
    expect(isVagueFollowUp("我需要详细记录")).toBe(true);
  });

  it("should detect '具体点' / '展开说说' as vague follow-up", () => {
    expect(isVagueFollowUp("具体点")).toBe(true);
    expect(isVagueFollowUp("展开说说")).toBe(true);
  });

  it("should detect '还有呢' / '然后呢' as vague follow-up", () => {
    expect(isVagueFollowUp("还有呢")).toBe(true);
    expect(isVagueFollowUp("然后呢")).toBe(true);
  });

  it("should detect '第一条' as vague follow-up", () => {
    expect(isVagueFollowUp("第一条")).toBe(true);
  });

  it("should detect any ordinal like 第四条 / 第12条 / 第二条", () => {
    expect(isVagueFollowUp("第四条")).toBe(true);
    expect(isVagueFollowUp("第12条")).toBe(true);
    expect(isVagueFollowUp("第二条")).toBe(true);
    expect(isVagueFollowUp("第100个")).toBe(true);
  });

  it("should NOT treat long/complex questions as vague follow-up", () => {
    expect(isVagueFollowUp("今天天气怎么样，我需要知道明天要不要带伞")).toBe(false);
  });

  it("should NOT treat standalone nouns as vague follow-up", () => {
    expect(isVagueFollowUp("天气")).toBe(false);
    expect(isVagueFollowUp("余额")).toBe(false);
  });

  it("should NOT treat clear full questions as vague follow-up", () => {
    expect(isVagueFollowUp("过去30天有哪些推送失败的")).toBe(false);
    expect(isVagueFollowUp("这个月有多少失败的推送记录")).toBe(false);
  });

  it("should handle empty and whitespace input", () => {
    expect(isVagueFollowUp("")).toBe(false);
    expect(isVagueFollowUp("   ")).toBe(false);
  });
});

describe("filterBuiltinTools", () => {
  const mockTools = [
    { type: "function", function: { name: "get_current_datetime", description: "获取时间" } },
    { type: "function", function: { name: "get_news", description: "获取新闻" } },
    { type: "function", function: { name: "web_search", description: "搜索互联网" } },
    { type: "function", function: { name: "generate_image", description: "生成图片" } },
  ];

  it("should exclude web_search when searchBaseUrl is not configured", () => {
    const result = filterBuiltinTools(mockTools as any, undefined);
    const names = result.map((t: any) => t.function.name);
    expect(names).not.toContain("web_search");
    expect(names).toContain("get_current_datetime");
    expect(names).toContain("get_news");
    expect(names).toContain("generate_image");
  });

  it("should exclude web_search when searchBaseUrl is empty string", () => {
    const result = filterBuiltinTools(mockTools as any, "");
    const names = result.map((t: any) => t.function.name);
    expect(names).not.toContain("web_search");
  });

  it("should include web_search when searchBaseUrl is configured", () => {
    const result = filterBuiltinTools(mockTools as any, "https://search.example.com");
    const names = result.map((t: any) => t.function.name);
    expect(names).toContain("web_search");
    expect(names).toContain("get_current_datetime");
  });

  it("should append extra tools after builtin tools", () => {
    const extra = [{ type: "function", function: { name: "mcp_tool", description: "MCP 工具" } }];
    const result = filterBuiltinTools(mockTools as any, "https://search.example.com", extra);
    expect(result).toHaveLength(5);
    expect(result[4].function.name).toBe("mcp_tool");
  });

  it("should return only extra tools when builtin list is empty", () => {
    const extra = [{ type: "function", function: { name: "only_tool" } }];
    const result = filterBuiltinTools([], "https://x.com", extra);
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe("only_tool");
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