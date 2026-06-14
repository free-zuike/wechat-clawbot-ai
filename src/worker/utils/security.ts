// 安全工具 - 速率限制 + IP 白名单
// 使用 Cloudflare KV 实现速率限制

import { Logger } from "./error";
import type { Env } from "../index";

// ========== 配置 ==========

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
  enabled: boolean;
}

const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  global: {
    windowMs: 10 * 1000,
    maxRequests: 100,
    keyPrefix: "ratelimit:global:",
    enabled: true,
  },
  ip: {
    windowMs: 60 * 1000,
    maxRequests: 60,
    keyPrefix: "ratelimit:ip:",
    enabled: true,
  },
  login: {
    windowMs: 5 * 60 * 1000,
    maxRequests: 10,
    keyPrefix: "ratelimit:login:",
    enabled: true,
  },
  qrcode: {
    windowMs: 60 * 1000,
    maxRequests: 5,
    keyPrefix: "ratelimit:qrcode:",
    enabled: true,
  },
  send: {
    windowMs: 60 * 1000,
    maxRequests: 30,
    keyPrefix: "ratelimit:send:",
    enabled: true,
  },
};

// ========== 速率限制器 ==========

export class RateLimiter {
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  async check(env: Env, identifier: string): Promise<{ allowed: boolean; remaining: number; resetMs: number }> {
    if (!this.config.enabled) {
      return { allowed: true, remaining: this.config.maxRequests, resetMs: 0 };
    }

    const key = `${this.config.keyPrefix}${identifier}`;

    try {
      const existing = await env.CLAWBOT_KV.get(key, { type: "json" }) as { count: number; resetAt: number } | null;
      const now = Date.now();

      if (!existing || now > existing.resetAt) {
        // 新窗口或已过期
        const resetAt = now + this.config.windowMs;
        await env.CLAWBOT_KV.put(key, JSON.stringify({ count: 1, resetAt }), {
          expirationTtl: Math.ceil(this.config.windowMs / 1000) + 10,
        });
        return { allowed: true, remaining: this.config.maxRequests - 1, resetMs: this.config.windowMs };
      }

      if (existing.count >= this.config.maxRequests) {
        const resetMs = existing.resetAt - now;
        Logger.warn("[RateLimit] Rate limit exceeded", { key, count: existing.count, max: this.config.maxRequests });
        return { allowed: false, remaining: 0, resetMs };
      }

      // 增加计数（非原子操作，KV 场景下可接受）
      existing.count += 1;
      await env.CLAWBOT_KV.put(key, JSON.stringify(existing), {
        expirationTtl: Math.ceil((existing.resetAt - now) / 1000) + 10,
      });
      return { allowed: true, remaining: this.config.maxRequests - existing.count, resetMs: existing.resetAt - now };
    } catch (e) {
      // KV 不可用时放行
      Logger.warn("[RateLimit] Check failed, allowing", { key, error: (e as Error).message });
      return { allowed: true, remaining: 0, resetMs: 0 };
    }
  }

  async reset(env: Env, identifier: string): Promise<void> {
    const key = `${this.config.keyPrefix}${identifier}`;
    await env.CLAWBOT_KV.delete(key);
  }
}

export function createRateLimiter(type: keyof typeof DEFAULT_LIMITS): RateLimiter {
  return new RateLimiter(DEFAULT_LIMITS[type]);
}

export const rateLimiters = {
  global: createRateLimiter("global"),
  ip: createRateLimiter("ip"),
  login: createRateLimiter("login"),
  qrcode: createRateLimiter("qrcode"),
  send: createRateLimiter("send"),
};

// ========== 速率限制中间件 ==========

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  retryAfterMs?: number;
}

export function getClientIdentifier(request: Request): string {
  const ip = request.headers.get("CF-Connecting-IP") ||
             request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
             request.headers.get("X-Real-IP") ||
             "unknown";
  return ip.replace(/[^a-zA-Z0-9.:_-]/g, "").slice(0, 50);
}

export async function applyRateLimit(
  request: Request,
  env: Env,
  type: keyof typeof DEFAULT_LIMITS = "ip"
): Promise<Response | null> {
  const limiter = rateLimiters[type];
  const identifier = getClientIdentifier(request);
  const result = await limiter.check(env, identifier);

  if (!result.allowed) {
    return new Response(JSON.stringify({
      error: "请求过于频繁，请稍后再试",
      retryAfterMs: result.resetMs,
    }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": Math.ceil(result.resetMs / 1000).toString(),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": Math.ceil((Date.now() + result.resetMs) / 1000).toString(),
      },
    });
  }

  return null;
}

export async function getRateLimitInfo(
  request: Request,
  env: Env,
  type: keyof typeof DEFAULT_LIMITS = "ip"
): Promise<RateLimitResult> {
  const limiter = rateLimiters[type];
  const identifier = getClientIdentifier(request);
  return limiter.check(env, identifier);
}

// ========== IP 白名单 ==========

const ADMIN_IPS = new Set<string>();
const ALLOWED_PATHS = new Set(["/", "/qrcode", "/health", "/api/health", "/api/qrcode", "/api/qrcode/status"]);

export function isAdminIP(ip: string): boolean {
  return ADMIN_IPS.has(ip);
}

export function addAdminIP(ip: string): void {
  ADMIN_IPS.add(ip);
}

export function removeAdminIP(ip: string): void {
  ADMIN_IPS.delete(ip);
}

export function isPublicPath(path: string): boolean {
  return ALLOWED_PATHS.has(path);
}
