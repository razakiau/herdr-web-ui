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

/**
 * What of the shared preferences (MAX_PREFERENCES_BYTES, 64 KB) the open workspaces may take: half,
 * so settings and pins always fit beside them.
 */
export const HOST_WORKSPACES_BUDGET = 32 * 1024;
const encoder = new TextEncoder();
const bytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

/**
 * A state cut to what the server takes, before it is saved or sent: a state over the limits is
 * refused whole (400, or 413 past the size), and the refused change would hold back settings and
 * pins with it until the next edit. Each cut drops what matters least: a workspace's oldest tabs,
 * a PC's earliest opened workspaces, the order's tail. The same object when it already fits.
 */
export function fitHostWorkspaces(state: HostWorkspaceState): HostWorkspaceState {
  let out: HostWorkspaceState = state;
  let cut = false;
  const pcs = Object.entries(state).map(([machine, pc]) => {
    const open = pc.open.slice(-MAX_HOST_WORKSPACES).map((each) => each.tabs.length > MAX_HOST_TABS ? { ...each, tabs: each.tabs.slice(-MAX_HOST_TABS) } : each);
    const order = pc.order && pc.order.length > MAX_ORDER ? pc.order.slice(0, MAX_ORDER) : pc.order;
    const changed = open.length !== pc.open.length || open.some((each, index) => each !== pc.open[pc.open.length - open.length + index]) || order !== pc.order;
    if (!changed) return [machine, pc] as const;
    cut = true;
    return [machine, order === undefined ? { open } : { open, order }] as const;
  });
  if (cut) out = Object.fromEntries(pcs);
  if (bytes(out) <= HOST_WORKSPACES_BUDGET) return out;
  const next: HostWorkspaceState = structuredClone(out);
  // the PC that takes the most gives first: its earliest opened workspace, else its order, else itself
  while (bytes(next) > HOST_WORKSPACES_BUDGET) {
    const [machine, pc] = Object.entries(next).sort((a, b) => bytes(b[1]) - bytes(a[1]))[0]!;
    if (pc.open.length > 1) pc.open.shift();
    else if (pc.order !== undefined) delete pc.order;
    else if (pc.open.length === 1) pc.open.shift();
    else delete next[machine];
  }
  return next;
}
