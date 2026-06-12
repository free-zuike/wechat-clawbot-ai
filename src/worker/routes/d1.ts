// D1 数据库查询路由 - 消息列表、会话列表、统计数据

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { D1Service } from "../services/d1";
import { statusCache } from "../utils/cache";
import type { Env } from "../index";

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

function getD1(env: Env): D1Service | null {
  if (!env.CLAWBOT_DB) return null;
  return new D1Service(env.CLAWBOT_DB);
}

// ============ D1 消息查询 ============

export async function handleD1Messages(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  const d1 = getD1(env);
  if (!d1) return json({ success: false, error: "D1 database not available", messages: [], total: 0 }, 503);

  try {
    await d1.init();
    const url = new URL(request.url);
    const limit = parseLimit(url);
    const page = parsePage(url);
    const userId = url.searchParams.get("user_id");
    const search = url.searchParams.get("search")?.toLowerCase() || "";

    let messages: any[] = [];
    let total = 0;

    if (userId) {
      messages = await d1.getMessagesByUser(userId, limit);
      total = messages.length;
    } else {
      // 从消息表中查询（D1 API 没有 COUNT + WHERE，先拿数据再过滤）
      const allMessages = await d1.getUnprocessedMessages(limit * 5);
      // 尝试获取所有消息（通过一个宽范围的已处理消息）
      try {
        // 直接使用 raw SQL 查询带分页和搜索
        const sql = search
          ? `SELECT * FROM messages WHERE LOWER(content) LIKE ? ORDER BY created_at DESC LIMIT ?`
          : `SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`;
        const params = search ? [`%${search}%`, limit] : [limit];
        messages = await env.CLAWBOT_DB.prepare(sql).bind(...params).all() as any;
        messages = messages?.results || [];

        // 总数
        const countResult = await env.CLAWBOT_DB.prepare(
          search ? `SELECT COUNT(*) as cnt FROM messages WHERE LOWER(content) LIKE ?` : `SELECT COUNT(*) as cnt FROM messages`
        ).bind(...(search ? [`%${search}%`] : [])).first<number>("cnt");
        total = countResult || 0;
      } catch (e) {
        total = allMessages.length;
      }
    }

    Logger.info("[D1] messages query", { total, page, limit, hasSearch: !!search, userId: !!userId });

    return json({
      success: true,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      messages,
    });
  } catch (e: any) {
    Logger.error("[D1] messages query error", { error: e.message });
    return json({ success: false, error: e.message, messages: [], total: 0 }, 500);
  }
}

// ============ D1 会话查询 ============

export async function handleD1Sessions(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  const d1 = getD1(env);
  if (!d1) return json({ success: false, error: "D1 database not available", sessions: [], total: 0 }, 503);

  try {
    await d1.init();
    const url = new URL(request.url);
    const limit = parseLimit(url);
    const page = parsePage(url);
    const search = url.searchParams.get("search")?.toLowerCase() || "";

    // 基础查询
    let sql = `SELECT * FROM sessions`;
    let countSql = `SELECT COUNT(*) as cnt FROM sessions`;
    const params: any[] = [];
    const countParams: any[] = [];

    if (search) {
      sql += ` WHERE LOWER(user_id) LIKE ?`;
      countSql += ` WHERE LOWER(user_id) LIKE ?`;
      params.push(`%${search}%`);
      countParams.push(`%${search}%`);
    }

    sql += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(limit);

    const sessionsResult = await env.CLAWBOT_DB.prepare(sql).bind(...params).all() as any;
    const sessions = sessionsResult?.results || [];

    const total = await env.CLAWBOT_DB.prepare(countSql).bind(...countParams).first<number>("cnt") || 0;

    Logger.info("[D1] sessions query", { total, page, limit, hasSearch: !!search });

    return json({
      success: true,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      sessions,
    });
  } catch (e: any) {
    Logger.error("[D1] sessions query error", { error: e.message });
    return json({ success: false, error: e.message, sessions: [], total: 0 }, 500);
  }
}

// ============ D1 统计查询 ============

export async function handleD1Stats(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  const d1 = getD1(env);
  if (!d1) return json({ success: false, error: "D1 database not available" }, 503);

  try {
    await d1.init();
    const url = new URL(request.url);
    const days = parseInt(url.searchParams.get("days") || "7", 10);
    const validDays = Math.max(1, Math.min(30, days));

    // 获取过去N天的统计数据
    const today = new Date();
    const startDate = new Date(today.getTime() - (validDays - 1) * 24 * 60 * 60 * 1000);
    const startStr = startDate.toISOString().split("T")[0];
    const endStr = today.toISOString().split("T")[0];

    const dailyStats = await d1.getStatsRange(startStr, endStr);

    // 获取汇总数据
    const totalStats = await d1.getTotalStats();

    // 获取消息数和会话数
    const totalMessages = await d1.getMessageCount();
    const totalSessions = await d1.getSessionCount();

    Logger.info("[D1] stats query", { days: validDays, range: `${startStr} - ${endStr}` });

    return json({
      success: true,
      range: { start: startStr, end: endStr, days: validDays },
      dailyStats,
      totals: {
        ...totalStats,
        totalMessages,
        totalSessions,
      },
    });
  } catch (e: any) {
    Logger.error("[D1] stats query error", { error: e.message });
    return json({ success: false, error: e.message }, 500);
  }
}

// ============ D1 数据库摘要（快速概览） ============

export async function handleD1Summary(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  // 使用缓存 - 避免频繁重复查询
  const cached = statusCache.get<{
    success: boolean;
    d1Available: boolean;
    totalMessages: number;
    totalSessions: number;
    totalPolls: number;
    totalHandled: number;
    totalAICalls: number;
    totalAIFails: number;
    todayMessages: number;
    todayPolls: number;
    timestamp: string;
  }>("d1-summary");

  if (cached) return json(cached);

  const d1 = getD1(env);
  if (!d1) {
    const result = {
      success: true,
      d1Available: false,
      totalMessages: 0,
      totalSessions: 0,
      totalPolls: 0,
      totalHandled: 0,
      totalAICalls: 0,
      totalAIFails: 0,
      todayMessages: 0,
      todayPolls: 0,
      timestamp: new Date().toISOString(),
    };
    statusCache.set("d1-summary", result, 3000);
    return json(result);
  }

  try {
    await d1.init();

    const totalMessages = await d1.getMessageCount();
    const totalSessions = await d1.getSessionCount();
    const totals = await d1.getTotalStats();

    // 今日统计
    const todayStr = d1.getTodayDate();
    const todayStats = await d1.getStatsByDate(todayStr);

    // 今日消息数
    let todayMessages = 0;
    try {
      todayMessages = await env.CLAWBOT_DB
        .prepare(`SELECT COUNT(*) as cnt FROM messages WHERE DATE(created_at) = ?`)
        .bind(todayStr)
        .first<number>("cnt") || 0;
    } catch {
      todayMessages = 0;
    }

    const result = {
      success: true,
      d1Available: true,
      totalMessages,
      totalSessions,
      totalPolls: totals.polls,
      totalHandled: totals.handled,
      totalAICalls: totals.aiCalls,
      totalAIFails: totals.aiFails,
      todayMessages,
      todayPolls: todayStats?.polls || 0,
      timestamp: new Date().toISOString(),
    };

    statusCache.set("d1-summary", result, 3000);
    return json(result);
  } catch (e: any) {
    Logger.error("[D1] summary query error", { error: e.message });
    const result = {
      success: false,
      d1Available: true,
      error: e.message,
      totalMessages: 0,
      totalSessions: 0,
      totalPolls: 0,
      totalHandled: 0,
      totalAICalls: 0,
      totalAIFails: 0,
      todayMessages: 0,
      todayPolls: 0,
      timestamp: new Date().toISOString(),
    };
    return json(result);
  }
}
