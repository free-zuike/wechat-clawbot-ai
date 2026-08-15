import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MessageType,
  MessageItemType,
  MessageState,
  TypingStatus,
  translateEmoji,
  extractMessageText,
  sendTextChunked,
} from "./ilink";
import type { WeixinMessage } from "../types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("constants", () => {
  it("MessageType should have NONE=0 USER=1 BOT=2", () => {
    expect(MessageType).toEqual({ NONE: 0, USER: 1, BOT: 2 });
  });

  it("MessageItemType should have TEXT=1 IMAGE=2 VOICE=3 FILE=4 VIDEO=5", () => {
    expect(MessageItemType).toEqual({ NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 });
  });

  it("MessageState should have NEW=0 GENERATING=1 FINISH=2", () => {
    expect(MessageState).toEqual({ NEW: 0, GENERATING: 1, FINISH: 2 });
  });

  it("TypingStatus should have TYPING=1 CANCEL=2", () => {
    expect(TypingStatus).toEqual({ TYPING: 1, CANCEL: 2 });
  });
});

describe("translateEmoji", () => {
  it("should return empty string for empty input", () => {
    expect(translateEmoji("")).toBe("");
    expect(translateEmoji(undefined as any)).toBeUndefined();
    expect(translateEmoji(null as any)).toBeNull();
  });

  it("should return text unchanged when no emoji", () => {
    expect(translateEmoji("今天天气不错")).toBe("今天天气不错");
  });

  it("should translate common emoji to descriptions", () => {
    expect(translateEmoji("👍")).toBe("[赞]");
    expect(translateEmoji("😊")).toBe("[微笑]");
    expect(translateEmoji("❤️")).toBe("[心]");
  });

  it("should translate multiple emoji in one text", () => {
    expect(translateEmoji("真棒👍加油💪")).toBe("真棒[赞]加油[加油]");
  });

  it("should translate emoji embedded in text", () => {
    expect(translateEmoji("早上好☕")).toBe("早上好[咖啡]");
  });

  it("should handle repeated same emoji", () => {
    expect(translateEmoji("哈哈😂😂😂")).toBe("哈哈[笑哭][笑哭][笑哭]");
  });
});

describe("extractMessageText", () => {
  it("should return empty string for empty message", () => {
    expect(extractMessageText({} as WeixinMessage)).toBe("");
    expect(extractMessageText({ item_list: [] } as WeixinMessage)).toBe("");
  });

  it("should extract plain text message", () => {
    const msg = { item_list: [{ type: MessageItemType.TEXT, text_item: { text: "你好" } }] } as WeixinMessage;
    expect(extractMessageText(msg)).toBe("你好");
  });

  it("should translate emoji in text message", () => {
    const msg = { item_list: [{ type: MessageItemType.TEXT, text_item: { text: "真棒👍" } }] } as WeixinMessage;
    expect(extractMessageText(msg)).toBe("真棒[赞]");
  });

  it("should extract quoted message with title fallback", () => {
    const msg = {
      item_list: [{
        type: MessageItemType.TEXT,
        text_item: { text: "回复" },
        ref_msg: { title: "原消息内容" },
      }],
    } as WeixinMessage;
    expect(extractMessageText(msg)).toBe("[引用: 原消息内容]\n回复");
  });

  it("should extract quoted message from ref.message_item.text_item", () => {
    const msg = {
      item_list: [{
        type: MessageItemType.TEXT,
        text_item: { text: "继续" },
        ref_msg: { message_item: { text_item: { text: "被引用的原文" } } },
      }],
    } as WeixinMessage;
    expect(extractMessageText(msg)).toBe("[引用: 被引用的原文]\n继续");
  });

  it("should extract quoted image as 图片 (no url)", () => {
    const msg = {
      item_list: [{
        type: MessageItemType.TEXT,
        text_item: { text: "这是什么" },
        ref_msg: { message_item: { image_item: {} } },
      }],
    } as WeixinMessage;
    expect(extractMessageText(msg)).toBe("[引用: 图片]\n这是什么");
  });

  it("should extract quoted image url when present", () => {
    const msg = {
      item_list: [{
        type: MessageItemType.TEXT,
        text_item: { text: "这是什么" },
        ref_msg: { message_item: { image_item: { url: "https://cdn/img.jpg" } } },
      }],
    } as WeixinMessage;
    expect(extractMessageText(msg)).toBe("[引用: https://cdn/img.jpg]\n这是什么");
  });

  it("should extract quoted file name", () => {
    const msg = {
      item_list: [{
        type: MessageItemType.TEXT,
        text_item: { text: "看看" },
        ref_msg: { message_item: { file_item: { file_name: "报告.pdf" } } },
      }],
    } as WeixinMessage;
    expect(extractMessageText(msg)).toBe("[引用: 报告.pdf]\n看看");
  });

  it("should extract voice message with playtime", () => {
    const msg = {
      item_list: [{
        type: MessageItemType.VOICE,
        voice_item: { text: "语音内容", playtime: 5 },
      }],
    } as WeixinMessage;
    expect(extractMessageText(msg)).toBe("🎤 [语音转文字（5秒）]: 语音内容");
  });

  it("should extract voice message without playtime", () => {
    const msg = {
      item_list: [{
        type: MessageItemType.VOICE,
        voice_item: { text: "语音内容" },
      }],
    } as WeixinMessage;
    expect(extractMessageText(msg)).toBe("🎤 [语音转文字]: 语音内容");
  });

  it("should extract image message with cdn_url and dimensions", () => {
    const msg = {
      item_list: [{
        type: MessageItemType.IMAGE,
        image_item: { cdn_url: "https://cdn/img.jpg", width: 800, height: 600 },
      }],
    } as WeixinMessage;
    expect(extractMessageText(msg)).toBe("🖼️ [图片800x600]: https://cdn/img.jpg");
  });

  it("should extract image message using url fallback", () => {
    const msg = {
      item_list: [{
        type: MessageItemType.IMAGE,
        image_item: { url: "https://cdn/img.jpg" },
      }],
    } as WeixinMessage;
    expect(extractMessageText(msg)).toBe("🖼️ [图片]: https://cdn/img.jpg");
  });

  it("should extract file message with formatted size", () => {
    const msg = {
      item_list: [{
        type: MessageItemType.FILE,
        file_item: { file_name: "文档.docx", file_size: 2048 },
      }],
    } as WeixinMessage;
    expect(extractMessageText(msg)).toBe("📎 [文件2.0KB]: 文档.docx");
  });

  it("should extract video message with duration", () => {
    const msg = {
      item_list: [{
        type: MessageItemType.VIDEO,
        video_item: { cdn_url: "https://cdn/video.mp4", duration: 90 },
      }],
    } as WeixinMessage;
    expect(extractMessageText(msg)).toBe("🎬 [视频1:30]: https://cdn/video.mp4");
  });

  it("should handle unknown item type with text extraction", () => {
    const msg = {
      item_list: [{ text_item: { text: "未知类型但有文本" } }],
    } as WeixinMessage;
    expect(extractMessageText(msg)).toBe("未知类型但有文本");
  });

  it("should join multiple items with newline", () => {
    const msg = {
      item_list: [
        { type: MessageItemType.TEXT, text_item: { text: "第一段" } },
        { type: MessageItemType.TEXT, text_item: { text: "第二段" } },
      ],
    } as WeixinMessage;
    expect(extractMessageText(msg)).toBe("第一段\n第二段");
  });
});

describe("sendTextChunked", () => {
  const creds = { botToken: "token", baseUrl: "https://ilinkai.weixin.qq.com", userId: "user" } as any;

  function mockFetchSuccess() {
    const fn = vi.fn(async (_url: string | URL | Request) =>
      new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("should send single message when text fits within maxLength", async () => {
    const fetchMock = mockFetchSuccess();
    const sent = await sendTextChunked(creds, "to_user", "token", "短消息", 4000);
    expect(sent).toBe(1);
    // 1 sendmessage + 可能的 retry；至少 1 次 sendmessage 调用
    const sendCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("sendmessage"));
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("should chunk long text into multiple messages", async () => {
    const fetchMock = mockFetchSuccess();
    const longText = "a".repeat(10000);
    const sent = await sendTextChunked(creds, "to_user", "token", longText, 4000);
    // 10000 / 4000 = 3 chunks
    expect(sent).toBe(3);
    const sendCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("sendmessage"));
    expect(sendCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("should still send remaining chunks when one chunk fails", async () => {
    const fn = vi.fn(async (url: string | URL | Request) => {
      const calls = fn.mock.calls.filter(([u]) => String(u).includes("sendmessage"));
      if (String(url).includes("sendmessage")) {
        // 让第二个 chunk 的两次尝试（含 withRetry 1 次重试）都失败，其余成功
        if (calls.length === 2 || calls.length === 3) {
          return new Response("error", { status: 500 });
        }
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fn);

    const sent = await sendTextChunked(creds, "to_user", "token", "a".repeat(10000), 4000);
    // 3 chunks，1 个失败（含重试 2 次），2 个成功
    expect(sent).toBe(2);
  });
});