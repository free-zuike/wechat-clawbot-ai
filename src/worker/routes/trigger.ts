import { json, verifyAdmin } from "../utils";
import { processIncomingMessages } from "../services/messaging";
import type { Env } from "../index";

export async function handleTriggerPoll(request: Request, env: Env): Promise<Response> {
  const v = verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);
  const result = await processIncomingMessages(env);
  return json(result);
}
