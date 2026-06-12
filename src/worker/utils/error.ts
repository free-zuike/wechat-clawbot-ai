// 工具函数：重试机制、结构化日志、统一错误处理

import type { Env } from "../index";

// ========== 重试机制 ==========
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    retries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onRetry?: (attempt: number, error: Error) => void;
    shouldRetry?: (error: Error) => boolean;
  } = {}
): Promise<T> {
  const {
    retries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 10000,
    onRetry,
    shouldRetry = () => true
  } = options;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const error = e instanceof Error ? e : new Error(String(e));
      lastError = error;

      if (!shouldRetry(error)) {
        throw error;
      }

      if (attempt < retries) {
        onRetry?.(attempt, error);
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError!;
}

// ========== 结构化日志 ==========
interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
  error?: Error;
}

export const Logger = {
  debug(message: string, context?: Record<string, unknown>) {
    this.log('debug', message, context);
  },

  info(message: string, context?: Record<string, unknown>) {
    this.log('info', message, context);
  },

  warn(message: string, context?: Record<string, unknown>) {
    this.log('warn', message, context);
  },

  error(message: string, context?: Record<string, unknown>, error?: Error) {
    this.log('error', message, { ...context, error: error?.stack || error?.message });
  },

  log(level: LogEntry['level'], message: string, context?: Record<string, unknown>) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context
    };
    
    const logFn = level === 'error' ? console.error : 
                  level === 'warn' ? console.warn : 
                  level === 'debug' ? console.debug : console.log;
    
    logFn(JSON.stringify(entry));
  }
};

// ========== 统一错误类型 ==========
export class ClawBotError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly context?: Record<string, unknown>;

  constructor(code: string, message: string, status: number = 500, context?: Record<string, unknown>) {
    super(message);
    this.name = 'ClawBotError';
    this.code = code;
    this.status = status;
    this.context = context;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      ...(this.context ? { context: this.context } : {})
    };
  }
}

export const ErrorCodes = {
  AUTH_FAILED: new ClawBotError('AUTH_FAILED', '认证失败', 401),
  UNAUTHORIZED: new ClawBotError('UNAUTHORIZED', '未授权访问', 403),
  NOT_FOUND: new ClawBotError('NOT_FOUND', '资源未找到', 404),
  VALIDATION_ERROR: new ClawBotError('VALIDATION_ERROR', '参数验证失败', 400),
  INTERNAL_ERROR: new ClawBotError('INTERNAL_ERROR', '内部服务器错误', 500),
  SERVICE_UNAVAILABLE: new ClawBotError('SERVICE_UNAVAILABLE', '服务暂时不可用', 503),
  ILINK_ERROR: new ClawBotError('ILINK_ERROR', 'iLink 协议错误', 502),
  AI_ERROR: new ClawBotError('AI_ERROR', 'AI 服务错误', 502),
};

export function handleError(error: unknown): Response {
  if (error instanceof ClawBotError) {
    Logger.error(`[Error] ${error.code}: ${error.message}`, error.context);
    return new Response(JSON.stringify(error.toJSON()), {
      status: error.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  if (error instanceof Error) {
    Logger.error(`[Error] Unexpected: ${error.message}`, { stack: error.stack });
    return new Response(JSON.stringify({
      error: 'INTERNAL_ERROR',
      message: '服务器内部错误'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  Logger.error(`[Error] Unknown error: ${String(error)}`);
  return new Response(JSON.stringify({
    error: 'INTERNAL_ERROR',
    message: '未知错误'
  }), {
    status: 500,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

// ========== 路由处理包装器（统一错误处理 + 日志 + 认证）==========
type HandlerFn = (request: Request, env: Env) => Promise<Response>;

interface RouteOptions {
  requireAuth?: boolean;
  rateLimit?: boolean;
  rateLimitKey?: 'ip' | 'user' | 'global';
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  logRequests?: boolean;
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

// 简化的请求频率限制（不依赖完整 security.ts 的复杂实现）
class SimpleRateLimiter {
  private counters: Map<string, { count: number; resetAt: number }> = new Map();

  check(key: string, max: number, windowMs: number): { allowed: boolean; remaining: number; retryAfter: number } {
    const now = Date.now();
    const existing = this.counters.get(key);
    
    if (existing && now >= existing.resetAt) {
      this.counters.delete(key);
    }

    const current = this.counters.get(key) || { count: 0, resetAt: now + windowMs };
    current.count++;
    this.counters.set(key, current);

    const allowed = current.count <= max;
    const remaining = Math.max(0, max - current.count);
    const retryAfter = Math.ceil((current.resetAt - now) / 1000);
    
    // 定期清理过期的 key
    if (this.counters.size > 1000) {
      for (const [k, v] of this.counters.entries()) {
        if (now >= v.resetAt) this.counters.delete(k);
      }
    }

    return { allowed, remaining, retryAfter };
  }
}

const rateLimiter = new SimpleRateLimiter();

function getClientIP(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || 
         request.headers.get('X-Forwarded-For') || 
         request.headers.get('X-Real-IP') || 'unknown';
}

// 统一认证检查
async function checkAuth(request: Request, env: Env): Promise<{ ok: boolean; error?: string }> {
  // 优先检查 session cookie
  const cookieHeader = request.headers.get('Cookie') || '';
  const sessionMatch = cookieHeader.match(/clawbot_session=([^;]+)/);
  if (sessionMatch && env.CLAWBOT_KV) {
    const sessionToken = sessionMatch[1];
    const sessionValid = await env.CLAWBOT_KV.get(`clawbot:session:${sessionToken}`);
    if (sessionValid) {
      return { ok: true };
    }
  }

  // 检查是否有登录凭证（通过 KV）
  if (env.CLAWBOT_KV) {
    const credsRaw = await env.CLAWBOT_KV.get('clawbot:credentials');
    if (credsRaw) {
      return { ok: true };
    }
  }

  // 检查管理员密码（用于登录前的 API 如获取二维码）
  if (env.ADMIN_PASSWORD) {
    const url = new URL(request.url);
    const queryPwd = url.searchParams.get('pwd') || '';
    if (queryPwd === env.ADMIN_PASSWORD) {
      return { ok: true };
    }

    const authHeader = request.headers.get('Authorization') || '';
    const m = authHeader.match(/^Basic\s+(.+)$/i);
    if (m) {
      try {
        const decoded = atob(m[1]);
        const colon = decoded.indexOf(':');
        const pass = colon >= 0 ? decoded.slice(colon + 1) : decoded;
        if (pass === env.ADMIN_PASSWORD) {
          return { ok: true };
        }
      } catch {}
    }
  }

  return { ok: false, error: '请先登录或提供正确的管理员密码' };
}

export async function withRoute(
  handler: HandlerFn,
  options: RouteOptions = {}
): Promise<HandlerFn> {
  const {
    requireAuth = false,
    rateLimit = false,
    rateLimitKey = 'ip',
    rateLimitMax = 100,
    rateLimitWindowMs = 60000,
    logRequests = true,
  } = options;

  return async (request: Request, env: Env) => {
    const requestId = crypto.randomUUID().slice(0, 8);
    const startTime = Date.now();

    if (logRequests) {
      Logger.debug(`[${requestId}] ${request.method} ${new URL(request.url).pathname}`, {
        ip: getClientIP(request)
      });
    }

    // 1. 认证检查
    if (requireAuth) {
      const auth = await checkAuth(request, env);
      if (!auth.ok) {
        Logger.warn(`[${requestId}] Auth failed`, { reason: auth.error });
        return json({ error: auth.error || '未授权访问' }, 401);
      }
    }

    // 2. 频率限制检查
    if (rateLimit) {
      const key = rateLimitKey === 'ip' ? getClientIP(request) : 'global';
      const result = rateLimiter.check(key, rateLimitMax, rateLimitWindowMs);
      if (!result.allowed) {
        Logger.warn(`[${requestId}] Rate limited`, { ip: key });
        return json(
          { error: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试', retryAfter: result.retryAfter },
          429
        );
      }
    }

    // 3. 执行业务逻辑 + 统一错误处理
    try {
      const response = await handler(request, env);
      const duration = Date.now() - startTime;
      if (logRequests) {
        Logger.debug(`[${requestId}] Completed`, { status: response.status, durationMs: duration });
      }
      return response;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      Logger.error(`[${requestId}] Handler error`, { 
        error: error?.message || String(error), 
        durationMs: duration 
      });
      return handleError(error);
    }
  };
}