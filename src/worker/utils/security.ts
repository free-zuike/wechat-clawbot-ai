// 安全性工具：输入验证、请求频率限制、敏感信息处理

import { ClawBotError, Logger } from "./error";

// ========== 输入验证 ==========
export const Validator = {
  required(value: unknown, fieldName: string): void {
    if (value === undefined || value === null || value === "") {
      throw new ClawBotError('VALIDATION_ERROR', `${fieldName} 是必填项`, 400);
    }
  },

  string(value: unknown, fieldName: string): void {
    if (typeof value !== 'string') {
      throw new ClawBotError('VALIDATION_ERROR', `${fieldName} 必须是字符串`, 400);
    }
  },

  number(value: unknown, fieldName: string): void {
    if (typeof value !== 'number' || isNaN(value)) {
      throw new ClawBotError('VALIDATION_ERROR', `${fieldName} 必须是数字`, 400);
    }
  },

  boolean(value: unknown, fieldName: string): void {
    if (typeof value !== 'boolean') {
      throw new ClawBotError('VALIDATION_ERROR', `${fieldName} 必须是布尔值`, 400);
    }
  },

  email(value: string, fieldName: string): void {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(value)) {
      throw new ClawBotError('VALIDATION_ERROR', `${fieldName} 格式不正确`, 400);
    }
  },

  url(value: string, fieldName: string): void {
    try {
      new URL(value);
    } catch {
      throw new ClawBotError('VALIDATION_ERROR', `${fieldName} 不是有效的URL`, 400);
    }
  },

  length(value: string, fieldName: string, min: number, max: number): void {
    if (value.length < min || value.length > max) {
      throw new ClawBotError('VALIDATION_ERROR', `${fieldName} 长度必须在 ${min}-${max} 之间`, 400);
    }
  },

  inArray(value: unknown, fieldName: string, allowed: unknown[]): void {
    if (!allowed.includes(value)) {
      throw new ClawBotError('VALIDATION_ERROR', `${fieldName} 必须是 ${allowed.join(', ')} 之一`, 400);
    }
  },

  regex(value: string, fieldName: string, pattern: RegExp, message: string): void {
    if (!pattern.test(value)) {
      throw new ClawBotError('VALIDATION_ERROR', `${fieldName} ${message}`, 400);
    }
  }
};

// ========== 请求频率限制 ==========
interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyGenerator: (request: Request) => string;
}

interface RateLimitState {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private config: RateLimitConfig;
  private kv: KVNamespace;

  constructor(kv: KVNamespace, config: RateLimitConfig) {
    this.kv = kv;
    this.config = config;
  }

  async check(request: Request): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const key = this.config.keyGenerator(request);
    const now = Date.now();
    const stateKey = `ratelimit:${key}`;

    try {
      const stored = await this.kv.get(stateKey);
      let state: RateLimitState;

      if (stored) {
        state = JSON.parse(stored);
      } else {
        state = { count: 0, resetAt: now + this.config.windowMs };
      }

      if (now >= state.resetAt) {
        state = { count: 1, resetAt: now + this.config.windowMs };
      } else {
        state.count++;
      }

      await this.kv.put(stateKey, JSON.stringify(state), {
        expirationTtl: Math.ceil(this.config.windowMs / 1000) + 60
      });

      const allowed = state.count <= this.config.maxRequests;
      const remaining = Math.max(0, this.config.maxRequests - state.count);

      if (!allowed) {
        Logger.warn(`[RateLimit] Request blocked`, { key, count: state.count, max: this.config.maxRequests });
      }

      return { allowed, remaining, resetAt: state.resetAt };
    } catch (error) {
      Logger.error(`[RateLimit] Error checking rate limit`, { error: (error as Error).message });
      return { allowed: true, remaining: this.config.maxRequests, resetAt: now + this.config.windowMs };
    }
  }

  async middleware(request: Request): Promise<Response | null> {
    const result = await this.check(request);
    if (!result.allowed) {
      return new Response(JSON.stringify({
        error: 'RATE_LIMITED',
        message: '请求过于频繁，请稍后重试',
        retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000)
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.ceil((result.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(result.resetAt)
        }
      });
    }
    return null;
  }
}

// IP-based rate limiter factory
export function createIPRateLimiter(kv: KVNamespace, windowMs: number = 60000, maxRequests: number = 100): RateLimiter {
  return new RateLimiter(kv, {
    windowMs,
    maxRequests,
    keyGenerator: (request) => {
      const ip = request.headers.get('CF-Connecting-IP') || 
                 request.headers.get('X-Forwarded-For') || 
                 request.headers.get('X-Real-IP') || 'unknown';
      return `ip:${ip}`;
    }
  });
}

// ========== 敏感信息脱敏 ==========
export const SensitiveData = {
  maskEmail(email: string): string {
    const parts = email.split('@');
    if (parts.length !== 2) return '***@***';
    const local = parts[0];
    const domain = parts[1];
    if (local.length <= 2) return `${local}***@${domain}`;
    return `${local.substring(0, 2)}***@${domain}`;
  },

  maskPhone(phone: string): string {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length !== 11) return '***-****-****';
    return `${cleaned.substring(0, 3)}****${cleaned.substring(7)}`;
  },

  maskToken(token: string): string {
    if (!token) return '';
    if (token.length <= 8) return '***';
    return `${token.substring(0, 8)}***${token.substring(token.length - 4)}`;
  },

  maskURL(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.password) {
        parsed.password = '***';
      }
      if (parsed.username) {
        parsed.username = '***';
      }
      return parsed.toString();
    } catch {
      return '***';
    }
  },

  sanitizeLogData(data: Record<string, unknown>): Record<string, unknown> {
    const sensitiveKeys = ['token', 'password', 'secret', 'key', 'auth', 'credential', 'cookie'];
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      if (sensitiveKeys.some(k => lowerKey.includes(k))) {
        result[key] = '***';
      } else if (typeof value === 'object' && value !== null) {
        result[key] = this.sanitizeLogData(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }

    return result;
  }
};

// ========== CSRF 防护（简单实现）==========
export function generateCSRFToken(): string {
  const arr = new Uint8Array(32);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < 32; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function validateCSRFToken(token: string): boolean {
  if (!token || token.length !== 64) return false;
  const hexRegex = /^[0-9a-fA-F]{64}$/;
  return hexRegex.test(token);
}