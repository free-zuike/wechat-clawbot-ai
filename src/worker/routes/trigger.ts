import { json } from "../utils";
import type { Env } from "../index";

export async function handleTriggerPoll(request: Request, env: Env): Promise<Response> {
  const doId = env.ILINK_CONNECTION.idFromName("main");
  const doStub = env.ILINK_CONNECTION.get(doId);

  const doResponse = await doStub.fetch(new Request("http://localhost/poll"));
  const data = await doResponse.json();
  return json(data);
}
