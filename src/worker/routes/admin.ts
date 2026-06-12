// 管理路由 - 消息查询、会话管理、报警查询、统计数据
// 优化：分页支持 + 搜索过滤 + 响应缓存

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { alertService } from "../utils/alert";
import { statusCache } from "../utils/cache";
import { D1Service } from "../services/d1";
import type { Env } from "../index";

interface AlertRecord {
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

function parseLimit(url: URL, defaultValue = 50, max = 200): number {
  const raw = url.searchParams.get("limit");
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, max);
}

function parsePage(url: URL, defaultValue = 1): number {
  const raw = url.searchParams.get("page");
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

// ============ 消息查询 ============

export async function handleRecentMessages(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    const url = new URL(request.url);
    const limit = parseLimit(url);
    const page = parsePage(url);
    const search = url.searchParams.get("search")?.toLowerCase() || "";
    const offset = (page - 1) * limit;

    // 从 KV 读取消息记录
    const messages: Array<{
      from_user_id: string;
      content_preview: string;
      timestamp: string;
      message_type: number;
      context_token: string;
    }> = [];

    // 读取上下文信息作为消息列表
    const prefix = "clawbot:context:";
    const { keys } = await env.CLAWBOT_KV.list({ prefix });

    for (const key of keys) {
      const data = await env.CLAWBOT_KV.get(key.name);
      if (!data) continue;

      let context: any = null;
      try {
        context = JSON.parse(data);
      } catch {
        continue;
      }

      const userId = context.userId || key.name.replace(prefix, "");
      const lastMessage =
        (Array.isArray(context.messages) &&
          context.messages[context.messages.length - 1]?.text) ||
        "（无文本内容）";

      messages.push({
        from_user_id: userId,
        content_preview: String(lastMessage).slice(0, 200),
        timestamp: context.lastUpdated || new Date(key.expiration || Date.now()).toISOString(),
        message_type: context.message_type || 1,
        context_token: key.name,
      });
    }

    // 按时间排序（最新在前）
    messages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // 搜索过滤
    const filtered = search
      ? messages.filter(
          (m) =>
            m.from_user_id.toLowerCase().includes(search) ||
            m.content_preview.toLowerCase().includes(search)
        )
      : messages;

    // 分页
    const paged = filtered.slice(offset, offset + limit);

    Logger.info("[Admin] messages queried", {
      total: filtered.length,
      page,
      limit,
      hasSearch: !!search,
    });

    return json({
      success: true,
      total: filtered.length,
      page,
      limit,
      totalPages: Math.ceil(filtered.length / limit) || 1,
      messages: paged,
    });
  } catch (e: any) {
    Logger.error("[Admin] messages query error", { error: e.message });
    return json({ error: e.message }, 500);
  }
}

// ============ 会话查询 ============

export async function handleSessions(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    const url = new URL(request.url);
    const limit = parseLimit(url);
    const page = parsePage(url);
    const search = url.searchParams.get("search")?.toLowerCase() || "";
    const offset = (page - 1) * limit;

    const sessions: Array<{
      from_user_id: string;
      message_count: number;
      last_message_at: string;
      first_message_at?: string;
    }> = [];

    const { keys } = await env.CLAWBOT_KV.list({ prefix: "clawbot:context:" });

    for (const key of keys) {
      const data = await env.CLAWBOT_KV.get(key.name);
      if (!data) continue;

      let context: any = null;
      try {
        context = JSON.parse(data);
      } catch {
        continue;
      }

      sessions.push({
        from_user_id: context.userId || key.name.replace("clawbot:context:", ""),
        message_count: Array.isArray(context.messages) ? context.messages.length : 0,
        last_message_at: context.lastUpdated || new Date().toISOString(),
        first_message_at: context.firstMessageAt,
      });
    }

    sessions.sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime());

    // 搜索过滤
    const filtered = search
      ? sessions.filter((s) => s.from_user_id.toLowerCase().includes(search))
      : sessions;

    // 分页
    const paged = filtered.slice(offset, offset + limit);

    Logger.info("[Admin] sessions queried", { total: filtered.length, page, limit });

    return json({
      success: true,
      total: filtered.length,
      page,
      limit,
      totalPages: Math.ceil(filtered.length / limit) || 1,
      sessions: paged,
    });
  } catch (e: any) {
    Logger.error("[Admin] sessions query error", { error: e.message });
    return json({ error: e.message }, 500);
  }
}

// ============ 报警查询 ============

export async function handleAlerts(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    const url = new URL(request.url);
    const limit = parseLimit(url, 50, 100);
    const page = parsePage(url);
    const offset = (page - 1) * limit;
    const onlyActive = url.searchParams.get("active") === "true";
    const level = url.searchParams.get("level")?.toLowerCase();
    const search = url.searchParams.get("search")?.toLowerCase() || "";

    // 从内存 alertService 获取报警
    const summary = alertService.getSummary();
    let alerts: AlertRecord[] = summary.activeAlerts;

    // 过滤未解决
    if (onlyActive) {
      alerts = alerts.filter((a) => !a.resolved);
    }

    // 过滤级别
    if (level) {
      alerts = alerts.filter((a) => a.level === level);
    }

    // 搜索
    if (search) {
      alerts = alerts.filter(
        (a) =>
          a.message.toLowerCase().includes(search) ||
          (a.endpoint || "").toLowerCase().includes(search) ||
          (a.error || "").toLowerCase().includes(search)
      );
    }

    // 排序：最新的优先
    alerts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const total = alerts.length;
    const paged = alerts.slice(offset, offset + limit);

    Logger.info("[Admin] alerts queried", {
      total,
      unresolved: summary.unresolved,
      page,
      limit,
      level,
      hasSearch: !!search,
    });

    return json({
      success: true,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      summary,
      alerts: paged,
    });
  } catch (e: any) {
    Logger.error("[Admin] alerts query error", { error: e.message });
    return json({ error: e.message }, 500);
  }
}

// ============ 解决报警 ============

export async function handleResolveAlert(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return json({ error: "缺少报警 ID" }, 400);
    }

    alertService.init(env.CLAWBOT_KV);
    const success = await alertService.resolveAlert(id);

    if (!success) {
      return json({ error: "报警未找到或已解决" }, 404);
    }

    Logger.info("[Admin] alert resolved", { id });

    return json({ success: true, message: "报警已解决" });
  } catch (e: any) {
    Logger.error("[Admin] resolve alert error", { error: e.message });
    return json({ error: e.message }, 500);
  }
}

export async function handleResolveAllAlerts(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    alertService.init(env.CLAWBOT_KV);
    const count = await alertService.resolveAllAlerts();

    Logger.info("[Admin] all alerts resolved", { count });

    return json({ success: true, resolved: count, message: `已解决 ${count} 条报警` });
  } catch (e: any) {
    Logger.error("[Admin] resolve all alerts error", { error: e.message });
    return json({ error: e.message }, 500);
  }
}

// ============ 统计数据 ============

export async function handleStats(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  try {
    // 从 D1 读取统计（不再从 KV 读）
    let polls = 0, handled = 0, aiCalls = 0, aiFails = 0;
    if (env.CLAWBOT_DB) {
      try {
        const d1 = new D1Service(env.CLAWBOT_DB);
        const stats = await d1.getTotalStats();
        polls = stats.polls;
        handled = stats.handled;
        aiCalls = stats.aiCalls;
        aiFails = stats.aiFails;
      } catch (e) {
        Logger.warn("[Admin] D1 stats read failed", { error: (e as Error).message });
      }
    }

    // 报警摘要（内存）
    const alertSummary = alertService.getSummary();

    // 会话数（从 KV list，这个是低频操作）
    const { keys: contextKeys } = await env.CLAWBOT_KV.list({ prefix: "clawbot:context:" });

    Logger.info("[Admin] stats queried");

    return json({
      success: true,
      dailyStats: [
        {
          date: new Date().toISOString().split("T")[0],
          polls,
          handled,
          ai_calls: aiCalls,
          ai_fails: aiFails,
          average_latency_ms: 0,
        },
      ],
      totalSessions: contextKeys.length,
      totalPolls: polls,
      totalHandled: handled,
      totalAICalls: aiCalls,
      totalAIFails: aiFails,
      alertSummary,
    });
  } catch (e: any) {
    Logger.error("[Admin] stats query error", { error: e.message });
    return json({ error: e.message }, 500);
  }
}

// ============ 健康检查 ============

export async function handleHealth(request: Request, env: Env): Promise<Response> {
  try {
    // 使用缓存 - 避免频繁重复读取
    const cached = statusCache.get<{
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
    }>("health");

    if (cached) return json(cached);

    // 检查 KV
    const kvCheck = await env.CLAWBOT_KV.get("clawbot:credentials")
      .then(() => "OK")
      .catch(() => "FAIL");

    // 统计（从 D1 读取，不再从 KV）
    let totalPolls = 0, totalHandled = 0, totalAICalls = 0, totalAIFails = 0;
    if (env.CLAWBOT_DB) {
      try {
        const d1 = new D1Service(env.CLAWBOT_DB);
        const stats = await d1.getTotalStats();
        totalPolls = stats.polls;
        totalHandled = stats.handled;
        totalAICalls = stats.aiCalls;
        totalAIFails = stats.aiFails;
      } catch (e) {
        Logger.warn("[Admin] D1 stats read failed", { error: (e as Error).message });
      }
    }

    // 报警（内存）
    const alertSummary = alertService.getSummary();

    // 登录状态
    const loginCheck = await env.CLAWBOT_KV.get("clawbot:credentials");

    const healthStatus = {
      kv: kvCheck,
      loggedIn: !!loginCheck,
      totalPolls,
      totalHandled,
      totalAICalls,
      totalAIFails,
      unresolvedAlerts: alertSummary.unresolved,
      criticalAlerts: alertSummary.byLevel.critical,
      errorAlerts: alertSummary.byLevel.error,
      warningAlerts: alertSummary.byLevel.warning,
      timestamp: new Date().toISOString(),
    };

    // 缓存 3 秒
    statusCache.set("health", healthStatus, 3000);

    return json(healthStatus);
  } catch (e: any) {
    Logger.error("[Admin] health check error", { error: e.message });
    return json({ success: false, error: e.message }, 500);
  }
}
