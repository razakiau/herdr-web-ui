/**
 * POST /api/agent-ask (ZAC-326): a question an agent asks without stopping its turn
 * (`ask_user_async`), from the shim's MCP server on this PC. It names its chat by the SDK session
 * the shim knows; the bridge files it under the host row that session runs on, and the chat's card
 * shows it. Only this PC's bridge answers it (server/index.ts): it is never forwarded to another PC.
 */
import { badRequest, isJsonObject, jsonResponse } from "../http.ts";
import type { AskKind, AsyncAskStore, AsyncField } from "./async-ask.ts";
import { rowOfSdkHere, type AgentHost } from "./routes.ts";

export const AGENT_ASK_PATH = "/api/agent-ask";

const QUESTION_MAX = 4_000;
/** what ask_user's `message` carries: the context the card shows above the question, as markdown */
const MESSAGE_MAX = 20_000;
const OPTIONS_MAX = 20;
const LABEL_MAX = 500;
const FIELDS_MAX = 20;

type Ask = { sdk: string; question: string; message: string | null; options: { label: string; description?: string }[]; recommended: number | null; kind: AskKind; fields?: AsyncField[] };

const label = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && value.length <= LABEL_MAX;

/** A choice field's options: `enum` (labelled by `enumNames`) or `oneOf`/`anyOf` of `{ const, title }`; a string says what is wrong. */
function choicesOf(where: string, spec: Record<string, unknown>, list: "oneOf" | "anyOf"): AsyncField["options"] | string {
  const { enum: values, enumNames: names } = spec;
  const consts = spec[list];
  let options: AsyncField["options"];
  if (Array.isArray(values)) {
    if (names !== undefined && !(Array.isArray(names) && names.every((each) => typeof each === "string"))) return `${where}: enumNames must list text`;
    if (!values.every((value) => typeof value === "string")) return `${where}: enum must list text`;
    options = (values as string[]).map((value, index) => ({ label: (names as string[] | undefined)?.[index] ?? value, value }));
  } else if (Array.isArray(consts)) {
    options = [];
    for (const each of consts) {
      if (!isJsonObject(each) || typeof each["const"] !== "string" || (each["title"] !== undefined && typeof each["title"] !== "string")) return `${where}: each of ${list} must be { const, title }`;
      options.push({ label: (each["title"] as string | undefined) ?? each["const"], value: each["const"] });
    }
  } else return `${where}: a choice needs enum or ${list}`;
  if (options.length === 0 || options.length > OPTIONS_MAX) return `${where}: list 1 to ${OPTIONS_MAX} choices`;
  if (!options.every((option) => label(option.label))) return `${where}: each choice needs a label of at most ${LABEL_MAX} characters`;
  return options;
}

/** One property of the schema as a field, or what is wrong with it. */
function fieldOf(id: string, spec: unknown, required: boolean): AsyncField | string {
  const where = `field "${id.slice(0, 40)}"`;
  if (!isJsonObject(spec)) return `${where} must be an object`;
  const { type, title, description, default: pick } = spec;
  if (title !== undefined && !label(title)) return `${where}: title must be text of at most ${LABEL_MAX} characters`;
  // the answer is one `<title or id>: …` line a field, read back by them (chats.ts asyncFormParts)
  if (/[\r\n]/.test(id) || (typeof title === "string" && /[\r\n]/.test(title))) return `${where}: an id or title takes no line break`;
  if (description !== undefined && (typeof description !== "string" || description.length > QUESTION_MAX)) return `${where}: description must be text of at most ${QUESTION_MAX} characters`;
  const question = [description, title].find((each): each is string => typeof each === "string" && each.trim() !== "") ?? id;
  const base = { id, title: (title as string | undefined) ?? "", question, required };
  const scalar = typeof pick === "string" || typeof pick === "number" || typeof pick === "boolean" ? String(pick) : undefined;
  if (pick !== undefined && pick !== null && type !== "array" && scalar === undefined) return `${where}: default must be a single value`;
  switch (type) {
    case "array": {
      if (!isJsonObject(spec["items"])) return `${where}: a multi-select needs items`;
      const options = choicesOf(where, spec["items"], "anyOf");
      if (typeof options === "string") return options;
      if (pick !== undefined && pick !== null && !(Array.isArray(pick) && pick.every((each) => typeof each === "string"))) return `${where}: default must list text`;
      return { ...base, options, multi: true, typed: true, ...(Array.isArray(pick) ? { default: pick as string[] } : {}) };
    }
    case "boolean":
      return { ...base, options: [{ label: "Yes", value: "true" }, { label: "No", value: "false" }], multi: false, typed: false, ...(scalar !== undefined ? { default: scalar } : {}) };
    case "string":
    case "number":
    case "integer": {
      // a string with enum or oneOf is a choice; any other is typed text alone
      const choice = type === "string" && (spec["enum"] !== undefined || spec["oneOf"] !== undefined);
      const options = choice ? choicesOf(where, spec, "oneOf") : [];
      if (typeof options === "string") return options;
      return { ...base, options, multi: false, typed: true, ...(scalar !== undefined ? { default: scalar } : {}) };
    }
    default:
      return `${where}: type must be string, number, integer, boolean or array`;
  }
}

/** ask_user's `requestedSchema` as the form's fields, in order, or what is wrong with it. */
function fieldsOf(schema: unknown): AsyncField[] | string {
  if (!isJsonObject(schema) || !isJsonObject(schema["properties"])) return "requested_schema must be an object with properties";
  const { properties, required } = schema;
  if (required !== undefined && !(Array.isArray(required) && required.every((each) => typeof each === "string"))) return "requested_schema.required must list field ids";
  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length === 0 || entries.length > FIELDS_MAX) return `requested_schema must have 1 to ${FIELDS_MAX} fields`;
  const fields: AsyncField[] = [];
  for (const [id, spec] of entries) {
    if (!label(id)) return `each field id must be text of at most ${LABEL_MAX} characters`;
    const field = fieldOf(id, spec, (required as string[] | undefined)?.includes(id) === true);
    if (typeof field === "string") return field;
    fields.push(field);
  }
  return fields;
}

/** The body's question, or a refusal that says what is wrong with it. */
function askOf(body: Record<string, unknown>): Ask | Response {
  const { sdk_session: sdk, question, message, options, recommended, kind, requested_schema: schema } = body;
  if (typeof sdk !== "string" || sdk === "") return badRequest("missing_sdk_session", "sdk_session is required");
  if (typeof question !== "string" || question.trim() === "" || question.length > QUESTION_MAX) return badRequest("invalid_question", `question must be text of at most ${QUESTION_MAX} characters`);
  if (message !== undefined && message !== null && (typeof message !== "string" || message.length > MESSAGE_MAX)) return badRequest("invalid_message", `message must be text of at most ${MESSAGE_MAX} characters`);
  if (kind !== "optional" && kind !== "blocking") return badRequest("invalid_kind", "kind must be \"optional\" or \"blocking\"");
  const fields = schema === undefined ? undefined : fieldsOf(schema);
  if (typeof fields === "string") return badRequest("invalid_schema", fields);
  // a form's choices are its fields': its own options may be left out
  const listed = fields && (options === undefined || options === null) ? [] : options;
  if (!Array.isArray(listed) || (!fields && listed.length === 0) || listed.length > OPTIONS_MAX) return badRequest("invalid_options", `options must list 1 to ${OPTIONS_MAX} choices`);
  const parsed: Ask["options"] = [];
  for (const option of listed) {
    if (!isJsonObject(option)) return badRequest("invalid_options", "each option must be an object");
    const { label, description } = option;
    if (typeof label !== "string" || label.trim() === "" || label.length > LABEL_MAX) return badRequest("invalid_options", "each option needs a label");
    if (description !== undefined && typeof description !== "string") return badRequest("invalid_options", "an option's description must be text");
    parsed.push(description === undefined ? { label } : { label, description });
  }
  // a form's picks are its fields' defaults: `recommended`, which ASK_RULE asks of an optional question, is let go
  if (!fields && recommended !== undefined && recommended !== null && !(Number.isInteger(recommended) && (recommended as number) >= 0 && (recommended as number) < parsed.length)) {
    return badRequest("invalid_recommended", "recommended must be the 0-based index of one of the options");
  }
  return { sdk, question, message: typeof message === "string" && message.trim() !== "" ? message : null, options: parsed, recommended: fields ? null : (recommended as number | null | undefined) ?? null, kind, ...(fields ? { fields } : {}) };
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
  const q = asks.add({ session, question: ask.question, message: ask.message, options: ask.options, recommended: ask.recommended, kind: ask.kind, ...(ask.fields ? { fields: ask.fields } : {}) });
  changed(session);
  return jsonResponse({ accepted: true, id: q.id });
}
