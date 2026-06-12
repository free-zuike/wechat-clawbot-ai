// Upstash Redis 服务 - 替代 KV 中需要 TTL 的 key
// 存储: ratelimit、session、qrcode_key
// 支持: HTTP REST API，兼容 Cloudflare Workers

import { Logger } from "../utils/error";

// Upstash REST API 客户端（无需 SDK，通过 fetch 调用）
export class UpstashService {
  private url: string;
  private token: string;
  private available: boolean = false;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
    this.available = !!(url && token);
  }

  // 检查是否可用
  isAvailable(): boolean {
    return this.available;
  }

  // SET key value [EX seconds] [NX|XX]
  async set(key: string, value: string, options: { ex?: number; nx?: boolean; xx?: boolean } = {}): Promise<boolean> {
    if (!this.available) return false;

    const body: any = { key, value };
    if (options.ex) body["EX"] = options.ex;
    if (options.nx) body["NX"] = true;
    if (options.xx) body["XX"] = true;

    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(["SET", key, value, ...(options.ex ? ["EX", options.ex] : []), ...(options.nx ? ["NX"] : []), ...(options.xx ? ["XX"] : [])]),
      });
      const data = await res.json() as any;
      return data["OK"] || data["result"] === "OK" || data["result"] === "SET";
    } catch (e) {
      Logger.warn("[Upstash] SET failed", { key, error: (e as Error).message });
      return false;
    }
  }

  // GET key
  async get(key: string): Promise<string | null> {
    if (!this.available) return null;

    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(["GET", key]),
      });
      const data = await res.json() as any;
      if (data["null"]) return null;
      return data["result"] || null;
    } catch (e) {
      Logger.warn("[Upstash] GET failed", { key, error: (e as Error).message });
      return null;
    }
  }

  // DEL key
  async del(key: string): Promise<boolean> {
    if (!this.available) return false;

    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(["DEL", key]),
      });
      return res.ok;
    } catch (e) {
      Logger.warn("[Upstash] DEL failed", { key, error: (e as Error).message });
      return false;
    }
  }

  // INCR key（用于限流计数）
  async incr(key: string, expireSeconds?: number): Promise<number> {
    if (!this.available) return 1;

    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(["INCR", key]),
      });
      const data = await res.json() as any;
      const count = Number(data["result"]) || 1;

      // 如果设置了过期时间且计数器是新创建的，设置过期
      if (expireSeconds && count === 1) {
        await this.expire(key, expireSeconds);
      }

      return count;
    } catch (e) {
      Logger.warn("[Upstash] INCR failed", { key, error: (e as Error).message });
      return 1;
    }
  }

  // EXPIRE key seconds
  async expire(key: string, seconds: number): Promise<boolean> {
    if (!this.available) return false;

    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(["EXPIRE", key, seconds]),
      });
      const data = await res.json() as any;
      return data["result"] === 1;
    } catch (e) {
      Logger.warn("[Upstash] EXPIRE failed", { key, error: (e as Error).message });
      return false;
    }
  }

  // TTL key
  async ttl(key: string): Promise<number> {
    if (!this.available) return -2;

    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(["TTL", key]),
      });
      const data = await res.json() as any;
      return Number(data["result"]) || -2;
    } catch (e) {
      return -2;
    }
  }
}

// 全局单例（延迟初始化）
let _upstash: UpstashService | null = null;

export function getUpstashService(env: any): UpstashService {
  if (!_upstash) {
    const url = env.UPSTASH_REDIS_REST_URL || "";
    const token = env.UPSTASH_REDIS_REST_TOKEN || "";
    _upstash = new UpstashService(url, token);

    if (!_upstash.isAvailable()) {
      Logger.warn("[Upstash] Not configured - UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN is missing");
    } else {
      Logger.info("[Upstash] Service initialized");
    }
  }
  return _upstash;
}
