/**
 * A host chat's "/" commands, as VS Code 1.142 offers them for an agent-host chat: the Copilot
 * config commands (src/vs/platform/agentHost/common/copilotConfigSlashCommands.ts), which set the
 * chat's mode or approvals and send the rest of the message, then the commands the host publishes
 * for the chat (its skills, prompts and agents). Same commands, details and config values as VS
 * Code's; its menu filter is a prefix or fuzzy match, here a prefix or substring.
 */
import type { HostCommand } from "../../shared/host-chats.ts";

const AUTO_APPROVE_BYPASS = "autoApprove";
const AUTO_APPROVE_DEFAULT = "default";
const MODE_INTERACTIVE = "interactive";
const MODE_PLAN = "plan";
const MODE_AUTOPILOT = "autopilot";

interface ConfigOption { arg?: string; detail: string; config: Record<string, string>; argumentHint?: string }
interface ConfigCommand { command: string; sortText: string; args: ConfigOption[] }

/** VS Code's strings for these commands (copilotConfigSlash.*). */
export const HOST_SLASH_DETAIL = {
  yolo: "Set permissions to bypass approvals",
  default: "Set permissions back to default",
  autopilotOn: "Switch to autopilot mode",
  exitAutopilot: "Switch to interactive mode",
  autopilotPrompt: "Switch to autopilot mode with an objective",
  planPrompt: "Create an implementation plan before coding",
  autopilotHint: "objective",
  promptHint: "Describe what you want to plan or research",
};
const D = HOST_SLASH_DETAIL;

export const HOST_CONFIG_COMMANDS: readonly ConfigCommand[] = [
  { command: "yolo", sortText: "z1_yolo", args: [
    { arg: "on", detail: D.yolo, config: { autoApprove: AUTO_APPROVE_BYPASS } },
    { arg: "off", detail: D.default, config: { autoApprove: AUTO_APPROVE_DEFAULT } },
  ] },
  { command: "allow-all", sortText: "z1_allow-all", args: [
    { arg: "on", detail: D.yolo, config: { autoApprove: AUTO_APPROVE_BYPASS } },
    { arg: "off", detail: D.default, config: { autoApprove: AUTO_APPROVE_DEFAULT } },
  ] },
  { command: "autopilot", sortText: "z1_autopilot", args: [
    { arg: "on", detail: D.autopilotOn, config: { mode: MODE_AUTOPILOT } },
    { arg: "off", detail: D.exitAutopilot, config: { mode: MODE_INTERACTIVE } },
    { detail: D.autopilotPrompt, config: { mode: MODE_AUTOPILOT }, argumentHint: D.autopilotHint },
  ] },
  { command: "plan", sortText: "z1_plan", args: [
    { detail: D.planPrompt, config: { mode: MODE_PLAN }, argumentHint: D.promptHint },
  ] },
  { command: "goal", sortText: "z1_goal", args: [
    { detail: D.planPrompt, config: { mode: MODE_PLAN }, argumentHint: D.promptHint },
  ] },
];

/** VS Code's parseLeadingSlashCommand: `/name` at the very start, then whitespace or the end. */
function leading(text: string): { command: string; rest: string } | null {
  const match = /^\/([^\s/]+)(?:$|\s+([\s\S]*))/.exec(text);
  return match ? { command: match[1]!, rest: (match[2] ?? "").trim() } : null;
}

/**
 * A message that starts with one of the config commands: the config it sets and the words left to
 * send ("" sends nothing). Null: not one of them, the message goes as typed.
 */
export function resolveHostSlash(text: string): { config: Record<string, string>; text: string } | null {
  const parsed = leading(text);
  if (!parsed) return null;
  const descriptor = HOST_CONFIG_COMMANDS.find((each) => each.command === parsed.command.toLowerCase());
  if (!descriptor) return null;
  const named = descriptor.args.filter((each) => each.arg !== undefined);
  const base = descriptor.args.find((each) => each.arg === undefined);
  if (named.length > 0 && parsed.rest.length > 0) {
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(parsed.rest);
    const matched = named.find((each) => each.arg === match?.[1]?.toLowerCase());
    if (matched) return { config: { ...matched.config }, text: (match?.[2] ?? "").trim() };
    if (!base) return null;
  }
  return { config: { ...(base ?? descriptor.args[0]!).config }, text: parsed.rest };
}

/** VS Code's shouldOfferOption: an on/off is offered only where it changes something. */
function offered(option: ConfigOption, state: { mode: string | null; approvals: string | null } | null): boolean {
  if (option.argumentHint !== undefined || !state) return true;
  const approve = option.config["autoApprove"];
  if (approve !== undefined) {
    const bypass = state.approvals === AUTO_APPROVE_BYPASS;
    return approve === AUTO_APPROVE_BYPASS ? !bypass : bypass;
  }
  const mode = option.config["mode"];
  if (mode === MODE_AUTOPILOT) return state.mode !== MODE_AUTOPILOT;
  if (mode === MODE_INTERACTIVE) return state.mode === MODE_AUTOPILOT;
  return true;
}

export interface HostSlashItem { label: string; insert: string; description: string; hint?: string; kind: "config" | HostCommand["kind"] }

/** The "/" menu for `typed` (what follows the slash): the config commands, then the host's commands. */
export function hostSlashItems(typed: string, commands: readonly HostCommand[], state: { mode: string | null; approvals: string | null } | null): HostSlashItem[] {
  const query = typed.trim().toLowerCase();
  const matches = (name: string): boolean => query === "" || name.toLowerCase().startsWith(query) || (query.length > 1 && name.toLowerCase().includes(query));
  const config = HOST_CONFIG_COMMANDS.filter((each) => matches(each.command)).flatMap((each) => each.args.filter((option) => offered(option, state)).map((option) => {
    // a command that takes words keeps the menu's insert open for them; an on/off is whole
    const takesWords = option.argumentHint !== undefined;
    const label = takesWords || !option.arg ? `/${each.command}` : `/${each.command} ${option.arg}`;
    return { sort: option.arg ? `${each.sortText}_${option.arg}` : each.sortText, item: {
      label, insert: takesWords ? `/${each.command} ` : label, description: option.detail,
      ...(option.argumentHint !== undefined ? { hint: option.argumentHint } : {}), kind: "config" as const,
    } };
  })).sort((a, b) => a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0).map((each) => each.item);
  const host = commands.filter((each) => matches(each.name)).map((each): HostSlashItem => ({ label: `/${each.name}`, insert: `/${each.name} `, description: each.description, kind: each.kind }));
  return [...config, ...host];
}
