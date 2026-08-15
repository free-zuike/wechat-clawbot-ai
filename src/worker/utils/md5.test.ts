import { describe, it, expect } from "vitest";
import { md5Hex } from "./md5";

// 标准 MD5 测试向量（RFC 1321）
const VECTORS: Array<[string, string]> = [
  ["", "d41d8cd98f00b204e9800998ecf8427e"],
  ["a", "0cc175b9c0f1b6a831c399e269772661"],
  ["abc", "900150983cd24fb0d6963f7d28e17f72"],
  ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
  ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
  ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
  ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", "57edf4a22be3c955ac49da2e2107b67a"],
];

describe("md5Hex", () => {
  it("should match RFC 1321 test vectors", () => {
    for (const [input, expected] of VECTORS) {
      expect(md5Hex(new TextEncoder().encode(input))).toBe(expected);
    }
  });

  it("should accept plain string input via TextEncoder path", () => {
    // md5Hex 接受 ArrayBuffer 或 Uint8Array
    const bytes = new TextEncoder().encode("hello");
    expect(md5Hex(bytes)).toBe("5d41402abc4b2a76b9719d911017c592");
  });

  it("should accept ArrayBuffer input", () => {
    const buf = new TextEncoder().encode("abc").buffer;
    expect(md5Hex(buf)).toBe("900150983cd24fb0d6963f7d28e17f72");
  });

  it("should handle binary data (non-ASCII bytes)", () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x7f]);
    const result = md5Hex(bytes);
    expect(result).toMatch(/^[0-9a-f]{32}$/);
    // 结果应稳定
    expect(md5Hex(bytes)).toBe(result);
  });
});