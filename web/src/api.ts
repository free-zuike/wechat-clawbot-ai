// API 封装 - 统一错误处理版

const API_BASE = "";

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
}

function withPwd(path: string, pwd: string): string {
  if (!pwd) return API_BASE + path;
  const sep = path.includes("?") ? "&" : "?";
  return API_BASE + path + sep + "pwd=" + encodeURIComponent(pwd);
}

// 统一的 API fetch 包装器：检查 HTTP 状态码 + 解析 JSON + 抛出标准错误
async function apiFetch(
  input: RequestInfo,
  init?: RequestInit
): Promise<any> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (networkError: any) {
    // 网络层错误（CORS、断网等）
    throw new ApiError("网络错误，请检查连接", "NETWORK_ERROR", 0);
  }

  let json: any;
  try {
    json = await response.json();
  } catch {
    // 响应不是 JSON（例如 Cloudflare 返回 HTML 错误页）
    throw new ApiError(
      response.ok ? "响应格式错误" : `服务器错误 (${response.status})`,
      "PARSE_ERROR",
      response.status
    );
  }

  // HTTP 层检查
  if (!response.ok) {
    const message = json?.error || json?.message || `请求失败 (${response.status})`;
    const code = json?.error || "HTTP_ERROR";
    
    // 特殊处理认证错误
    if (response.status === 401) {
      throw new ApiError("请先登录", "AUTH_FAILED", 401, json);
    }
    // 特殊处理限流
    if (response.status === 429) {
      throw new ApiError(json?.message || "请求过于频繁，请稍后重试", "RATE_LIMITED", 429, json);
    }
    
    throw new ApiError(message, code, response.status, json);
  }

  // 业务层检查（后端返回的 JSON 里可能也有 error 字段）
  if (json && json.error && !json.ok) {
    throw new ApiError(
      json.message || json.error || "操作失败",
      json.error,
      response.status
    );
  }

  return json;
}

export async function fetchStatus(checkToken = false): Promise<any> {
  const url = checkToken
    ? API_BASE + "/api/status?checkToken=true"
    : API_BASE + "/api/status";
  return apiFetch(url);
}

export async function fetchConfig(): Promise<any> {
  return apiFetch(API_BASE + "/api/config");
}

export async function saveConfig(config: any): Promise<any> {
  return apiFetch(API_BASE + "/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
}

export async function triggerPoll(): Promise<any> {
  return apiFetch(API_BASE + "/api/trigger-poll", {
    method: "POST",
  });
}

export async function logout(): Promise<any> {
  return apiFetch(API_BASE + "/api/logout", {
    method: "POST",
  });
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
  });
}

export async function debugLogin(): Promise<any> {
  return apiFetch("/api/debug-login");
}