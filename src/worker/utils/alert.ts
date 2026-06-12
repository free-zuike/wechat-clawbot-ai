// 报警通知服务 - 错误监控和通知
// 支持：错误计数、阈值报警、错误记录、历史查询

import { Logger } from "./error";

// 报警级别
export type AlertLevel = 'info' | 'warning' | 'error' | 'critical';

// 报警项
export interface Alert {
  id: string;
  level: AlertLevel;
  message: string;
  error?: string;
  endpoint?: string;
  timestamp: string;
  count: number;
  resolved?: boolean;
  resolvedAt?: string;
}

// 统计汇总
export interface AlertSummary {
  total: number;
  byLevel: Record<AlertLevel, number>;
  unresolved: number;
  lastAlert: Alert | null;
  activeAlerts: Alert[];
}

// 报警配置
export interface AlertConfig {
  // 每小时最大错误数
  maxErrorsPerHour: number;
  // 连续AI失败报警阈值
  aiFailureThreshold: number;
  // 轮询失败报警阈值
  pollFailureThreshold: number;
}

const defaultConfig: AlertConfig = {
  maxErrorsPerHour: 100,
  aiFailureThreshold: 5,
  pollFailureThreshold: 3,
};

// 内存存储（不需要持久化，重启清空即可）
class AlertStore {
  private alerts: Alert[] = [];
  private counters: Record<string, { count: number; firstTime: number }> = {};

  getAlerts(): Alert[] {
    return this.alerts.slice().reverse();
  }

  getActiveAlerts(): Alert[] {
    return this.alerts.filter(a => !a.resolved).slice().reverse();
  }

  addAlert(alert: Alert): void {
    this.alerts.push(alert);
    if (this.alerts.length > 200) {
      this.alerts = this.alerts.slice(-200);
    }
  }

  incrementCounter(key: string): number {
    const now = Date.now();
    const entry = this.counters[key];
    if (!entry || now - entry.firstTime > 3600000) { // 1小时窗口
      this.counters[key] = { count: 1, firstTime: now };
      return 1;
    }
    entry.count++;
    return entry.count;
  }

  getCounter(key: string): number {
    return this.counters[key]?.count || 0;
  }

  resolveAlert(id: string): boolean {
    const alert = this.alerts.find(a => a.id === id);
    if (alert && !alert.resolved) {
      alert.resolved = true;
      alert.resolvedAt = new Date().toISOString();
      return true;
    }
    return false;
  }

  resolveAll(): number {
    let resolved = 0;
    for (const alert of this.alerts) {
      if (!alert.resolved) {
        alert.resolved = true;
        alert.resolvedAt = new Date().toISOString();
        resolved++;
      }
    }
    return resolved;
  }
}

const store = new AlertStore();

// 报警服务
export class AlertService {
  private config: AlertConfig;
  private lastPollFailures = 0;
  private lastAIFailures = 0;

  constructor(config: Partial<AlertConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
  }

  // 记录错误并判断是否触发报警
  recordError(message: string, endpoint?: string, error?: Error): Alert | null {
    const now = new Date().toISOString();
    const errorKey = `${endpoint || 'general'}:${message.slice(0, 50)}`;
    const count = store.incrementCounter(errorKey);

    Logger.info('[AlertService] Error recorded', {
      message: message.slice(0, 100),
      endpoint,
      count,
    });

    // 超过阈值触发报警
    if (count >= 3) {
      const level: AlertLevel = count >= 10 ? 'critical' : count >= 5 ? 'error' : 'warning';
      const alert: Alert = {
        id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        level,
        message,
        error: error?.message || error?.toString(),
        endpoint,
        timestamp: now,
        count,
      };
      store.addAlert(alert);
      Logger.warn('[AlertService] Alert triggered', { level, message: message.slice(0, 100) });
      return alert;
    }

    return null;
  }

  // 记录轮询失败
  recordPollFailure(error: string): Alert | null {
    this.lastPollFailures++;
    Logger.warn('[AlertService] Poll failure', { consecutive: this.lastPollFailures });

    if (this.lastPollFailures >= this.config.pollFailureThreshold) {
      const alert: Alert = {
        id: `alert_poll_${Date.now()}`,
        level: 'error',
        message: `连续 ${this.lastPollFailures} 次消息轮询失败`,
        error,
        endpoint: 'messaging',
        timestamp: new Date().toISOString(),
        count: this.lastPollFailures,
      };
      store.addAlert(alert);
      return alert;
    }
    return null;
  }

  // 记录轮询成功（重置计数器）
  recordPollSuccess(): void {
    if (this.lastPollFailures > 0) {
      Logger.info('[AlertService] Poll recovered', { previousFailures: this.lastPollFailures });
      this.lastPollFailures = 0;
    }
  }

  // 记录AI失败
  recordAIFailure(error: string): Alert | null {
    this.lastAIFailures++;
    Logger.warn('[AlertService] AI failure', { consecutive: this.lastAIFailures });

    if (this.lastAIFailures >= this.config.aiFailureThreshold) {
      const alert: Alert = {
        id: `alert_ai_${Date.now()}`,
        level: 'warning',
        message: `连续 ${this.lastAIFailures} 次 AI 调用失败`,
        error,
        endpoint: 'ai',
        timestamp: new Date().toISOString(),
        count: this.lastAIFailures,
      };
      store.addAlert(alert);
      return alert;
    }
    return null;
  }

  // 记录AI成功
  recordAISuccess(): void {
    if (this.lastAIFailures > 0) {
      Logger.info('[AlertService] AI recovered', { previousFailures: this.lastAIFailures });
      this.lastAIFailures = 0;
    }
  }

  // 获取报警摘要
  getSummary(): AlertSummary {
    const alerts = store.getAlerts();
    const byLevel: Record<AlertLevel, number> = {
      info: 0, warning: 0, error: 0, critical: 0,
    };

    for (const alert of alerts) {
      byLevel[alert.level]++;
    }

    return {
      total: alerts.length,
      byLevel,
      unresolved: alerts.filter(a => !a.resolved).length,
      lastAlert: alerts[alerts.length - 1] || null,
      activeAlerts: store.getActiveAlerts(),
    };
  }

  // 获取最近报警
  getRecentAlerts(limit: number = 20): Alert[] {
    const alerts = store.getAlerts();
    return alerts.slice(0, limit);
  }

  // 获取未解决报警
  getActiveAlerts(): Alert[] {
    return store.getActiveAlerts();
  }

  // 解决特定报警
  resolveAlert(id: string): boolean {
    const success = store.resolveAlert(id);
    if (success) {
      Logger.info('[AlertService] Alert resolved', { id });
    }
    return success;
  }

  // 解决所有报警
  resolveAllAlerts(): number {
    const resolved = store.resolveAll();
    Logger.info('[AlertService] All alerts resolved', { count: resolved });
    return resolved;
  }
}

// 全局报警服务实例
export const alertService = new AlertService();

// 辅助函数：快速记录错误
export function recordAlertError(message: string, endpoint?: string, error?: Error): Alert | null {
  return alertService.recordError(message, endpoint, error);
}