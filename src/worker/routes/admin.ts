// 管理路由 - 消息查询、会话管理、报警查询、统计数据
// 优化：分页支持 + 搜索过滤 + 响应缓存

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { alertService } from "../utils/alert";
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

    // 从 DO SQLite contexts 表读取会话
    let sessions: Array<{
      from_user_id: string;
      message_count: number;
      last_message_at: string;
    }> = [];

    try {
      const doId = env.ILINK_CONNECTION.idFromName("main");
      const doStub = env.ILINK_CONNECTION.get(doId);
      const resp = await doStub.fetch(new Request("http://localhost/status"), { signal: AbortSignal.timeout(3000) });
      const doStatus = await resp.json() as any;

      // 从 DO 的 WebSocket 广播记录或 pendingMessages 获取会话信息
      // 简化：直接从 DO SQLite 读取
      const sqlResp = await doStub.fetch(new Request("http://localhost/sqlite/contexts"), { signal: AbortSignal.timeout(3000) });
      const sqlData = await sqlResp.json() as { rows?: Array<{ user_id: string; last_updated: number }> };

      if (sqlData?.rows) {
        sessions = sqlData.rows.map((row) => ({
          from_user_id: row.user_id,
          message_count: 0,
          last_message_at: new Date(row.last_updated).toISOString(),
        }));
      }
    } catch (e) {
      Logger.warn("[Admin] DO sessions query failed", { error: (e as Error).message });
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
    const url = new URL(request.url);
    const page = parsePage(url);
    const limit = parseLimit(url);

    // 会话数（KV context）
    let totalSessions = 0;
    try {
      const { keys: contextKeys } = await env.CLAWBOT_KV.list({ prefix: "clawbot:context:" });
      totalSessions = contextKeys.length;
    } catch (_e) {}
    const alertSummary = alertService.getSummary();

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
      totalSessions,
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

    // 登录状态从 DO 读取
    let loggedIn = false;
    try {
      const doId = env.ILINK_CONNECTION.idFromName("main");
      const doStub = env.ILINK_CONNECTION.get(doId);
      const doResp = await doStub.fetch(new Request("http://localhost/status"), { signal: AbortSignal.timeout(3000) });
      const doData = await doResp.json() as { hasCredentials?: boolean };
      loggedIn = !!doData?.hasCredentials;
    } catch (_e) {}

    const healthStatus = {
      kv: "OK",
      loggedIn,
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
