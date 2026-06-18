// MD5 (RFC 1321) — 纯 JS 实现，兼容 Cloudflare Workers（无 node:crypto）
// 参考 Joseph Myers 公开实现，适配 Uint8Array

const ADD32 = (a: number, b: number) => (a + b) | 0;
const ROL = (x: number, n: number) => (x << n) | (x >>> (32 - n));
const F = (x: number, y: number, z: number) => (x & y) | (~x & z);
const G = (x: number, y: number, z: number) => (x & z) | (y & ~z);
const H = (x: number, y: number, z: number) => x ^ y ^ z;
const I = (x: number, y: number, z: number) => y ^ (x | ~z);

// 每轮 16 步的移位常量
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

/**
 * 计算 MD5 摘要（hex 字符串）
 * @param data ArrayBuffer 或 Uint8Array
 */
export function md5Hex(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const len = bytes.length;

  // 填充：append 0x80 + 0x00 * (padding) + 8 字节长度（小端）
  // 需要 len + 1 (0x80) + 8 (length) 字节，向上对齐到 64 字节
  const padLen = ((len + 9 + 63) >>> 6) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[len] = 0x80;
  const bitLenLow = (len * 8) >>> 0;
  const bitLenHigh = Math.floor(len / 0x20000000) >>> 0;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 8, bitLenLow, true);
  dv.setUint32(padLen - 4, bitLenHigh, true);

  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;

  const M = new Uint32Array(16);
  for (let chunk = 0; chunk < padLen; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      M[i] = dv.getUint32(chunk + i * 4, true);
    }
    let A = a0, B = b0, C = c0, D = d0;

    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = F(B, C, D); g = i; }
      else if (i < 32) { f = G(B, C, D); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = H(B, C, D); g = (3 * i + 5) % 16; }
      else { f = I(B, C, D); g = (7 * i) % 16; }

      f = ADD32(f, A);
      f = ADD32(f, K[i]!);
      f = ADD32(f, M[g]!);
      A = D;
      D = C;
      C = B;
      B = ADD32(B, ROL(f, S[i]!));
    }

    a0 = ADD32(a0, A);
    b0 = ADD32(b0, B);
    c0 = ADD32(c0, C);
    d0 = ADD32(d0, D);
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);

  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += out[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}
