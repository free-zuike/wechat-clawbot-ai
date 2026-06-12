// 监控与可观测性工具：指标收集、健康检查、错误统计

import { Logger } from "./error";
import type { Env } from "../index";

// ========== 指标收集 ==========
interface MetricData {
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  p95: number;
  p99: number;
}

interface TimingData {
  start: number;
  end?: number;
  duration?: number;
}

export class Metrics {
  private counters: Record<string, number> = {};
  private gauges: Record<string, number> = {};
  private histograms: Record<string, number[]> = {};
  private timers: Record<string, TimingData> = {};
  private kv: KVNamespace | null = null;
  private lastFlush: number = 0;
  private flushInterval: number = 60000;

  init(kv: KVNamespace, flushInterval: number = 60000): void {
    this.kv = kv;
    this.flushInterval = flushInterval;
    this.loadFromKV();
  }

  private async loadFromKV(): Promise<void> {
    if (!this.kv) return;
    try {
      const stored = await this.kv.get('metrics:state');
      if (stored) {
        const state = JSON.parse(stored);
        this.counters = state.counters || {};
        this.gauges = state.gauges || {};
        Logger.info('[Metrics] Loaded metrics from KV');
      }
    } catch (error) {
      Logger.warn('[Metrics] Error loading metrics from KV', { error: (error as Error).message });
    }
  }

  private async flushToKV(): Promise<void> {
    if (!this.kv) return;
    try {
      const state = { counters: this.counters, gauges: this.gauges };
      await this.kv.put('metrics:state', JSON.stringify(state));
      this.lastFlush = Date.now();
    } catch (error) {
      Logger.warn('[Metrics] Error flushing metrics to KV', { error: (error as Error).message });
    }
  }

  incr(name: string, value: number = 1): void {
    this.counters[name] = (this.counters[name] || 0) + value;
    this.maybeFlush();
  }

  decr(name: string, value: number = 1): void {
    this.counters[name] = (this.counters[name] || 0) - value;
    this.maybeFlush();
  }

  setGauge(name: string, value: number): void {
    this.gauges[name] = value;
    this.maybeFlush();
  }

  addHistogram(name: string, value: number): void {
    if (!this.histograms[name]) {
      this.histograms[name] = [];
    }
    this.histograms[name].push(value);
    if (this.histograms[name].length > 1000) {
      this.histograms[name] = this.histograms[name].slice(-500);
    }
  }

  startTimer(name: string): void {
    this.timers[name] = { start: Date.now() };
  }

  stopTimer(name: string): number | null {
    const timer = this.timers[name];
    if (!timer) return null;
    
    timer.end = Date.now();
    timer.duration = timer.end - timer.start;
    
    this.addHistogram(`timing.${name}`, timer.duration);
    this.incr(`timing.${name}.count`);
    delete this.timers[name];
    
    return timer.duration;
  }

  private maybeFlush(): void {
    const now = Date.now();
    if (now - this.lastFlush >= this.flushInterval) {
      this.flushToKV();
    }
  }

  getMetric(name: string): MetricData | null {
    const values = this.histograms[name];
    if (!values || values.length === 0) return null;
    
    const sorted = [...values].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((acc, val) => acc + val, 0);
    const min = sorted[0];
    const max = sorted[count - 1];
    const avg = sum / count;
    const p95 = sorted[Math.floor(count * 0.95)];
    const p99 = sorted[Math.floor(count * 0.99)];
    
    return { count, sum, min, max, avg, p95, p99 };
  }

  getCounters(): Record<string, number> {
    return { ...this.counters };
  }

  getGauges(): Record<string, number> {
    return { ...this.gauges };
  }

  reset(): void {
    this.counters = {};
    this.gauges = {};
    this.histograms = {};
    this.flushToKV();
    Logger.info('[Metrics] Reset all metrics');
  }

  async export(): Promise<{
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, MetricData | null>;
  }> {
    const histograms: Record<string, MetricData | null> = {};
    for (const name of Object.keys(this.histograms)) {
      histograms[name] = this.getMetric(name);
    }
    
    return {
      counters: this.getCounters(),
      gauges: this.getGauges(),
      histograms
    };
  }
}

// 全局指标实例
export const metrics = new Metrics();

// ========== 健康检查 ==========
export interface HealthCheckResult {
  ok: boolean;
  timestamp: string;
  uptimeMs: number;
  checks: {
    name: string;
    status: 'pass' | 'fail' | 'warn';
    message?: string;
    durationMs?: number;
  }[];
  version?: string;
}

export async function runHealthChecks(env: Env): Promise<HealthCheckResult> {
  const startTime = Date.now();
  const checks: HealthCheckResult['checks'] = [];
  
  // KV 检查
  const kvStart = Date.now();
  try {
    await env.CLAWBOT_KV.get('clawbot:credentials');
    checks.push({
      name: 'KV Storage',
      status: 'pass',
      durationMs: Date.now() - kvStart
    });
  } catch (error) {
    checks.push({
      name: 'KV Storage',
      status: 'fail',
      message: (error as Error).message,
      durationMs: Date.now() - kvStart
    });
  }

  // 凭证检查
  const credsStart = Date.now();
  try {
    const creds = await env.CLAWBOT_KV.get('clawbot:credentials');
    if (creds) {
      checks.push({
        name: 'Credentials',
        status: 'pass',
        message: 'Credentials found',
        durationMs: Date.now() - credsStart
      });
    } else {
      checks.push({
        name: 'Credentials',
        status: 'warn',
        message: 'No credentials found - not logged in',
        durationMs: Date.now() - credsStart
      });
    }
  } catch (error) {
    checks.push({
      name: 'Credentials',
      status: 'fail',
      message: (error as Error).message,
      durationMs: Date.now() - credsStart
    });
  }

  // AI 服务检查
  const aiStart = Date.now();
  try {
    if (env.AI) {
      checks.push({
        name: 'AI Service',
        status: 'pass',
        message: 'AI binding available',
        durationMs: Date.now() - aiStart
      });
    } else {
      checks.push({
        name: 'AI Service',
        status: 'warn',
        message: 'AI binding not available',
        durationMs: Date.now() - aiStart
      });
    }
  } catch (error) {
    checks.push({
      name: 'AI Service',
      status: 'fail',
      message: (error as Error).message,
      durationMs: Date.now() - aiStart
    });
  }

  // 计算整体状态
  const hasFailures = checks.some(c => c.status === 'fail');
  const hasWarnings = checks.some(c => c.status === 'warn');
  
  return {
    ok: !hasFailures,
    timestamp: new Date().toISOString(),
    uptimeMs: Date.now() - startTime,
    checks,
    version: process.env.npm_package_version || 'unknown'
  };
}

// ========== 错误统计 ==========
export interface ErrorStats {
  totalErrors: number;
  errorByType: Record<string, number>;
  errorByEndpoint: Record<string, number>;
  lastErrors: Array<{
    timestamp: string;
    type: string;
    message: string;
    endpoint?: string;
    stack?: string;
  }>;
}

export class ErrorTracker {
  private kv: KVNamespace | null = null;
  private maxLastErrors = 50;

  init(kv: KVNamespace): void {
    this.kv = kv;
  }

  async trackError(type: string, message: string, endpoint?: string, stack?: string): Promise<void> {
    if (!this.kv) return;

    try {
      const stats = await this.getStats();
      
      stats.totalErrors++;
      stats.errorByType[type] = (stats.errorByType[type] || 0) + 1;
      if (endpoint) {
        stats.errorByEndpoint[endpoint] = (stats.errorByEndpoint[endpoint] || 0) + 1;
      }
      
      stats.lastErrors.unshift({
        timestamp: new Date().toISOString(),
        type,
        message,
        endpoint,
        stack
      });
      
      if (stats.lastErrors.length > this.maxLastErrors) {
        stats.lastErrors = stats.lastErrors.slice(0, this.maxLastErrors);
      }
      
      await this.kv.put('errors:stats', JSON.stringify(stats));
      Logger.error(`[ErrorTracker] Tracked error`, { type, message, endpoint });
    } catch (error) {
      Logger.error('[ErrorTracker] Error tracking error', { error: (error as Error).message });
    }
  }

  async getStats(): Promise<ErrorStats> {
    if (!this.kv) {
      return {
        totalErrors: 0,
        errorByType: {},
        errorByEndpoint: {},
        lastErrors: []
      };
    }

    try {
      const stored = await this.kv.get('errors:stats');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (error) {
      Logger.warn('[ErrorTracker] Error getting stats', { error: (error as Error).message });
    }

    return {
      totalErrors: 0,
      errorByType: {},
      errorByEndpoint: {},
      lastErrors: []
    };
  }

  async reset(): Promise<void> {
    if (!this.kv) return;
    const emptyStats: ErrorStats = {
      totalErrors: 0,
      errorByType: {},
      errorByEndpoint: {},
      lastErrors: []
    };
    await this.kv.put('errors:stats', JSON.stringify(emptyStats));
    Logger.info('[ErrorTracker] Reset error stats');
  }
}

export const errorTracker = new ErrorTracker();