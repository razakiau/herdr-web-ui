/**
 * The agent host workspaces a user opened (docs: "Agent host workspaces"): per PC, the folders
 * open in the sidebar, each with the chats open as its tabs, and the order of the PC's
 * workspaces, herdr's and these together. herdr has nowhere to keep them, so the app does, beside
 * the pins in the shared preferences.
 */
export interface HostWorkspace {
  /** the folder, as the host reports a chat's (one trailing slash dropped) */
  cwd: string;
  /** the chats open as its tabs, by session, in strip order */
  tabs: string[];
}

export interface PcHostWorkspaces {
  /** the open workspaces, in the order they were opened (the sidebar's order comes from `order`) */
  open: HostWorkspace[];
  /** the PC's workspaces in sidebar order: `w:<herdr workspace id>` and `f:<folder>` */
  order?: string[];
}

/** by machine id */
export type HostWorkspaceState = Record<string, PcHostWorkspaces>;

export const MAX_HOST_WORKSPACES = 200;
export const MAX_HOST_TABS = 50;
const MAX_TEXT = 300;
const MAX_ORDER = 500;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;

/** A stored or sent state, checked: null when its shape is wrong or it is over the limits. */
export function sanitizeHostWorkspaces(raw: unknown): HostWorkspaceState | null {
  if (!isObject(raw)) return null;
  const out: HostWorkspaceState = {};
  for (const [machine, value] of Object.entries(raw)) {
    if (!isText(machine) || !isObject(value) || !Array.isArray(value["open"]) || value["open"].length > MAX_HOST_WORKSPACES) return null;
    const open: HostWorkspace[] = [];
    for (const each of value["open"]) {
      if (!isObject(each) || !isText(each["cwd"]) || !Array.isArray(each["tabs"]) || each["tabs"].length > MAX_HOST_TABS || !each["tabs"].every(isText)) return null;
      open.push({ cwd: each["cwd"], tabs: [...each["tabs"] as string[]] });
    }
    const order = value["order"];
    if (order !== undefined && (!Array.isArray(order) || order.length > MAX_ORDER || !order.every(isText))) return null;
    out[machine] = order === undefined ? { open } : { open, order: [...order as string[]] };
  }
  return out;
}
