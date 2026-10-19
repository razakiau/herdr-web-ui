/**
 * A host chat's model picker: each model's mark, the picker's tabs and sections, and the pins and
 * recent picks it keeps per PC. The mark follows VS Code's order (modelProviderIcons.ts
 * getProviderIconForIdentity), read from the model's name too, so a model whose name carries its
 * provider in parentheses ("Claude Opus 5.5 (Anthropic)") gets its real mark; VS Code gives every
 * custom-endpoint model the sparkle.
 */
import type { HostModel } from "../../shared/host-chats.ts";

export type ModelMark = "grok" | "claude" | "gemini" | "kimi" | "microsoft" | "openai" | "deepseek" | "zhipu" | "qwen" | "minimax" | "copilot" | "sparkle";

/** The first pattern that matches wins, in VS Code's order, then the providers it has no icon for. */
const MARKS: [RegExp, ModelMark][] = [
  [/grok|xai/, "grok"],
  [/claude|anthropic/, "claude"],
  [/gemini|google/, "gemini"],
  [/kimi|moonshot/, "kimi"],
  [/microsoft|\bmai\b/, "microsoft"],
  [/openai|chatgpt|gpt|codex|\bo[134]\b/, "openai"],
  [/deepseek/, "deepseek"],
  [/glm|zhipu/, "zhipu"],
  [/qwen/, "qwen"],
  [/minimax/, "minimax"],
  [/copilot|^auto$/, "copilot"],
];

export function providerMark(model: Pick<HostModel, "id" | "name" | "provider">): ModelMark {
  const identity = `${model.id} ${model.name}`.toLowerCase();
  const name = model.name.trim().toLowerCase();
  for (const [pattern, mark] of MARKS) {
    if (mark === "copilot" ? pattern.test(name) || /copilot/.test(identity) : pattern.test(identity)) return mark;
  }
  return "sparkle";
}

/**
 * A model's name on the composer's trigger: its last "(…)" goes when the mark already names the
 * provider ("Claude Opus 5.5 (Anthropic)" → "Claude Opus 5.5"); a model the mark cannot name keeps it.
 */
export function shortModelName(model: Pick<HostModel, "id" | "name" | "provider">): string {
  if (providerMark(model) === "sparkle") return model.name;
  return model.name.replace(/\s*\([^()]*\)\s*$/, "") || model.name;
}

/** A context window as the picker says it: 1M, 500K, 200K (a binary 1,048,576 is 1M too). */
export function contextLabel(tokens: number): string {
  const unit = tokens % 1_048_576 === 0 ? 1_048_576 : tokens % 1_024 === 0 && tokens < 1_000_000 ? 1_024 : 0;
  if (tokens >= 1_000_000) return `${Number(((unit === 1_048_576 ? tokens / unit : tokens / 1_000_000)).toFixed(1))}M`;
  return `${Math.round(tokens / (unit === 1_024 ? 1_024 : 1_000))}K`;
}

const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** A row's right side: "{Effort} · {context}", either alone, or nothing. */
export function rowDetail(model: HostModel, effort: string | null): string {
  return [effort ? capital(effort) : null, model.context ? contextLabel(model.context) : null].filter((part) => part !== null).join(" · ");
}

/** Where a model is filed: the bridge's group, or the same rule for a bridge older than 1007. */
export function modelGroupOf(model: Pick<HostModel, "id" | "group">): string {
  if (model.group) return model.group;
  const at = model.id.indexOf("/");
  return at > 0 ? model.id.slice(0, at) : "other";
}

/** Names for the groups the lab knows; any other router reads as its id prefix. */
const GROUP_NAMES: Record<string, string> = { copilot: "Copilot", omniroute: "OmniRoute", other: "Other" };
export function groupName(group: string): string {
  return GROUP_NAMES[group] ?? group;
}

/** The vendor a router names in parentheses ("Claude Opus 5.5 (Anthropic)" → "Anthropic"), or null. */
export function vendorOf(model: Pick<HostModel, "name">): string | null {
  return /\(([^()]+)\)\s*$/.exec(model.name)?.[1]?.trim() || null;
}

/** The picker's tabs: one per group, Copilot first and Other last; none when there is only one. */
export function modelTabs(models: readonly HostModel[]): string[] {
  const groups = [...new Set(models.map(modelGroupOf))];
  const rank = (group: string): number => group === "copilot" ? 0 : group === "other" ? 2 : 1;
  return groups.length > 1 ? groups.sort((a, b) => rank(a) - rank(b)) : [];
}

/** The models a search (by name or id, any case) and a tab leave. */
export function filterModels(models: readonly HostModel[], query: string, tab: string | null = null): HostModel[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter((model) => (tab === null || modelGroupOf(model) === tab)
    && words.every((word) => model.name.toLowerCase().includes(word) || model.id.toLowerCase().includes(word)));
}

/** A multiplier as Copilot's picker says it: "27x", "0.33x"; nothing for none. */
export function multiplierLabel(model: Pick<HostModel, "multiplier">): string | null {
  return typeof model.multiplier === "number" ? `${Number(model.multiplier.toFixed(2))}x` : null;
}

type PickStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const RECENT_MAX = 5;
const recentKey = (machineId: string): string => `herdr-web-ui:host-models-recent:${machineId}`;
const pinnedKey = (machineId: string): string => `herdr-web-ui:host-models-pinned:${machineId}`;
const local = (): PickStorage | null => { try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; } };

function readIds(key: string, storage: PickStorage | null): string[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}
function writeIds(key: string, ids: string[], storage: PickStorage | null): void {
  try { if (ids.length === 0) storage?.removeItem(key); else storage?.setItem(key, JSON.stringify(ids)); } catch { /* kept for this screen only */ }
}

/** The last 5 models picked on this PC, newest first. */
export function recentModels(machineId: string, storage: PickStorage | null = local()): string[] {
  return readIds(recentKey(machineId), storage);
}
export function rememberRecent(machineId: string, id: string, storage: PickStorage | null = local()): void {
  writeIds(recentKey(machineId), [id, ...recentModels(machineId, storage).filter((each) => each !== id)].slice(0, RECENT_MAX), storage);
}

/** The models pinned on this PC (a long press pins or unpins). */
export function pinnedModels(machineId: string, storage: PickStorage | null = local()): string[] {
  return readIds(pinnedKey(machineId), storage);
}
export function togglePinned(machineId: string, id: string, storage: PickStorage | null = local()): void {
  const pinned = pinnedModels(machineId, storage);
  writeIds(pinnedKey(machineId), pinned.includes(id) ? pinned.filter((each) => each !== id) : [...pinned, id], storage);
}

/** The picker's headings it translates (i18n.test reads this list); a router's name is its id prefix. */
export const SECTION_TITLES = [
  "Pinned",
  "Recent",
  "Copilot",
  "Other",
];

export interface PickerSection {
  /** a stable key: "pinned", "recent", or the group and vendor */
  key: string;
  /** the English heading; the picker translates Pinned, Recent, Copilot and Other by their key */
  title: string;
  /** a router's vendor, said after its group: "OmniRoute · Anthropic" */
  vendor: string | null;
  models: HostModel[];
}

/**
 * Pinned, Recent, then every group in the tabs' order: Copilot's catalogue as the host lists it,
 * each router split by the vendor its names carry (in order of first appearance, unnamed last), then the rest.
 * An empty section is left out.
 */
export function pickerSections(models: readonly HostModel[], pinned: readonly string[], recent: readonly string[]): PickerSection[] {
  const byId = (ids: readonly string[]): HostModel[] => ids.flatMap((id) => models.filter((model) => model.id === id));
  const sections: PickerSection[] = [
    { key: "pinned", title: "Pinned", vendor: null, models: byId(pinned) },
    { key: "recent", title: "Recent", vendor: null, models: byId(recent) },
  ];
  const groups = modelTabs(models);
  for (const group of groups.length > 0 ? groups : [modelGroupOf(models[0] ?? { id: "" })]) {
    const members = models.filter((model) => modelGroupOf(model) === group);
    const split = group !== "copilot" && group !== "other";
    // the vendors in order of first appearance, the models naming none after them
    const vendors = split ? [...new Set(members.map(vendorOf))].sort((a, b) => Number(a === null) - Number(b === null)) : [null];
    for (const vendor of vendors) {
      sections.push({ key: `${group}\n${vendor ?? ""}`, title: groupName(group), vendor,
        models: split ? members.filter((model) => vendorOf(model) === vendor) : members });
    }
  }
  return sections.filter((section) => section.models.length > 0);
}
