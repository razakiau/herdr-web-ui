/**
 * POST /api/agent-ask (ZAC-326): a question an agent asks without stopping its turn
 * (`ask_user_async`), from the shim's MCP server on this PC. It names its chat by the SDK session
 * the shim knows; the bridge files it under the host row that session runs on, and the chat's card
 * shows it. Only this PC's bridge answers it (server/index.ts): it is never forwarded to another PC.
 */
import { badRequest, isJsonObject, jsonResponse } from "../http.ts";
import type { AskKind, AsyncAskStore } from "./async-ask.ts";
import { rowOfSdkHere, type AgentHost } from "./routes.ts";

export const AGENT_ASK_PATH = "/api/agent-ask";

const QUESTION_MAX = 4_000;
const OPTIONS_MAX = 20;
const LABEL_MAX = 500;

type Ask = { sdk: string; question: string; options: { label: string; description?: string }[]; recommended: number | null; kind: AskKind };

/** The body's question, or a refusal that says what is wrong with it. */
function askOf(body: Record<string, unknown>): Ask | Response {
  const { sdk_session: sdk, question, options, recommended, kind } = body;
  if (typeof sdk !== "string" || sdk === "") return badRequest("missing_sdk_session", "sdk_session is required");
  if (typeof question !== "string" || question.trim() === "" || question.length > QUESTION_MAX) return badRequest("invalid_question", `question must be text of at most ${QUESTION_MAX} characters`);
  if (kind !== "optional" && kind !== "blocking") return badRequest("invalid_kind", "kind must be \"optional\" or \"blocking\"");
  if (!Array.isArray(options) || options.length === 0 || options.length > OPTIONS_MAX) return badRequest("invalid_options", `options must list 1 to ${OPTIONS_MAX} choices`);
  const parsed: Ask["options"] = [];
  for (const option of options) {
    if (!isJsonObject(option)) return badRequest("invalid_options", "each option must be an object");
    const { label, description } = option;
    if (typeof label !== "string" || label.trim() === "" || label.length > LABEL_MAX) return badRequest("invalid_options", "each option needs a label");
    if (description !== undefined && typeof description !== "string") return badRequest("invalid_options", "an option's description must be text");
    parsed.push(description === undefined ? { label } : { label, description });
  }
  if (recommended !== undefined && recommended !== null && !(Number.isInteger(recommended) && (recommended as number) >= 0 && (recommended as number) < parsed.length)) {
    return badRequest("invalid_recommended", "recommended must be the 0-based index of one of the options");
  }
  return { sdk, question, options: parsed, recommended: (recommended as number | null | undefined) ?? null, kind };
}

/** Files the question under its chat's row; `changed` tells the pages to read the chat again. */
export async function handleAgentAsk(request: Request, host: AgentHost, asks: AsyncAskStore, changed: (session: string) => void, rowOf: (sdk: string) => string | null = (sdk) => rowOfSdkHere(host, sdk)): Promise<Response> {
  if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
  let payload: unknown;
  try { payload = await request.json(); } catch { return badRequest("invalid_body", "request body must be a JSON object"); }
  if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
  const ask = askOf(payload);
  if (ask instanceof Response) return ask;
  const session = rowOf(ask.sdk);
  if (session === null) return jsonResponse({ error: { code: "no_chat", message: "no host chat on this PC runs on that session" } }, 404);
  const q = asks.add({ session, question: ask.question, options: ask.options, recommended: ask.recommended, kind: ask.kind });
  changed(session);
  return jsonResponse({ accepted: true, id: q.id });
}
