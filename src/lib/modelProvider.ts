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

/** The provider tabs (VS Code's modelPickerTabs): one per provider, none when there is only one. */
export function modelTabs(models: readonly HostModel[]): string[] {
  const providers = [...new Set(models.map((model) => model.provider))];
  return providers.length > 1 ? providers : [];
}

/** The models a search (by name or id, any case) and a tab leave. */
export function filterModels(models: readonly HostModel[], query: string, tab: string | null = null): HostModel[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter((model) => (tab === null || model.provider === tab)
    && words.every((word) => model.name.toLowerCase().includes(word) || model.id.toLowerCase().includes(word)));
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

/** The picker's section headings, in their order. */
export const SECTION_TITLES = [
  "Pinned",
  "Recent",
  "All models",
] as const;

/** Pinned, then Recent, then All models; an empty section is left out (All models never is). */
export function pickerSections(models: readonly HostModel[], pinned: readonly string[], recent: readonly string[]): { title: "Pinned" | "Recent" | "All models"; models: HostModel[] }[] {
  const byId = (ids: readonly string[]): HostModel[] => ids.flatMap((id) => models.filter((model) => model.id === id));
  return [
    { title: "Pinned" as const, models: byId(pinned) },
    { title: "Recent" as const, models: byId(recent) },
    { title: "All models" as const, models: [...models] },
  ].filter((section) => section.title === "All models" || section.models.length > 0);
}
