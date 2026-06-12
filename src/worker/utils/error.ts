// 工具函数：重试机制、结构化日志、统一错误处理

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

// ========== 统一错误处理 ==========
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
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (error instanceof Error) {
    Logger.error(`[Error] Unexpected: ${error.message}`, { stack: error.stack });
    return new Response(JSON.stringify({
      error: 'INTERNAL_ERROR',
      message: '服务器内部错误'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  Logger.error(`[Error] Unknown error: ${String(error)}`);
  return new Response(JSON.stringify({
    error: 'INTERNAL_ERROR',
    message: '未知错误'
  }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' }
  });
}