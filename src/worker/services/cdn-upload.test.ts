import { describe, it, expect, vi, afterEach } from "vitest";
import {
  UploadMediaType,
  aesEcbPaddedSize,
  encryptAesEcb,
  generateAesKeyHex,
  generateFilekeyHex,
  hexToBase64,
  getUploadUrl,
  getSimpleUploadUrl,
  uploadFileSimple,
  uploadEncryptedToCdn,
  uploadMediaToCdn,
} from "./cdn-upload";
import type { ILinkCredentials } from "../types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const creds: ILinkCredentials = {
  botToken: "test-bot-token",
  baseUrl: "https://ilinkai.weixin.qq.com",
  userId: "test-user",
} as ILinkCredentials;

// Uint8Array → hex string（不用 Buffer，保持 Workers 环境兼容）
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

describe("UploadMediaType", () => {
  it("should map IMAGE=1 VIDEO=2 FILE=3 VOICE=4", () => {
    expect(UploadMediaType).toEqual({ IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 });
  });
});

describe("aesEcbPaddedSize", () => {
  it("should pad to 16-byte multiple", () => {
    expect(aesEcbPaddedSize(0)).toBe(16);
    expect(aesEcbPaddedSize(15)).toBe(16);
    expect(aesEcbPaddedSize(16)).toBe(32);
    expect(aesEcbPaddedSize(100)).toBe(112);
    expect(aesEcbPaddedSize(16 * 10)).toBe(176);
  });
});

describe("hexToBase64", () => {
  it("should convert hex string to base64", () => {
    expect(hexToBase64("41424344")).toBe("QUJDRA=="); // "ABCD"
  });

  it("should convert empty hex to empty base64", () => {
    expect(hexToBase64("")).toBe("");
  });

  it("should handle 16-byte key hex", () => {
    const hex = "00112233445566778899aabbccddeeff";
    const result = hexToBase64(hex);
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(20);
  });
});

describe("generateAesKeyHex / generateFilekeyHex", () => {
  it("should generate 32-char hex keys (16 bytes)", () => {
    const key = generateAesKeyHex();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("should generate different keys on each call", () => {
    const k1 = generateAesKeyHex();
    const k2 = generateAesKeyHex();
    expect(k1).not.toBe(k2);
  });

  it("filekey should be 32-char hex too", () => {
    const key = generateFilekeyHex();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("encryptAesEcb", () => {
  it("should throw on invalid key length", async () => {
    await expect(encryptAesEcb(new Uint8Array(16), "abc")).rejects.toThrow("AES-128 key must be 32 hex chars");
  });

  it("should produce ciphertext padded to 16-byte multiple", async () => {
    const key = generateAesKeyHex();
    const plaintext = new Uint8Array(100); // 100 bytes → padded to 112
    const ciphertext = await encryptAesEcb(plaintext, key);
    expect(ciphertext.length % 16).toBe(0);
    expect(ciphertext.length).toBe(112);
  });

  it("should be deterministic for same input", async () => {
    const key = generateAesKeyHex();
    const plaintext = new TextEncoder().encode("hello world");
    const c1 = await encryptAesEcb(plaintext, key);
    const c2 = await encryptAesEcb(plaintext, key);
    expect(bytesToHex(c1)).toBe(bytesToHex(c2));
  });

  it("should produce different ciphertext for different keys", async () => {
    const k1 = generateAesKeyHex();
    const k2 = generateAesKeyHex();
    const plaintext = new TextEncoder().encode("same data");
    const c1 = await encryptAesEcb(plaintext, k1);
    const c2 = await encryptAesEcb(plaintext, k2);
    expect(bytesToHex(c1)).not.toBe(bytesToHex(c2));
  });
});

describe("getUploadUrl", () => {
  const req = {
    filekey: "a".repeat(32),
    media_type: UploadMediaType.IMAGE,
    to_user_id: "target-user",
    rawsize: 100,
    rawfilemd5: "d41d8cd98f00b204e9800998ecf8427e",
    filesize: 112,
    no_need_thumb: true,
    aeskey: "b".repeat(32),
  };

  function stubFetchWithJson(body: any) {
    const fn = vi.fn(async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("should return uploadFullUrl from upload_full_url field", async () => {
    stubFetchWithJson({ upload_full_url: "https://cdn.example.com/upload?param=abc" });
    const result = await getUploadUrl(creds, req);
    expect(result.uploadFullUrl).toBe("https://cdn.example.com/upload?param=abc");
    expect(result.thumbUploadParam).toBeUndefined();
  });

  it("should accept uploadUrl / upload_url / upload_param variants", async () => {
    for (const [field, value] of [
      ["uploadUrl", "https://cdn.example.com/upload"],
      ["upload_url", "https://cdn.example.com/upload"],
      ["upload_param", "UPLOAD_PARAM_STRING"],
      ["cdn_upload_url", "https://cdn.example.com/upload"],
    ] as const) {
      stubFetchWithJson({ [field]: value });
      const result = await getUploadUrl(creds, req);
      expect(result.uploadFullUrl).toBe(value);
    }
  });

  it("should throw on errcode !== 0", async () => {
    stubFetchWithJson({ errcode: 4002, errmsg: "bad request" });
    await expect(getUploadUrl(creds, req)).rejects.toThrow("getuploadurl error");
  });

  it("should throw on ret !== 0", async () => {
    stubFetchWithJson({ ret: -1 });
    await expect(getUploadUrl(creds, req)).rejects.toThrow("getuploadurl ret");
  });

  it("should throw when upload_full_url missing", async () => {
    stubFetchWithJson({ data: { other_field: "x" } });
    await expect(getUploadUrl(creds, req)).rejects.toThrow("missing upload_full_url");
  });

  it("should extract thumb upload param", async () => {
    stubFetchWithJson({
      upload_full_url: "https://cdn.example.com/upload",
      thumb_upload_param: "THUMB_PARAM",
      thumb_size: 100,
      thumb_width: 80,
      thumb_height: 80,
    });
    const result = await getUploadUrl(creds, req);
    expect(result.thumbUploadParam).toBe("THUMB_PARAM");
    expect(result.thumbSize).toBe(100);
    expect(result.thumbWidth).toBe(80);
    expect(result.thumbHeight).toBe(80);
  });
});

describe("getSimpleUploadUrl", () => {
  function stubFetchWithJson(body: any) {
    const fn = vi.fn(async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("should return upload_url and cdn_url", async () => {
    stubFetchWithJson({ upload_url: "https://cdn.example.com/put", cdn_url: "https://cdn.example.com/get" });
    const result = await getSimpleUploadUrl(creds, "a.png", "image", 100);
    expect(result).toEqual({ upload_url: "https://cdn.example.com/put", cdn_url: "https://cdn.example.com/get" });
  });

  it("should fallback cdn_url to upload_url", async () => {
    stubFetchWithJson({ upload_url: "https://cdn.example.com/put" });
    const result = await getSimpleUploadUrl(creds, "a.png", "image", 100);
    expect(result.cdn_url).toBe("https://cdn.example.com/put");
  });

  it("should accept uploadUrl / upload_full_url variants", async () => {
    stubFetchWithJson({ uploadUrl: "https://cdn.example.com/put" });
    const result = await getSimpleUploadUrl(creds, "a.png", "image", 100);
    expect(result.upload_url).toBe("https://cdn.example.com/put");
  });

  it("should throw when upload_url missing", async () => {
    stubFetchWithJson({ some: "thing" });
    await expect(getSimpleUploadUrl(creds, "a.png", "image", 100)).rejects.toThrow("missing upload_url");
  });
});

describe("uploadFileSimple", () => {
  it("should PUT file and succeed on 200", async () => {
    const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fn);
    await uploadFileSimple("https://cdn.example.com/put", new Uint8Array([1, 2, 3]), "image/png");
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe("https://cdn.example.com/put");
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toEqual({ "Content-Type": "image/png" });
  });

  it("should throw on non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("fail", { status: 500 })));
    await expect(uploadFileSimple("https://cdn.example.com/put", new Uint8Array(4))).rejects.toThrow("Upload failed");
  });
});

describe("uploadEncryptedToCdn", () => {
  function stubFetchWithResponse(resp: Response) {
    const fn = vi.fn(async () => resp);
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("should return x-encrypted-param header", async () => {
    const headers = new Headers({ "x-encrypted-param": "DOWNLOAD_PARAM_ABC" });
    stubFetchWithResponse(new Response("", { status: 200, headers }));
    const result = await uploadEncryptedToCdn("https://cdn.example.com/upload", "filekey", new Uint8Array(16));
    expect(result).toBe("DOWNLOAD_PARAM_ABC");
  });

  it("should fallback to download_param in JSON body", async () => {
    stubFetchWithResponse(
      new Response(JSON.stringify({ download_param: "BODY_PARAM" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const result = await uploadEncryptedToCdn("https://cdn.example.com/upload", "filekey", new Uint8Array(16));
    expect(result).toBe("BODY_PARAM");
  });

  it("should fallback to encrypted_param in JSON body", async () => {
    stubFetchWithResponse(
      new Response(JSON.stringify({ encrypted_param: "BODY_ENC" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const result = await uploadEncryptedToCdn("https://cdn.example.com/upload", "filekey", new Uint8Array(16));
    expect(result).toBe("BODY_ENC");
  });

  it("should fallback to URL query encrypted_query_param", async () => {
    stubFetchWithResponse(new Response("", { status: 200 }));
    const result = await uploadEncryptedToCdn(
      "https://cdn.example.com/upload?encrypted_query_param=FROM_URL", "filekey", new Uint8Array(16)
    );
    expect(result).toBe("FROM_URL");
  });

  it("should throw on HTTP error", async () => {
    stubFetchWithResponse(new Response("error", { status: 500 }));
    await expect(
      uploadEncryptedToCdn("https://cdn.example.com/upload", "filekey", new Uint8Array(16))
    ).rejects.toThrow("CDN upload HTTP 500");
  });

  it("should throw when no param found anywhere", async () => {
    stubFetchWithResponse(new Response("plain text, no params", { status: 200 }));
    await expect(
      uploadEncryptedToCdn("https://cdn.example.com/upload", "filekey", new Uint8Array(16))
    ).rejects.toThrow("no x-encrypted-param");
  });
});

describe("uploadMediaToCdn (full pipeline)", () => {
  it("should complete full upload and return media info", async () => {
    const fileData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

    const fn = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("getuploadurl")) {
        return new Response(JSON.stringify({ upload_full_url: "https://cdn.example.com/upload?encrypted_query_param=UPLOAD" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // CDN upload: return x-encrypted-param
      const headers = new Headers({ "x-encrypted-param": "DOWNLOAD_PARAM" });
      return new Response("", { status: 200, headers });
    });
    vi.stubGlobal("fetch", fn);

    const result = await uploadMediaToCdn(creds, "target-user", fileData, UploadMediaType.IMAGE);

    // 2 fetch calls: getuploadurl + CDN upload
    const getUploadCalls = fn.mock.calls.filter(([u]) => String(u).includes("getuploadurl"));
    const cdnCalls = fn.mock.calls.filter(([u]) => !String(u).includes("getuploadurl"));
    expect(getUploadCalls.length).toBe(1);
    expect(cdnCalls.length).toBe(1);

    expect(result.filekey).toMatch(/^[0-9a-f]{32}$/);
    expect(result.aeskeyHex).toMatch(/^[0-9a-f]{32}$/);
    expect(result.aeskeyBase64).toBeDefined();
    expect(result.fileSize).toBe(16);
    // padded: 16 → ceil(17/16)*16 = 32
    expect(result.fileSizeCiphertext).toBe(32);
    expect(result.downloadEncryptedQueryParam).toBe("DOWNLOAD_PARAM");
    expect(result.thumbSize).toBe(0);
  });
});