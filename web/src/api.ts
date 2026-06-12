// API 封装 - 统一错误处理 + 超时 + 取消支持

const API_BASE = "";

// 全局 AbortController 管理 - 防止竞态条件
const pendingRequests = new Map<string, AbortController>();

// 统一 API 错误类型
export class ApiError extends Error {
  code: string;
  status: number;
  raw: any;

  constructor(message: string, code: string, status: number, raw?: any) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.raw = raw;
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.code === "AUTH_FAILED";
  }

  get isRateLimited(): boolean {
    return this.status === 429 || this.code === "RATE_LIMITED";
  }

  get isNetworkError(): boolean {
    return this.status === 0 || this.code === "NETWORK_ERROR";
  }

  // 主动取消不算错误
  get isCancelled(): boolean {
    return this.code === "ABORTED";
  }
}

function withPwd(path: string, pwd: string): string {
  if (!pwd) return API_BASE + path;
  const sep = path.includes("?") ? "&" : "?";
  return API_BASE + path + sep + "pwd=" + encodeURIComponent(pwd);
}

// 取消指定路径的正在进行的请求
export function cancelRequest(path: string): void {
  const controller = pendingRequests.get(path);
  if (controller) {
    controller.abort();
    pendingRequests.delete(path);
  }
}

// 取消所有进行中的请求
export function cancelAllRequests(): void {
  for (const controller of pendingRequests.values()) {
    controller.abort();
  }
  pendingRequests.clear();
}

// 统一的 API fetch 包装器
interface ApiFetchOptions extends RequestInit {
  timeout?: number;  // 毫秒，默认 15000
  retry?: number;    // 网络错误自动重试次数，默认 0
  cancelable?: boolean | string; // 是否可取消，字符串表示自定义 key
}

async function apiFetch(
  input: RequestInfo,
  init?: ApiFetchOptions
): Promise<any> {
  const { timeout = 15000, retry = 0, cancelable, ...fetchInit } = init || {};
  const url = typeof input === "string" ? input : input.url;
  const method = fetchInit.method || "GET";
  const cancelKey = cancelable === true ? `${method}:${url}` : cancelable || undefined;

  // 如果可取消，先取消之前相同 key 的请求
  if (cancelKey) cancelRequest(cancelKey);

  // 设置超时 + 取消支持
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  if (cancelKey) pendingRequests.set(cancelKey, controller);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      const response = await fetch(input, {
        ...fetchInit,
        signal: controller.signal,
        credentials: "include",
      } as RequestInit);

      clearTimeout(timeoutId);
      if (cancelKey) pendingRequests.delete(cancelKey);

      let json: any;
      try {
        json = await response.json();
      } catch {
        throw new ApiError(
          response.ok ? "响应格式错误" : `服务器错误 (${response.status})`,
          "PARSE_ERROR",
          response.status
        );
      }

      if (!response.ok) {
        const message = json?.error || json?.message || `请求失败 (${response.status})`;
        const code = json?.error || "HTTP_ERROR";

        if (response.status === 401) {
          throw new ApiError("请先登录", "AUTH_FAILED", 401, json);
        }
        if (response.status === 429) {
          throw new ApiError(json?.message || "请求过于频繁，请稍后重试", "RATE_LIMITED", 429, json);
        }
        throw new ApiError(message, code, response.status, json);
      }

      if (json && json.error && !json.ok) {
        throw new ApiError(
          json.message || json.error || "操作失败",
          json.error,
          response.status
        );
      }

      return json;
    } catch (err: any) {
      if (err?.name === "AbortError") {
        // 被主动取消的请求（被新请求替换）不算错误
        if (cancelKey) {
          // 被新请求替换 - 静默返回 null
          return null;
        }
        throw new ApiError("请求已取消", "ABORTED", 0);
      }
      lastError = err;
      // 只有网络错误才重试（非最后一次尝试时）
      if (attempt < retry && err instanceof ApiError && err.isNetworkError) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      // 非 API 的原生错误（如网络问题）
      if (!(err instanceof ApiError)) {
        throw new ApiError("网络错误，请检查连接", "NETWORK_ERROR", 0);
      }
      throw err;
    }
  }

  throw lastError || new ApiError("请求失败", "UNKNOWN", 0);
}

// ============ 现有 API ============

export async function fetchStatus(checkToken = false): Promise<any> {
  const url = checkToken
    ? API_BASE + "/api/status?checkToken=true"
    : API_BASE + "/api/status";
  return apiFetch(url, { cancelable: "status" });
}

export async function fetchConfig(): Promise<any> {
  return apiFetch(API_BASE + "/api/config", { cancelable: "config" });
}

export async function saveConfig(config: { aiModel?: string; aiSystemPrompt?: string }): Promise<any> {
  return apiFetch(API_BASE + "/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
    timeout: 10000,
  });
}

export async function triggerPoll(): Promise<any> {
  return apiFetch(API_BASE + "/api/trigger-poll", {
    method: "POST",
    timeout: 30000, // 拉取消息可能较慢
  });
}

export async function logout(): Promise<any> {
  return apiFetch(API_BASE + "/api/logout", { method: "POST" });
}

export async function getQRCode(pwd: string): Promise<any> {
  return apiFetch(withPwd("/api/qrcode", pwd));
}

export async function getQRCodeStatus(pwd: string): Promise<any> {
  return apiFetch(withPwd("/api/qrcode-status", pwd));
}

export async function checkLogin(): Promise<any> {
  return apiFetch("/api/check-login");
}

export async function chat(message: string): Promise<{ reply: string; source?: string; error?: string }> {
  return apiFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    timeout: 45000, // AI 调用可能较慢
    cancelable: "chat",
  });
}

export async function debugLogin(): Promise<any> {
  return apiFetch("/api/debug-login", { timeout: 30000 });
}

// ============ 管理 API ============

export interface AlertRecord {
  id: string;
  level: "info" | "warning" | "error" | "critical";
  message: string;
  error?: string;
  endpoint?: string;
  timestamp: string;
  count: number;
  resolved?: boolean;
  resolvedAt?: string;
}

export interface AlertsResponse {
  success: boolean;
  total: number;
  alerts: AlertRecord[];
  summary?: {
    total: number;
    unresolved: number;
    byLevel: Record<string, number>;
  };
}

export async function fetchAlerts(activeOnly = false, limit = 50): Promise<AlertsResponse> {
  const params = new URLSearchParams();
  if (activeOnly) params.set("active", "true");
  params.set("limit", String(limit));
  return apiFetch(`/api/admin/alerts?${params.toString()}`, { cancelable: "alerts" });
}

export async function resolveAlert(id: string): Promise<{ success: boolean; message?: string }> {
  return apiFetch(`/api/admin/alerts/resolve?id=${encodeURIComponent(id)}`, {
    method: "POST",
  });
}

export async function resolveAllAlerts(): Promise<{ success: boolean; resolved: number }> {
  return apiFetch("/api/admin/alerts/resolve-all", { method: "POST" });
}

export interface SessionRecord {
  from_user_id: string;
  message_count: number;
  last_message_at: string;
  first_message_at?: string;
}

export interface SessionsResponse {
  success: boolean;
  total: number;
  sessions: SessionRecord[];
  totalPages?: number;
}

export async function fetchSessions(limit = 50, page = 1, search = ""): Promise<SessionsResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("page", String(page));
  if (search.trim()) params.set("search", search.trim());
  return apiFetch(`/api/admin/sessions?${params.toString()}`, { cancelable: "sessions" });
}

export interface HealthStatus {
  kv: string;
  loggedIn: boolean;
  totalPolls: number;
  totalHandled: number;
  totalAICalls: number;
  totalAIFails: number;
  unresolvedAlerts: number;
  criticalAlerts: number;
  errorAlerts: number;
  warningAlerts: number;
  timestamp: string;
}

export async function fetchHealth(): Promise<HealthStatus> {
  return apiFetch("/api/admin/health", { cancelable: "health" });
}

export interface MessageRecord {
  from_user_id: string;
  content_preview: string;
  timestamp: string;
  message_type: number;
  context_token: string;
}

export interface MessagesResponse {
  success: boolean;
  total: number;
  messages: MessageRecord[];
}

export async function fetchMessages(limit = 50): Promise<MessagesResponse> {
  return apiFetch(`/api/admin/messages?limit=${limit}`, { cancelable: "messages" });
}

export interface StatsData {
  dailyStats: Array<{ date: string; polls: number; handled: number }>;
  totalSessions: number;
  totalPolls: number;
  totalHandled: number;
  totalAICalls: number;
  totalAIFails: number;
}

export async function fetchStats(): Promise<StatsData & { success: boolean }> {
  return apiFetch("/api/admin/stats", { cancelable: "stats" });
}
