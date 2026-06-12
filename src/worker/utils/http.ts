// HTTP 客户端封装

import { Logger, ClawBotError } from "./error";

export interface HttpClientConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  body?: any;
  timeout?: number;
}

export interface HttpResponse<T = any> {
  status: number;
  headers: Record<string, string>;
  data: T;
  raw: string;
}

export class HttpClient {
  private baseUrl: string;
  private defaultHeaders: Record<string, string>;
  private timeout: number;
  private retries: number;

  constructor(config: HttpClientConfig) {
    this.baseUrl = config.baseUrl;
    this.defaultHeaders = config.headers || {};
    this.timeout = config.timeout || 30000;
    this.retries = config.retries || 2;
  }

  async get<T = any>(path: string, options?: { headers?: Record<string, string>; timeout?: number }): Promise<HttpResponse<T>> {
    return this.request<T>({
      method: 'GET',
      url: path,
      headers: options?.headers,
      timeout: options?.timeout
    });
  }

  async post<T = any>(path: string, body?: any, options?: { headers?: Record<string, string>; timeout?: number }): Promise<HttpResponse<T>> {
    return this.request<T>({
      method: 'POST',
      url: path,
      body,
      headers: options?.headers,
      timeout: options?.timeout
    });
  }

  async put<T = any>(path: string, body?: any, options?: { headers?: Record<string, string>; timeout?: number }): Promise<HttpResponse<T>> {
    return this.request<T>({
      method: 'PUT',
      url: path,
      body,
      headers: options?.headers,
      timeout: options?.timeout
    });
  }

  async delete<T = any>(path: string, options?: { headers?: Record<string, string>; timeout?: number }): Promise<HttpResponse<T>> {
    return this.request<T>({
      method: 'DELETE',
      url: path,
      headers: options?.headers,
      timeout: options?.timeout
    });
  }

  private async request<T = any>(req: HttpRequest): Promise<HttpResponse<T>> {
    const url = this.buildUrl(req.url);
    const headers = { ...this.defaultHeaders, ...req.headers };
    
    if (req.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const timeout = req.timeout || this.timeout;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);

    let lastError: Error | undefined;
    
    for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
      try {
        Logger.debug(`[HttpClient] ${req.method} ${url} (attempt ${attempt})`);
        const startTime = Date.now();
        
        const response = await fetch(url, {
          method: req.method,
          headers,
          body: req.body ? JSON.stringify(req.body) : undefined,
          signal: ctrl.signal
        });
        
        const duration = Date.now() - startTime;
        clearTimeout(timer);
        
        const raw = await response.text();
        Logger.debug(`[HttpClient] ${req.method} ${url} completed`, { status: response.status, durationMs: duration });
        
        let data: T;
        try {
          data = raw ? JSON.parse(raw) : {} as T;
        } catch {
          data = raw as unknown as T;
        }
        
        if (!response.ok) {
          Logger.warn(`[HttpClient] ${req.method} ${url} failed`, { status: response.status, body: raw });
          throw new ClawBotError('HTTP_ERROR', `HTTP ${response.status}`, response.status, { status: response.status, body: raw });
        }
        
        return {
          status: response.status,
          headers: this.parseHeaders(response.headers),
          data,
          raw
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if ((error as any)?.name === 'AbortError') {
          Logger.warn(`[HttpClient] ${req.method} ${url} timeout`);
        } else {
          Logger.warn(`[HttpClient] ${req.method} ${url} error (attempt ${attempt})`, { error: lastError.message });
        }
        
        if (attempt <= this.retries) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        }
      }
    }
    
    throw lastError || new Error('Unknown error');
  }

  private buildUrl(path: string): string {
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path;
    }
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/';
    const p = path.startsWith('/') ? path.substring(1) : path;
    return base + p;
  }

  private parseHeaders(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
}