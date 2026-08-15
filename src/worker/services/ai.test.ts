import { describe, it, expect } from "vitest";
import {
  parseApiUrl, formatToolContent, extractImageSize, isVagueFollowUp, filterBuiltinTools,
  tryQuickReply, isImageGenerationRequest, isVideoGenerationRequest, extractMediaPrompt,
  extractVideoDuration, extractUrl,
} from "./ai";

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

  it("should include all builtin tools regardless of searchBaseUrl", () => {
    // web_search 已有内置兜底搜索源，不再依赖 cloudflare-search
    const result = filterBuiltinTools(mockTools as any, undefined);
    const names = result.map((t: any) => t.function.name);
    expect(names).toContain("web_search");
    expect(names).toContain("get_current_datetime");
    expect(names).toContain("get_news");
    expect(names).toContain("generate_image");
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

describe("tryQuickReply", () => {
  it("should return quick reply for 你好", () => {
    expect(tryQuickReply("你好")).toContain("爪爪");
  });

  it("should return quick reply for 你是谁", () => {
    expect(tryQuickReply("你是谁")).toContain("ClawBot");
  });

  it("should return help for 帮助", () => {
    expect(tryQuickReply("帮助")).toContain("我可以帮你");
  });

  it("should return null for unknown messages", () => {
    expect(tryQuickReply("今天天气怎么样")).toBeNull();
  });

  it("should handle whitespace and case", () => {
    expect(tryQuickReply("  你好  ")).toBeTruthy();
    expect(tryQuickReply("Reset")).toBeNull(); // 大小写敏感
  });
});

describe("isImageGenerationRequest / isVideoGenerationRequest", () => {
  it("should detect 图片 command", () => {
    expect(isImageGenerationRequest("/图片 一只猫")).toBe(true);
    expect(isImageGenerationRequest("/image 一只猫")).toBe(true);
  });

  it("should detect 视频 command", () => {
    expect(isVideoGenerationRequest("/视频 一只猫跑")).toBe(true);
    expect(isVideoGenerationRequest("/video 一只猫跑")).toBe(true);
  });

  it("should NOT detect plain text as command", () => {
    expect(isImageGenerationRequest("帮我画一张图")).toBe(false);
    expect(isVideoGenerationRequest("帮我生成视频")).toBe(false);
    expect(isImageGenerationRequest("")).toBe(false);
  });
});

describe("extractMediaPrompt", () => {
  it("should strip image command prefix", () => {
    expect(extractMediaPrompt("/图片 一只猫", "image")).toBe("一只猫");
  });

  it("should strip video command prefix", () => {
    expect(extractMediaPrompt("/视频 一只猫跑", "video")).toBe("一只猫跑");
  });

  it("should return trimmed text when no command present", () => {
    expect(extractMediaPrompt("  图片 一只猫", "image")).toBe("图片 一只猫"); // 无 / 前缀不匹配
    expect(extractMediaPrompt("raw text", "image")).toBe("raw text");
  });

  it("should return original when prompt empty after strip", () => {
    expect(extractMediaPrompt("/图片", "image")).toBe("/图片");
  });
});

describe("extractVideoDuration", () => {
  it("should parse explicit seconds", () => {
    expect(extractVideoDuration("/视频 10秒 x")).toEqual({ numFrames: 240, frameRate: 24 });
    expect(extractVideoDuration("5s内容")).toEqual({ numFrames: 120, frameRate: 24 });
  });

  it("should clamp duration to 1-30 seconds", () => {
    expect(extractVideoDuration("100秒")).toEqual({ numFrames: 30 * 24, frameRate: 24 });
    expect(extractVideoDuration("0.5秒")).toEqual({ numFrames: 1 * 24, frameRate: 24 });
  });

  it("should parse Chinese keywords", () => {
    expect(extractVideoDuration("长一点")).toEqual({ numFrames: 24 * 8, frameRate: 24 });
    expect(extractVideoDuration("短视频")).toEqual({ numFrames: 24 * 3, frameRate: 24 });
    expect(extractVideoDuration("要超长的")).toEqual({ numFrames: 24 * 15, frameRate: 24 });
  });

  it("should return undefined without duration hints", () => {
    expect(extractVideoDuration("普通文本")).toBeUndefined();
    expect(extractVideoDuration("")).toBeUndefined();
  });
});

describe("extractUrl", () => {
  it("should extract http URL from text", () => {
    expect(extractUrl("看这个 https://example.com/page 的内容")).toBe("https://example.com/page");
  });

  it("should extract https URL", () => {
    expect(extractUrl("https://foo.com/a?b=1&c=2 其他")).toBe("https://foo.com/a?b=1&c=2");
  });

  it("should return undefined without URL", () => {
    expect(extractUrl("没有链接")).toBeUndefined();
    expect(extractUrl("")).toBeUndefined();
  });
});