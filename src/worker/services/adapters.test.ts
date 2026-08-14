import { describe, it, expect } from "vitest";
import { getAdapter, parseApiUrl } from "./adapters";
import type { ProviderResponseConfig } from "./adapters";

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

describe("getAdapter", () => {
  describe("built-in adapters", () => {
    it("should return agnes adapter by provider ID", () => {
      const adapter = getAdapter("agnes");
      expect(adapter.id).toBe("agnes");
      expect(adapter.image).toBeDefined();
      expect(adapter.video).toBeDefined();
    });

    it("should return zhipu adapter by provider ID", () => {
      const adapter = getAdapter("zhipu");
      expect(adapter.id).toBe("zhipu");
      expect(adapter.image).toBeDefined();
      expect(adapter.video).toBeDefined();
    });

    it("should return cloudflare adapter (image only, no video)", () => {
      const adapter = getAdapter("cloudflare");
      expect(adapter.id).toBe("cloudflare");
      expect(adapter.image).toBeDefined();
      expect(adapter.video).toBeUndefined();
    });
  });

  describe("auto-detect by baseUrl", () => {
    it("should detect zhipu from bigmodel.cn URL", () => {
      const adapter = getAdapter("custom", "https://open.bigmodel.cn/api/paas/v4/chat/completions");
      expect(adapter.id).toBe("zhipu");
    });

    it("should detect agnes from agnes-ai.com URL", () => {
      const adapter = getAdapter("custom", "https://api.agnes-ai.com/v1/chat/completions");
      expect(adapter.id).toBe("agnes");
    });
  });

  describe("config-based adapter (generic)", () => {
    const imageConfig: ProviderResponseConfig = {
      imageUrlPath: "data.images[0].url",
      imageBase64Path: "data.images[0].b64",
    };

    it("should create image adapter from config", () => {
      const adapter = getAdapter("my_provider", undefined, imageConfig);
      expect(adapter.image).toBeDefined();
      expect(adapter.video).toBeUndefined();
    });

    it("should extract image URL from configured path", () => {
      const adapter = getAdapter("my_provider", undefined, imageConfig);
      const url = adapter.image!.extractImageUrl({ data: { images: [{ url: "https://example.com/img.png" }] } });
      expect(url).toBe("https://example.com/img.png");
    });

    it("should extract image base64 from configured path", () => {
      const adapter = getAdapter("my_provider", undefined, imageConfig);
      const b64 = adapter.image!.extractImageBase64({ data: { images: [{ b64: "base64data" }] } });
      expect(b64).toBe("base64data");
    });
  });

  describe("generic image adapter (fallback)", () => {
    it("should fall back to generic adapter for unknown provider", () => {
      const adapter = getAdapter("unknown_provider");
      expect(adapter.id).toBe("unknown_provider");
      expect(adapter.image).toBeDefined();
      expect(adapter.video).toBeUndefined();
    });

    it("should extract image URL from standard data[0].url path", () => {
      const adapter = getAdapter("unknown_provider");
      const url = adapter.image!.extractImageUrl({ data: [{ url: "https://example.com/img.png" }] });
      expect(url).toBe("https://example.com/img.png");
    });

    it("should extract image base64 from standard data[0].b64_json path", () => {
      const adapter = getAdapter("unknown_provider");
      const b64 = adapter.image!.extractImageBase64({ data: [{ b64_json: "base64data" }] });
      expect(b64).toBe("base64data");
    });

    it("should fallback to common paths when configured path returns nothing", () => {
      const adapter = getAdapter("my_provider", undefined, { imageUrlPath: "data.custom_path" });
      // configured path returns nothing, should fallback to common paths
      const url = adapter.image!.extractImageUrl({ data: [{ url: "https://example.com/fallback.png" }] });
      expect(url).toBe("https://example.com/fallback.png");
    });

    it("should return null when no path matches", () => {
      const adapter = getAdapter("unknown_provider");
      const url = adapter.image!.extractImageUrl({});
      expect(url).toBeNull();
    });

    it("buildBody should include model, prompt, and size fields", () => {
      const adapter = getAdapter("unknown_provider");
      const body = adapter.image!.buildBody("test prompt", "test-model", "1024x1024", []);
      expect(body.model).toBe("test-model");
      expect(body.prompt).toBe("test prompt");
      expect(body.size).toBe("1024x1024");
      expect(body.extra_body.response_format).toBe("url");
    });

    it("buildBody should place single ref image at top_level when configured", () => {
      const adapter = getAdapter("my_provider", undefined, {
        imageUrlPath: "data[0].url", // required to enter config path
        imageRefParam: "image_url",
        imageRefLocation: "top_level",
      });
      const body = adapter.image!.buildBody("prompt", "model", "1024x1024", ["ref1.jpg"]);
      expect(body.image_url).toBe("ref1.jpg");
      expect(body.extra_body.image).toBeUndefined();
    });

    it("buildBody should place multiple ref images in extra_body by default", () => {
      const adapter = getAdapter("unknown_provider");
      const body = adapter.image!.buildBody("prompt", "model", "1024x1024", ["ref1.jpg", "ref2.jpg"]);
      expect(body.extra_body.image).toEqual(["ref1.jpg", "ref2.jpg"]);
    });
  });

  describe("generic video adapter", () => {
    const videoConfig: ProviderResponseConfig = {
      videoSubmitIdPath: "task_id",
      videoSubmitUrlPath: "data.video_url",
      videoCheckPath: "/check?taskId={taskId}",
      videoCheckStatusPath: "task_status",
      videoCheckCompleted: "DONE",
      videoCheckProcessing: "RUNNING",
      videoCheckFailed: "ERROR",
    };

    it("should create video adapter from config", () => {
      const adapter = getAdapter("my_provider", undefined, videoConfig);
      expect(adapter.video).toBeDefined();
      expect(adapter.image).toBeUndefined();
    });

    it("buildSubmitBody should include model and prompt", () => {
      const adapter = getAdapter("my_provider", undefined, videoConfig);
      const { url, body } = adapter.video!.buildSubmitBody("video prompt", "video-model");
      expect(body.model).toBe("video-model");
      expect(body.prompt).toBe("video prompt");
    });

    it("extractTaskId should use configured path", () => {
      const adapter = getAdapter("my_provider", undefined, videoConfig);
      const id = adapter.video!.extractTaskId({ task_id: "task_123" });
      expect(id).toBe("task_123");
    });

    it("buildCheckRequest should use configured template", () => {
      const adapter = getAdapter("my_provider", undefined, videoConfig);
      const req = adapter.video!.buildCheckRequest("task_123", "https://api.example.com/v1/chat/completions", "key_abc");
      expect(req.url).toContain("/check?taskId=task_123");
      expect(req.headers.Authorization).toBe("Bearer key_abc");
    });

    it("buildCheckRequest should fallback to default path when no template", () => {
      const adapter = getAdapter("my_provider", undefined, { videoSubmitIdPath: "task_id" });
      const req = adapter.video!.buildCheckRequest("task_123", "https://api.example.com/v1/chat/completions", "key_abc");
      expect(req.url).toBe("https://api.example.com/v1/videos/task_123");
    });

    it("extractStatus should return completed for configured value", () => {
      const adapter = getAdapter("my_provider", undefined, videoConfig);
      expect(adapter.video!.extractStatus({ task_status: "DONE" })).toBe("completed");
      expect(adapter.video!.extractStatus({ task_status: "RUNNING" })).toBe("processing");
      expect(adapter.video!.extractStatus({ task_status: "ERROR" })).toBe("failed");
    });

    it("extractStatus should also accept standard values", () => {
      const adapter = getAdapter("my_provider", undefined, videoConfig);
      expect(adapter.video!.extractStatus({ task_status: "completed" })).toBe("completed");
      expect(adapter.video!.extractStatus({ task_status: "processing" })).toBe("processing");
      expect(adapter.video!.extractStatus({ task_status: "failed" })).toBe("failed");
    });

    it("extractStatus should return null for unknown status", () => {
      const adapter = getAdapter("my_provider", undefined, videoConfig);
      expect(adapter.video!.extractStatus({ task_status: "UNKNOWN" })).toBeNull();
    });
  });

  describe("built-in adapter details", () => {
    it("agnes image adapter should extract URL from data[0].url", () => {
      const adapter = getAdapter("agnes");
      const url = adapter.image!.extractImageUrl({ data: [{ url: "https://agnes.com/img.png" }] });
      expect(url).toBe("https://agnes.com/img.png");
    });

    it("zhipu video adapter should use /videos/generations submit path", () => {
      const adapter = getAdapter("zhipu");
      const { url } = adapter.video!.buildSubmitBody("prompt", "model");
      expect(url).toBe("/videos/generations");
    });

    it("zhipu video adapter should use async-result check path", () => {
      const adapter = getAdapter("zhipu");
      const req = adapter.video!.buildCheckRequest("task_123", "https://open.bigmodel.cn/api/paas/v4/chat/completions", "key");
      expect(req.url).toContain("/async-result/task_123");
    });

    it("zhipu video adapter should extract status from task_status", () => {
      const adapter = getAdapter("zhipu");
      expect(adapter.video!.extractStatus({ task_status: "SUCCESS" })).toBe("completed");
      expect(adapter.video!.extractStatus({ task_status: "PROCESSING" })).toBe("processing");
      expect(adapter.video!.extractStatus({ task_status: "FAIL" })).toBe("failed");
    });

    it("agnes video adapter should use agnesapi check path", () => {
      const adapter = getAdapter("agnes");
      const req = adapter.video!.buildCheckRequest("vid_123", "https://api.agnes-ai.com/v1", "key");
      expect(req.url).toContain("/agnesapi?video_id=vid_123");
    });

    it("cloudflare adapter should extract base64 from response.image", () => {
      const adapter = getAdapter("cloudflare");
      const b64 = adapter.image!.extractImageBase64({ image: "base64data" });
      expect(b64).toBe("base64data");
    });
  });
});