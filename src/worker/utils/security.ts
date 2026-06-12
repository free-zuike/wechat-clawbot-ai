// 安全工具 - 速率限制 + IP 白名单
// 优化：ratelimit 从 KV 迁移到 Upstash Redis

import { Logger } from "./error";
import { getUpstashService } from "../services/upstash";
import type { Env } from "../index";

// ========== 配置 ==========

interface RateLimitConfig {
  windowMs: number;      // 时间窗口（毫秒）
  maxRequests: number;    // 窗口内最大请求数
  keyPrefix: string;      // Redis key 前缀
  enabled: boolean;       // 是否启用
}

// 默认配置
const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  // 全局限流：10 秒内最多 100 次请求
  global: {
    windowMs: 10 * 1000,
    maxRequests: 100,
    keyPrefix: "ratelimit:global:",
    enabled: true,
  },
  // 每 IP：1 分钟内最多 60 次
  ip: {
    windowMs: 60 * 1000,
    maxRequests: 60,
    keyPrefix: "ratelimit:ip:",
    enabled: true,
  },
  // 登录接口：5 分钟内最多 10 次
  login: {
    windowMs: 5 * 60 * 1000,
    maxRequests: 10,
    keyPrefix: "ratelimit:login:",
    enabled: true,
  },
  // 扫码接口：1 分钟内最多 5 次
  qrcode: {
    windowMs: 60 * 1000,
    maxRequests: 5,
    keyPrefix: "ratelimit:qrcode:",
    enabled: true,
  },
  // 发送消息：1 分钟内最多 30 次
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

  // 检查请求是否超过限制
  async check(env: Env, identifier: string): Promise<{ allowed: boolean; remaining: number; resetMs: number }> {
    if (!this.config.enabled) {
      return { allowed: true, remaining: this.config.maxRequests, resetMs: 0 };
    }

    const upstash = getUpstashService(env);
    const key = `${this.config.keyPrefix}${identifier}`;
    const windowSec = Math.ceil(this.config.windowMs / 1000);

    try {
      // 使用 INCR + EXPIRE 实现滑动窗口
      const count = await upstash.incr(key, windowSec);

      // TTL 返回剩余过期时间（秒）
      const ttl = await upstash.ttl(key);
      const resetMs = ttl > 0 ? ttl * 1000 : this.config.windowMs;

      const allowed = count <= this.config.maxRequests;
      const remaining = Math.max(0, this.config.maxRequests - count);

      if (!allowed) {
        Logger.warn("[RateLimit] Rate limit exceeded", {
          key,
          count,
          max: this.config.maxRequests,
        });
      }

      return { allowed, remaining, resetMs };
    } catch (e) {
      // 如果 Upstash 不可用，降级为允许（保守策略）
      Logger.warn("[RateLimit] Check failed, allowing", { key, error: (e as Error).message });
      return { allowed: true, remaining: 0, resetMs: 0 };
    }
  }

  // 重置限制计数
  async reset(env: Env, identifier: string): Promise<void> {
    const upstash = getUpstashService(env);
    const key = `${this.config.keyPrefix}${identifier}`;
    await upstash.del(key);
  }
}

// 导出各个限制器工厂
export function createRateLimiter(type: keyof typeof DEFAULT_LIMITS): RateLimiter {
  return new RateLimiter(DEFAULT_LIMITS[type]);
}

// 预创建的限制器实例
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

// 从请求中提取客户端标识
export function getClientIdentifier(request: Request): string {
  // 优先使用真实 IP（通过 CF-Connecting-IP 头）
  const ip = request.headers.get("CF-Connecting-IP") ||
             request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
             request.headers.get("X-Real-IP") ||
             "unknown";

  // 清理并截断
  return ip.replace(/[^a-zA-Z0-9.:_-]/g, "").slice(0, 50);
}

// 应用速率限制（返回 429 响应或 null）
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

// 获取限制信息（用于调试或显示）
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
