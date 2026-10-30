import type { AlertPrefs } from "./notify-policy.ts";

/** GET /api/push: base64url VAPID public key, the `applicationServerKey` a browser subscribes with. */
export interface PushKey {
  readonly public_key: string;
  /** the ntfy topic the server also posts alerts to (server/ntfy.ts), and which; null without one */
  readonly ntfy?: { readonly topic: string; readonly alerts: AlertPrefs } | null;
}

/**
 * The JSON inside every web push, decrypted by the device's service worker (public/sw.js)
 * and shown as a notification. `pane_id` is null for the enable-confirmation push; `tag`
 * is shared with the in-tab notification of the same pane, so one replaces the other.
 */
export interface PushPayload {
  /** Absent in legacy payloads means local. */
  machine_id?: string;
  pane_id: string | null;
  /** A host chat's session (shared/host-chats.ts), when the alert is a chat's, not a pane's: its tap opens the chat. */
  host_session?: string;
  /** The workspace the pane was last seen in, so the tap of an ended pane opens that workspace. Absent when not known. */
  workspace_id?: string;
  title: string;
  body: string;
  tag: string;
  /**
   * the notification's buttons (the keep-warm window-end alert, ZAC-260): `path` is a signed
   * POST the service worker sends as the button is tapped (server/keep-warm-actions.ts)
   */
  actions?: { action: string; title: string; path: string }[];
}
