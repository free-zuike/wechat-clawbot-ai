// 定时消息（DO Alarm 版）
// 微信侧指令：/提醒 <时间> <内容> 或 直接说「提醒我/定时提醒...」
//   时间格式：30分钟后 / 1小时后 / 2天后 / 明天早上8点 / 晚上10:30 / 每天早上8点 / 每周一9点 / 每月1日10点
//   管理指令：/提醒列表 / 提醒取消 <编号> / 提醒清空

export interface ScheduledMessageRow {
  id: string;
  account_id: string | null;
  to_user_id: string | null;
  context_token: string | null;
  content: string;
  run_at: number;
  repeat_interval: number; // 0 = 一次性
  status: "pending" | "sent" | "cancelled";
  created_at: number;
}

export interface ReminderCommand {
  kind: "create" | "list" | "cancel" | "clear" | null;
  runAt?: number;
  repeatInterval?: number;
  content?: string;
  cancelId?: string;
}

// ========== 时间解析 ==========

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_MAP: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const CHINA_OFFSET_MS = 8 * 3600000; // 中国固定 UTC+8（无夏令时），纯算术转换，避免依赖 Intl/进程时区（CI/Worker 均为 UTC）

// 取 ts 在中国时区（UTC+8）的日历字段
// 注意：不能依赖 Intl.DateTimeFormat 的 timeZone 选项（vitest/CI 环境实测不生效），也不能依赖进程本地时区（Worker 是 UTC）
function chinaParts(ts: number): { year: number; month: number; day: number; weekday: number; hour: number; minute: number } {
  const d = new Date(ts + CHINA_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

// ts 所在的中国时区"当天 00:00:00"对应的 UTC 时间戳
function chinaDayStart(ts: number): number {
  const p = chinaParts(ts);
  return Date.UTC(p.year, p.month, p.day) - CHINA_OFFSET_MS;
}

// 把"3点/3:30/凌晨/早上/上午/中午/下午/晚上"等时间描述解析为今天的毫秒偏移
function parseTimeOfDay(token: string): number | null {
  const t = token.trim();
  if (!t) return null;
  let hour = -1;
  let minute = 0;
  const hm = t.match(/(\d{1,2})[：:](\d{1,2})/);
  const hOnly = t.match(/(\d{1,2})\s*点/);
  if (hm) {
    hour = parseInt(hm[1], 10);
    minute = parseInt(hm[2], 10);
  } else if (hOnly) {
    hour = parseInt(hOnly[1], 10);
  }
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  if (t.includes("凌晨") && hour < 12) hour = hour === 0 ? 0 : hour;
  if (t.includes("早上") || t.includes("上午")) { if (hour < 6) hour += 12; }
  if (t.includes("中午") && hour < 11) hour += 12;
  if (t.includes("下午") || t.includes("晚上")) { if (hour < 12) hour += 12; }
  return hour * 3600000 + minute * 60000;
}

// 把"每X小时/每X分钟/每隔X天"解析为毫秒间隔
function parseIntervalToken(token: string): number | null {
  const m = token.match(/(?:每|每隔)\s*(\d+)\s*(秒|秒钟|分钟|分|小时|钟头|天|日|周)/);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  if (!num || num <= 0) return null;
  const unit = m[2];
  if (unit.includes("秒")) return num * 1000;
  if (unit.includes("分")) return num * 60000;
  if (unit.includes("小时") || unit.includes("钟头")) return num * 3600000;
  if (unit.includes("天") || unit.includes("日")) return num * DAY_MS;
  if (unit.includes("周")) return num * 7 * DAY_MS;
  return null;
}

// 解析相对时间："30分钟后" / "2小时后" / "1天后" / "明天早上8点" / "下周一9点" / "3点"
function parseRelativeTime(input: string, now = Date.now()): { runAt: number; interval: number; matched: string } | null {
  const m = input.match(/^(\d+)\s*(秒|秒钟|分钟|分|小时|钟头|天|日|周)\s*(后|之后|以后)?/);
  if (m) {
    const num = parseInt(m[1], 10);
    const unit = m[2];
    let ms = 0;
    if (unit.includes("秒")) ms = num * 1000;
    else if (unit.includes("分")) ms = num * 60000;
    else if (unit.includes("小时") || unit.includes("钟头")) ms = num * 3600000;
    else if (unit.includes("天") || unit.includes("日")) ms = num * DAY_MS;
    else if (unit.includes("周")) ms = num * 7 * DAY_MS;
    return { runAt: now + ms, interval: 0, matched: m[0] };
  }

  const dayMatch = input.match(/^(今天|明天|后天|大后天)/);
  let baseDay = 0;
  if (dayMatch) {
    const d = dayMatch[1];
    if (d === "明天") baseDay = 1;
    else if (d === "后天") baseDay = 2;
    else if (d === "大后天") baseDay = 3;
    else baseDay = 0;
  }
  const rest = dayMatch ? input.slice(dayMatch[0].length) : input;
  const timeOfDay = parseTimeOfDay(rest);
  if (timeOfDay !== null) {
    const dayStart = chinaDayStart(now);
    let runAt = dayStart + baseDay * DAY_MS + timeOfDay;
    if (runAt <= now) runAt += DAY_MS;
    return { runAt, interval: 0, matched: input.trim() };
  }
  return null;
}

// 解析重复时间："每天早上8点" / "每周一9点" / "每周一 9:30" / "每月1日10点" / "每2小时" / "每隔30分钟"
// 返回 runAt / interval / matched（被消费的时间表达式长度，内容从 matched 之后取）
function parseRepeatTime(input: string, now = Date.now()): { runAt: number; interval: number; matched: string } | null {
  const dailyMatch = input.match(/^(每天|每日)\s*([^，,。\s]+)/);
  if (dailyMatch) {
    const timeOfDay = parseTimeOfDay(dailyMatch[2]);
    if (timeOfDay !== null) {
      const dayStart = chinaDayStart(now);
      let runAt = dayStart + timeOfDay;
      if (runAt <= now) runAt += DAY_MS;
      return { runAt, interval: DAY_MS, matched: dailyMatch[0] };
    }
  }

  // 每周X + 时间：时间表达式以 点/HH:MM 开头，后面才是内容
  const weeklyMatch = input.match(/^(每周|每星期)\s*([日天一二三四五六])\s*((?:\d{1,2}\s*点|\d{1,2}[：:]\d{1,2}|早上|上午|中午|下午|晚上)[^，,。\s]*)/);
  if (weeklyMatch) {
    const target = WEEKDAY_MAP[weeklyMatch[2]];
    const timeOfDay = parseTimeOfDay(weeklyMatch[3]);
    if (target !== undefined && timeOfDay !== null) {
      const dayStart = chinaDayStart(now);
      const currentDay = chinaParts(now).weekday;
      let diff = target - currentDay;
      if (diff <= 0) diff += 7;
      let runAt = dayStart + diff * DAY_MS + timeOfDay;
      if (runAt <= now) runAt += 7 * DAY_MS;
      return { runAt, interval: 7 * DAY_MS, matched: weeklyMatch[0] };
    }
  }

  // 每月X日/号 + 时间
  const monthlyMatch = input.match(/^(每月|每个月)\s*(\d{1,2})\s*(?:日|号)\s*((?:\d{1,2}\s*点|\d{1,2}[：:]\d{1,2}|早上|上午|中午|下午|晚上)[^，,。\s]*)/);
  if (monthlyMatch) {
    const dayNum = parseInt(monthlyMatch[2], 10);
    const timeOfDay = parseTimeOfDay(monthlyMatch[3]);
    if (dayNum >= 1 && dayNum <= 31 && timeOfDay !== null) {
      const nowDate = chinaParts(now);
      const nowDay = nowDate.day;
      const targetMs = timeOfDay;
      const year = nowDate.year;
      const month = nowDate.month;
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const targetDay = Math.min(dayNum, lastDay);
      let runAt = Date.UTC(year, month, targetDay) - CHINA_OFFSET_MS + targetMs;
      if (runAt <= now || (nowDay > dayNum && targetDay === dayNum)) {
        const nextMonth = month + 1;
        const nextYear = nextMonth > 11 ? year + 1 : year;
        const m = nextMonth > 11 ? 0 : nextMonth;
        const nextLastDay = new Date(Date.UTC(nextYear, m + 1, 0)).getUTCDate();
        runAt = Date.UTC(nextYear, m, Math.min(dayNum, nextLastDay)) - CHINA_OFFSET_MS + targetMs;
      }
      return { runAt, interval: 0, matched: monthlyMatch[0] };
    }
  }

  // 每X小时/每隔X分钟（间隔重复）
  const intervalMatch = input.match(/^(每|每隔)\s*(\d+)\s*(秒|秒钟|分钟|分|小时|钟头|天|日|周)/);
  if (intervalMatch) {
    const interval = parseIntervalToken(intervalMatch[0]);
    if (interval !== null) {
      return { runAt: now + interval, interval, matched: intervalMatch[0] };
    }
  }
  return null;
}

// 主解析入口
export function parseReminderCommand(text: string, now = Date.now()): ReminderCommand {
  let clean = (text || "").trim();
  // 去掉指令前缀：/提醒 /定时提醒 /闹钟 /提醒我 /帮我提醒
  clean = clean.replace(/^[\/／](提醒|定时提醒|闹钟)\s*/i, "");
  clean = clean.replace(/^(提醒我|帮我提醒)\s*/, "");
  if (!clean) return { kind: null };

  // 管理子命令
  if (/^(列表|查看|list)/i.test(clean)) return { kind: "list" };
  if (/^(清空|删除所有|全部删除)/i.test(clean)) return { kind: "clear" };
  const cancelMatch = clean.match(/^(取消|删除|撤销)\s*(?:编号\s*)?([A-Za-z0-9_]{4,})/);
  if (cancelMatch) return { kind: "cancel", cancelId: cancelMatch[2] };

  // 先尝试重复模式（每天/每周/每月/每X小时 在前）
  const repeat = parseRepeatTime(clean, now);
  if (repeat) {
    return {
      kind: "create",
      runAt: repeat.runAt,
      repeatInterval: repeat.interval,
      content: clean.slice(repeat.matched.length).trim() || "定时提醒",
    };
  }

  const rel = parseRelativeTime(clean, now);
  if (rel) {
    return {
      kind: "create",
      runAt: rel.runAt,
      repeatInterval: rel.interval,
      content: clean.slice(rel.matched.length).trim() || "定时提醒",
    };
  }
  return { kind: null };
}

// 人类可读的下次执行时间（按中国时区显示）
export function formatRunAt(ts: number, now = Date.now()): string {
  const d = chinaParts(ts);
  const n = chinaParts(now);
  const tomorrow = new Date(now + DAY_MS);
  const t = chinaParts(tomorrow.getTime());
  const timeStr = `${String(d.hour).padStart(2, "0")}:${String(d.minute).padStart(2, "0")}`;
  if (d.year === n.year && d.month === n.month && d.day === n.day) return `今天 ${timeStr}`;
  if (d.year === t.year && d.month === t.month && d.day === t.day) return `明天 ${timeStr}`;
  return `${d.month + 1}月${d.day}日 ${timeStr}`;
}

export function formatRepeat(interval: number): string {
  if (!interval) return "一次性";
  if (interval % DAY_MS === 0) return `每 ${interval / DAY_MS} 天`;
  if (interval % 3600000 === 0) return `每 ${interval / 3600000} 小时`;
  if (interval % 60000 === 0) return `每 ${interval / 60000} 分钟`;
  return "重复";
}

// ========== D1 操作 ==========

export async function ensureScheduledTable(db: D1Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      to_user_id TEXT,
      context_token TEXT,
      content TEXT NOT NULL,
      run_at INTEGER NOT NULL,
      repeat_interval INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_status_run ON scheduled_messages(status, run_at)`);
}

export async function createScheduledMessage(
  db: D1Database,
  params: { accountId?: string; toUserId?: string; contextToken?: string; content: string; runAt: number; repeatInterval?: number }
): Promise<string> {
  await ensureScheduledTable(db);
  const id = `rm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await db.prepare(
    `INSERT INTO scheduled_messages (id, account_id, to_user_id, context_token, content, run_at, repeat_interval, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).bind(
    id,
    params.accountId || null,
    params.toUserId || null,
    params.contextToken || null,
    params.content,
    params.runAt,
    params.repeatInterval || 0,
    Date.now()
  ).run();
  return id;
}

export async function listScheduledMessages(db: D1Database, limit = 100): Promise<ScheduledMessageRow[]> {
  await ensureScheduledTable(db);
  const { results } = await db.prepare(
    `SELECT id, account_id, to_user_id, context_token, content, run_at, repeat_interval, status, created_at
     FROM scheduled_messages WHERE status = 'pending' ORDER BY run_at ASC LIMIT ?`
  ).bind(limit).all();
  return (results || []) as unknown as ScheduledMessageRow[];
}

// 找出下一个待执行任务（用于 setAlarm）
export async function nextPendingRunAt(db: D1Database): Promise<number | null> {
  await ensureScheduledTable(db);
  const { results } = await db.prepare(
    `SELECT run_at FROM scheduled_messages WHERE status = 'pending' ORDER BY run_at ASC LIMIT 1`
  ).all();
  const row = results?.[0] as { run_at?: number } | undefined;
  return row && typeof row.run_at === "number" ? row.run_at : null;
}

// 取出所有已到期任务并标记为 sending（防重复），返回明细
export async function claimDueMessages(db: D1Database, now = Date.now()): Promise<ScheduledMessageRow[]> {
  await ensureScheduledTable(db);
  const { results } = await db.prepare(
    `SELECT id, account_id, to_user_id, context_token, content, run_at, repeat_interval, status, created_at
     FROM scheduled_messages WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC LIMIT 20`
  ).bind(now).all();
  const rows = (results || []) as unknown as ScheduledMessageRow[];
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  await db.prepare(`UPDATE scheduled_messages SET status = 'sent' WHERE id IN (${placeholders})`).bind(...ids).run();
  return rows;
}

// 重复任务：推进到下一个周期并重新置为 pending
export async function requeueRecurring(db: D1Database, row: ScheduledMessageRow, now = Date.now()): Promise<void> {
  if (!row.repeat_interval) return;
  let next = row.run_at + row.repeat_interval;
  while (next <= now) next += row.repeat_interval;
  await db.prepare(
    `UPDATE scheduled_messages SET status = 'pending', run_at = ? WHERE id = ?`
  ).bind(next, row.id).run();
}

export async function cancelScheduledMessage(db: D1Database, id: string): Promise<boolean> {
  await ensureScheduledTable(db);
  const res = await db.prepare(
    `UPDATE scheduled_messages SET status = 'cancelled' WHERE id = ? AND status = 'pending'`
  ).bind(id).run();
  return (res.meta?.changes || 0) > 0;
}

export async function clearScheduledMessages(db: D1Database): Promise<number> {
  await ensureScheduledTable(db);
  const res = await db.prepare(
    `UPDATE scheduled_messages SET status = 'cancelled' WHERE status = 'pending'`
  ).run();
  return res.meta?.changes || 0;
}
