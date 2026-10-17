/**
 * `/api/vscode/*`: this PC's VS Code chats, read from its agent host (server/vscode/connection.ts).
 * Off unless HERDR_WEB_AGENT_HOST=on: with no host every path answers 404 `vscode_off`. A
 * connection server reaches a PC's routes through its bridge (MACHINE_PROXY_PATH).
 */
import type { VscodeHostState } from "../../shared/vscode.ts";
import { badRequest, jsonResponse } from "../http.ts";

/** What the routes use of a VscodeConnection, so they can be tested against a stub. */
export interface VscodeHost {
  state(): VscodeHostState;
}

const PREFIX = "/api/vscode/";

/** The answer for a `/api/vscode/` path; null for any other path. */
export function vscodeRoute(request: Request, pathname: string, host: VscodeHost | null): Promise<Response> | null {
  if (!pathname.startsWith(PREFIX)) return null;
  return answer(request, pathname.slice(PREFIX.length), host);
}

async function answer(request: Request, route: string, host: VscodeHost | null): Promise<Response> {
  if (!host) return jsonResponse({ error: { code: "vscode_off", message: "VS Code chats are off on this PC (HERDR_WEB_AGENT_HOST)" } }, 404);
  if (route === "state") {
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    return jsonResponse({ host: host.state() });
  }
  return jsonResponse({ error: { code: "not_found", message: `unknown endpoint /api/vscode/${route}` } }, 404);
}
