// 安全工具 - 速率限制（内存实现，不消耗KV写入配额）

import { Logger } from "./error";
import type { Env } from "../index";

// ========== 内存限流器 ==========

interface WindowEntry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, WindowEntry>();

// 定期清理过期条目（利用每次请求触发）
function gcWindows(now: number): void {
  if (buckets.size > 1000) {
    for (const [k, v] of buckets) {
      if (now > v.resetAt) buckets.delete(k);
    }
  }
}

function checkWindow(key: string, windowMs: number, maxRequests: number): { allowed: boolean; remaining: number; resetMs: number } {
  const now = Date.now();
  gcWindows(now);

  const existing = buckets.get(key);

  if (!existing || now > existing.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, resetMs: windowMs };
  }

  if (existing.count >= maxRequests) {
    return { allowed: false, remaining: 0, resetMs: existing.resetAt - now };
  }

  existing.count += 1;
  return { allowed: true, remaining: maxRequests - existing.count, resetMs: existing.resetAt - now };
}

// ========== 速率限制配置 ==========

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  enabled: boolean;
}

const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  global: { windowMs: 10_000, maxRequests: 100, enabled: true },
  ip: { windowMs: 60_000, maxRequests: 60, enabled: true },
  login: { windowMs: 5 * 60_000, maxRequests: 10, enabled: true },
  qrcode: { windowMs: 60_000, maxRequests: 5, enabled: true },
  send: { windowMs: 60_000, maxRequests: 30, enabled: true },
};

export class RateLimiter {
  private config: RateLimitConfig;
  private name: string;

  constructor(name: string, config: RateLimitConfig) {
    this.name = name;
    this.config = config;
  }

  check(_env: Env, identifier: string): { allowed: boolean; remaining: number; resetMs: number } {
    if (!this.config.enabled) {
      return { allowed: true, remaining: this.config.maxRequests, resetMs: 0 };
    }
    return checkWindow(`${this.name}:${identifier}`, this.config.windowMs, this.config.maxRequests);
  }

  reset(_env: Env, identifier: string): void {
    buckets.delete(`${this.name}:${identifier}`);
  }
}

export function createRateLimiter(name: string, type: keyof typeof DEFAULT_LIMITS): RateLimiter {
  return new RateLimiter(name, DEFAULT_LIMITS[type]);
}

export const rateLimiters = {
  global: createRateLimiter("global", "global"),
  ip: createRateLimiter("ip", "ip"),
  login: createRateLimiter("login", "login"),
  qrcode: createRateLimiter("qrcode", "qrcode"),
  send: createRateLimiter("send", "send"),
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
  const result = limiter.check(env, identifier);

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
