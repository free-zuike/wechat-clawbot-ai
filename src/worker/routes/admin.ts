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

    // 优先从 D1 读取，和当前 DO 主链路保持一致
    if (env.CLAWBOT_DB) {
      try {
        const d1 = new D1Service(env.CLAWBOT_DB);
        await d1.init();
        const rows = await d1.getRecentMessages(limit, offset, search);
        const total = await d1.countMessages(search);

        return json({
          success: true,
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit) || 1,
          messages: rows.map((row) => ({
            from_user_id: row.from_user_id,
            content_preview: String(row.content || "").slice(0, 200) || "（无文本内容）",
            timestamp: row.created_at,
            message_type: row.message_type || 1,
            context_token: row.context_token || "",
          })),
          source: "d1",
        });
      } catch (e) {
        Logger.warn("[Admin] D1 messages query failed, fallback to KV", { error: (e as Error).message });
      }
    }

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

    // 优先从 D1 sessions 表读取，KV context 已不是当前主存储
    if (env.CLAWBOT_DB) {
      try {
        const d1 = new D1Service(env.CLAWBOT_DB);
        await d1.init();
        const rows = await d1.getSessions(limit, offset, search);
        const filteredTotal = await d1.countSessions(search);

        return json({
          success: true,
          total: filteredTotal,
          page,
          limit,
          totalPages: Math.ceil(filteredTotal / limit) || 1,
          sessions: rows.map((row) => ({
            from_user_id: row.user_id,
            message_count: row.message_count || 0,
            last_message_at: row.last_message_at || row.updated_at,
            first_message_at: row.created_at,
          })),
          source: "d1",
        });
      } catch (e) {
        Logger.warn("[Admin] D1 sessions query failed, fallback to KV", { error: (e as Error).message });
      }
    }

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
        await d1.init();
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

    // 优先使用 D1 的真实会话数，KV 仅作兼容兜底
    let totalSessions = 0;
    if (env.CLAWBOT_DB) {
      try {
        const d1 = new D1Service(env.CLAWBOT_DB);
        await d1.init();
        totalSessions = await d1.getSessionCount();
      } catch (e) {
        Logger.warn("[Admin] D1 session count read failed", { error: (e as Error).message });
      }
    }
    if (!totalSessions) {
      const { keys: contextKeys } = await env.CLAWBOT_KV.list({ prefix: "clawbot:context:" });
      totalSessions = contextKeys.length;
    }

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
