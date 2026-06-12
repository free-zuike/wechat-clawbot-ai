// 管理路由 - 消息查询、会话管理、报警查询、统计数据

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { alertService } from "../utils/alert";
import type { Env } from "../index";

interface MessageRecord {
  from_user_id: string;
  content_preview: string;
  timestamp: string;
  message_type: number;
  context_token: string;
}

interface SessionRecord {
  from_user_id: string;
  message_count: number;
  last_message_at: string;
  first_message_at: string;
}

interface StatsRecord {
  date: string;
  polls: number;
  handled: number;
  ai_calls: number;
  ai_fails: number;
  average_latency_ms: number;
}

// 获取最近消息记录（从 KV 中读取）
export async function handleRecentMessages(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const validLimit = Math.min(Math.max(limit, 1), 100);
    
    // 从 KV 读取消息记录（简单实现：从最近的 KV 记录查询）
    const messages: MessageRecord[] = [];
    const credentials = await env.CLAWBOT_KV.get('clawbot:credentials');
    if (credentials) {
      // 读取轮询统计信息
      const stats = await env.CLAWBOT_KV.get('clawbot:stats');
      if (stats) {
        const statsData = JSON.parse(stats);
        messages.push({
          from_user_id: statsData.lastMessageFrom || 'system',
          content_preview: `系统统计 - 轮询次数: ${statsData.polls || 0}, 处理: ${statsData.handled || 0}`,
          timestamp: statsData.lastPollAt || new Date().toISOString(),
          message_type: 0,
          context_token: 'system',
        });
      }
    }
    
    // 读取上下文中的消息（作为最近消息显示）
    const { keys } = await env.CLAWBOT_KV.list({ prefix: 'clawbot:context:', limit: validLimit });
    for (const key of keys) {
      const data = await env.CLAWBOT_KV.get(key.name);
      if (data) {
        const context = JSON.parse(data);
        messages.push({
          from_user_id: context.userId || key.name,
          content_preview: `会话上下文 - 消息数: ${context.messages?.length || 0}`,
          timestamp: context.lastUpdated || new Date().toISOString(),
          message_type: 1,
          context_token: key.name,
        });
      }
    }
    
    Logger.info('[Admin] Recent messages queried', { count: messages.length });
    
    return json({
      success: true,
      total: messages.length,
      messages: messages.slice(0, validLimit),
    });
  } catch (e: any) {
    Logger.error('[Admin] Error querying recent messages', { error: e.message });
    return json({ error: e.message }, 500);
  }
}

// 获取用户会话列表
export async function handleSessions(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    const sessions: SessionRecord[] = [];
    const { keys } = await env.CLAWBOT_KV.list({ prefix: 'clawbot:context:' });
    
    for (const key of keys) {
      const data = await env.CLAWBOT_KV.get(key.name);
      if (data) {
        const context = JSON.parse(data);
        sessions.push({
          from_user_id: context.userId || key.name.replace('clawbot:context:', ''),
          message_count: context.messages?.length || 0,
          last_message_at: context.lastUpdated || new Date(key.expiration || Date.now()).toISOString(),
          first_message_at: context.firstMessageAt || new Date(key.expiration || Date.now()).toISOString(),
        });
      }
    }
    
    // 按最后消息时间排序
    sessions.sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime());
    
    Logger.info('[Admin] Sessions queried', { count: sessions.length });
    
    return json({
      success: true,
      total: sessions.length,
      sessions: sessions.slice(0, 50),
    });
  } catch (e: any) {
    Logger.error('[Admin] Error querying sessions', { error: e.message });
    return json({ error: e.message }, 500);
  }
}

// 获取报警列表
export async function handleAlerts(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    // 初始化报警服务
    alertService.init(env.CLAWBOT_KV);
    
    const url = new URL(request.url);
    const onlyActive = url.searchParams.get('active') === 'true';
    const limit = parseInt(url.searchParams.get('limit') || '50');
    
    let alerts;
    if (onlyActive) {
      alerts = alertService.getActiveAlerts();
    } else {
      alerts = alertService.getRecentAlerts(limit);
    }
    
    const summary = alertService.getSummary();
    
    Logger.info('[Admin] Alerts queried', { count: alerts.length, unresolved: summary.unresolved });
    
    return json({
      success: true,
      summary,
      total: alerts.length,
      alerts: alerts.slice(0, limit),
    });
  } catch (e: any) {
    Logger.error('[Admin] Error querying alerts', { error: e.message });
    return json({ error: e.message }, 500);
  }
}

// 解决特定报警
export async function handleResolveAlert(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    
    if (!id) {
      return json({ error: '缺少报警ID' }, 400);
    }
    
    alertService.init(env.CLAWBOT_KV);
    const success = await alertService.resolveAlert(id);
    
    if (!success) {
      return json({ error: '报警未找到或已解决' }, 404);
    }
    
    Logger.info('[Admin] Alert resolved', { id });
    
    return json({ success: true, message: '报警已解决' });
  } catch (e: any) {
    Logger.error('[Admin] Error resolving alert', { error: e.message });
    return json({ error: e.message }, 500);
  }
}

// 解决所有报警
export async function handleResolveAllAlerts(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    alertService.init(env.CLAWBOT_KV);
    const count = await alertService.resolveAllAlerts();
    
    Logger.info('[Admin] All alerts resolved', { count });
    
    return json({ success: true, resolved: count, message: `已解决 ${count} 条报警` });
  } catch (e: any) {
    Logger.error('[Admin] Error resolving all alerts', { error: e.message });
    return json({ error: e.message }, 500);
  }
}

// 获取统计数据
export async function handleStats(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    const stats: StatsRecord[] = [];
    
    // 从 KV 读取当前统计
    const currentStats = await env.CLAWBOT_KV.get('clawbot:stats');
    if (currentStats) {
      const data = JSON.parse(currentStats);
      stats.push({
        date: new Date().toISOString().split('T')[0],
        polls: data.polls || 0,
        handled: data.handled || 0,
        ai_calls: data.aiCalls || 0,
        ai_fails: data.aiFails || 0,
        average_latency_ms: data.lastLatencyMs || 0,
      });
    }
    
    // 读取报警摘要
    alertService.init(env.CLAWBOT_KV);
    const alertSummary = alertService.getSummary();
    
    // 读取会话数
    const { keys: contextKeys } = await env.CLAWBOT_KV.list({ prefix: 'clawbot:context:' });
    
    Logger.info('[Admin] Stats queried');
    
    return json({
      success: true,
      dailyStats: stats,
      totalSessions: contextKeys.length,
      totalPolls: stats[0]?.polls || 0,
      totalHandled: stats[0]?.handled || 0,
      totalAICalls: stats[0]?.ai_calls || 0,
      totalAIFails: stats[0]?.ai_fails || 0,
      alertSummary,
    });
  } catch (e: any) {
    Logger.error('[Admin] Error querying stats', { error: e.message });
    return json({ error: e.message }, 500);
  }
}

// 获取系统健康状态
export async function handleHealth(request: Request, env: Env): Promise<Response> {
  try {
    // 检查 KV
    const kvCheck = await env.CLAWBOT_KV.get('clawbot:credentials').then(() => 'OK').catch(() => 'FAIL');
    
    // 检查统计
    const stats = await env.CLAWBOT_KV.get('clawbot:stats').then(s => s ? JSON.parse(s) : null).catch(() => null);
    
    // 检查报警
    alertService.init(env.CLAWBOT_KV);
    const alertSummary = alertService.getSummary();
    
    // 检查登录状态
    const loginCheck = await env.CLAWBOT_KV.get('clawbot:credentials');
    
    const healthStatus = {
      kv: kvCheck,
      loggedIn: !!loginCheck,
      totalPolls: stats?.polls || 0,
      totalHandled: stats?.handled || 0,
      totalAICalls: stats?.aiCalls || 0,
      totalAIFails: stats?.aiFails || 0,
      unresolvedAlerts: alertSummary.unresolved,
      criticalAlerts: alertSummary.byLevel.critical,
      errorAlerts: alertSummary.byLevel.error,
      warningAlerts: alertSummary.byLevel.warning,
      timestamp: new Date().toISOString(),
    };
    
    return json(healthStatus);
  } catch (e: any) {
    Logger.error('[Admin] Health check error', { error: e.message });
    return json({ success: false, error: e.message }, 500);
  }
}