// 用户事实记忆 - 最小可用版
// AI 通过 remember_fact 工具写入；每次对话前把当前事实注入 system prompt
// 不做自动抽取与冲突检测（人工在后台面板治理）

export interface UserFact {
  userId: string;
  fact: string;
  createdAt: number;
  updatedAt: number;
}

export async function ensureFactsTable(db: D1Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_facts (
      user_id TEXT NOT NULL,
      fact TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, fact)
    )
  `);
}

export async function loadFactsForUser(db: D1Database, userId: string): Promise<UserFact[]> {
  try {
    await ensureFactsTable(db);
    const { results } = await db.prepare(
      `SELECT user_id, fact, created_at, updated_at FROM user_facts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200`
    ).bind(userId).all();
    return (results || []).map((r: any) => ({
      userId: r.user_id, fact: r.fact, createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  } catch {
    return [];
  }
}

export async function loadAllFacts(db: D1Database): Promise<UserFact[]> {
  try {
    await ensureFactsTable(db);
    const { results } = await db.prepare(
      `SELECT user_id, fact, created_at, updated_at FROM user_facts ORDER BY updated_at DESC LIMIT 500`
    ).all();
    return (results || []).map((r: any) => ({
      userId: r.user_id, fact: r.fact, createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  } catch {
    return [];
  }
}

export async function saveFact(db: D1Database, userId: string, fact: string): Promise<void> {
  const clean = (fact || "").trim();
  if (!clean || !userId) return;
  if (clean.length > 500) return;
  await ensureFactsTable(db);
  const now = Date.now();
  await db.prepare(
    `INSERT INTO user_facts (user_id, fact, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, fact) DO UPDATE SET updated_at = excluded.updated_at`
  ).bind(userId, clean, now, now).run();
}

export async function deleteFact(db: D1Database, userId: string, fact: string): Promise<boolean> {
  await ensureFactsTable(db);
  const res = await db.prepare(`DELETE FROM user_facts WHERE user_id = ? AND fact = ?`).bind(userId, fact).run();
  return (res.meta?.changes || 0) > 0;
}

// 把事实列表拼成 system prompt 片段
export function factsToPrompt(facts: UserFact[]): string {
  if (!facts || facts.length === 0) return "";
  const lines = facts.map((f) => `- ${f.fact}`).join("\n");
  return `【关于用户的已知事实】（以下是此前对话中用户告知的事实，回答时优先参考；如用户后来更正，以最新说法为准）\n${lines}`;
}
