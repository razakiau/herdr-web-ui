/**
 * The VS Code chats contract between a bridge and the browser: types only, so the client can
 * import it without pulling in the server's AHP client.
 */

/** Where a bridge stands with its PC's VS Code agent host. */
export type VscodeHostState =
  | { state: "off" } | { state: "unsupported" } | { state: "no_server" }
  | { state: "starting" } | { state: "waiting" }          // start disabled, no host yet
  | { state: "refused"; server_version: string | null }   // handshake refused
  | { state: "connected"; signed_in: boolean; protocol: string };
