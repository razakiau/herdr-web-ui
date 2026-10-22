import type { ConversationPart } from "../../shared/protocol.ts";
import { patchFiles, patchText } from "../../shared/patch.ts";
import type { Translate } from "./i18n.ts";
import { isTodoTool } from "./todos.ts";
import { toolVerbKind } from "./toolVerbs.ts";

type ToolPart = Extract<ConversationPart, { kind: "tool" }>;

/**
 * How a chat's turns read. "vscode": the way VS Code shows a Copilot turn (its tool-group sentence,
 * an icon per call, terminal rows, file pills); "classic": the app's own work block, as every agent
 * has read so far. Copilot only for now: a host chat, or a `copilot` pane. Other agents may opt in
 * later; until then they read exactly as before.
 */
export type TurnStyle = "vscode" | "classic";

export function turnStyle(agent: string | null, hosted: boolean): TurnStyle {
  return hosted || agent === "copilot" ? "vscode" : "classic";
}

export type ToolKind = "command" | "read" | "search_text" | "search_files" | "list" | "problems" | "edit" | "mcp" | "other";

/**
 * VS Code's tool ids by kind (toolInvocationSummary.ts at 6d62b1d), lowercased: Copilot's own tools
 * and the agent host's. A pane's tools are read through the app's verb table after these.
 */
const VSCODE_KIND: Record<string, ToolKind> = {
  copilot_readfile: "read", read_file: "read", view: "read",
  copilot_findtextinfiles: "search_text", grep_search: "search_text", copilot_searchcodebase: "search_text", semantic_search: "search_text", grep: "search_text", rg: "search_text",
  copilot_findfiles: "search_files", file_search: "search_files", glob: "search_files",
  run_in_terminal: "command", bash: "command", powershell: "command", shell: "command",
  copilot_listdirectory: "list", list_dir: "list",
  copilot_geterrors: "problems", get_errors: "problems",
  copilot_applypatch: "edit", apply_patch: "edit", copilot_replacestring: "edit", replace_string_in_file: "edit",
  copilot_insertedit: "edit", insert_edit_into_file: "edit", copilot_createfile: "edit", create_file: "edit", edit: "edit",
  vscode_editfile: "edit", vscode_editfile_internal: "edit", copilot_multireplacestring: "edit", multi_replace_string_in_file: "edit",
};

const VERB_KIND = { read: "read", edit: "edit", write: "edit", run: "command" } as const;

/** What a call is, by its tool's id (`tool_id`, else the name a pane gives it). */
export function toolKind(part: ToolPart): ToolKind {
  const id = (part.tool_id ?? part.name).toLowerCase();
  // VS Code's rule: an MCP tool is one by its id, whatever it does
  if (id.includes("mcp")) return "mcp";
  if (Object.hasOwn(VSCODE_KIND, id)) return VSCODE_KIND[id]!;
  const verb = toolVerbKind(id, part.input);
  return verb === null ? "other" : VERB_KIND[verb];
}

/** A call VS Code never folds into a tool group: an MCP tool's, a mermaid diagram's, one waiting for a confirmation. */
export function neverFolded(part: ToolPart): boolean {
  if (part.state === "awaiting") return true;
  if (isTodoTool(part.name)) return false;
  return toolKind(part) === "mcp" || (part.tool_id ?? part.name).toLowerCase().includes("mermaid");
}

function fields(input: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(input);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value : null;

/** The file a call names: `filePath` (VS Code), `file_path` (Claude), `path`. */
export function toolFile(part: ToolPart): string | null {
  const args = fields(part.input);
  return text(args.filePath) ?? text(args.file_path) ?? text(args.path);
}

/** The files an edit changed: the host's own list, else the ones its input names. */
function editedFiles(part: ToolPart): string[] {
  if (part.edits !== undefined && part.edits.length > 0) return part.edits.map((edit) => edit.path);
  const patch = patchText(part.input);
  if (patch !== null) return patchFiles(patch);
  const args = fields(part.input);
  if (Array.isArray(args.replacements)) {
    return args.replacements.flatMap((item: unknown) => {
      const path = typeof item === "object" && item !== null ? text((item as Record<string, unknown>).filePath) : null;
      return path === null ? [] : [path];
    });
  }
  const file = toolFile(part) ?? text(args.uri);
  return file === null ? [] : [file];
}

/** A path's last part, as VS Code names a file in a sentence. */
export function baseName(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).at(-1) || path;
}

/**
 * The header of a turn's work as VS Code sums up a tool group (chatToolGroupSummary.ts at 6d62b1d):
 * what the calls did, in its order, the first fragment capitalised, at most three, the rest as
 * "N other steps"; files and queries counted once. `added` / `removed`: the edits' lines.
 */
export function toolGroupSummary(parts: readonly ConversationPart[], t: Translate): { title: string; added: number; removed: number } {
  const reads = new Set<string>();
  const edits = new Set<string>();
  const directories = new Set<string>();
  const diagnostics = new Set<string>();
  const phrases = new Set<string>();
  const patterns = new Set<string>();
  let commands = 0, readSteps = 0, editSteps = 0, textSteps = 0, fileSteps = 0, directorySteps = 0, diagnosticSteps = 0;
  let failed = 0, skipped = 0, denied = 0, unfinished = 0, other = 0, steps = 0, added = 0, removed = 0;
  for (const part of parts) {
    // the plan and a skill are not steps of the work: the classic header leaves them out too
    if (part.kind !== "tool" || part.skill || isTodoTool(part.name)) continue;
    steps += 1;
    for (const edit of part.edits ?? []) { added += edit.added; removed += edit.removed; }
    // VS Code's order: denied and skipped before a failure, a failure before an unfinished call
    if (part.state === "denied") { denied += 1; continue; }
    if (part.state === "skipped") { skipped += 1; continue; }
    if (part.error === true) { failed += 1; continue; }
    if (part.state === "running" || part.state === "awaiting") { unfinished += 1; continue; }
    const args = fields(part.input);
    switch (toolKind(part)) {
      case "command": commands += 1; break;
      case "read": {
        const file = toolFile(part);
        if (file === null) { other += 1; break; }
        readSteps += 1; reads.add(file);
        break;
      }
      case "search_text":
      case "search_files": {
        const query = text(args.query) ?? text(args.pattern);
        if (query === null) { other += 1; break; }
        if (toolKind(part) === "search_files") { fileSteps += 1; patterns.add(query); } else { textSteps += 1; phrases.add(query); }
        break;
      }
      case "list": {
        const dir = toolFile(part);
        if (dir === null) { other += 1; break; }
        directorySteps += 1; directories.add(dir);
        break;
      }
      case "problems": {
        const paths = Array.isArray(args.filePaths) ? args.filePaths.filter((path): path is string => text(path) !== null) : [];
        if (paths.length === 0) { other += 1; break; }
        diagnosticSteps += 1;
        for (const path of paths) diagnostics.add(path);
        break;
      }
      case "edit": {
        const files = editedFiles(part);
        if (files.length === 0) { other += 1; break; }
        editSteps += 1;
        for (const file of files) edits.add(file);
        break;
      }
      default: other += 1;
    }
  }
  const labels: { text: string; steps: number; overflow?: string }[] = [];
  const add = (initial: string, continued: string, count: number) => labels.push({ text: labels.length === 0 ? initial : continued, steps: count });
  if (edits.size === 1) labels.push({ text: t("Edited {file}", { file: baseName([...edits][0]!) }), steps: editSteps });
  else if (edits.size > 1) labels.push({ text: t("Edited {n} files", { n: edits.size }), steps: editSteps });
  if (commands > 0) {
    add(commands === 1 ? t("Ran 1 command") : t("Ran {n} commands", { n: commands }), commands === 1 ? t("ran 1 command") : t("ran {n} commands", { n: commands }), commands);
  }
  if (reads.size === 1) {
    const file = baseName([...reads][0]!);
    add(t("Read {file}", { file }), t("read {file}", { file }), readSteps);
  } else if (reads.size > 1) {
    add(t("Read {n} files", { n: reads.size }), t("read {n} files", { n: reads.size }), readSteps);
  }
  if (phrases.size > 0) {
    add(phrases.size === 1 ? t("Searched for 1 phrase") : t("Searched for {n} phrases", { n: phrases.size }),
      phrases.size === 1 ? t("searched for 1 phrase") : t("searched for {n} phrases", { n: phrases.size }), textSteps);
  }
  if (patterns.size > 0) {
    add(patterns.size === 1 ? t("Searched for 1 file pattern") : t("Searched for {n} file patterns", { n: patterns.size }),
      patterns.size === 1 ? t("searched for 1 file pattern") : t("searched for {n} file patterns", { n: patterns.size }), fileSteps);
  }
  if (directories.size > 0) {
    add(directories.size === 1 ? t("Listed 1 directory") : t("Listed {n} directories", { n: directories.size }),
      directories.size === 1 ? t("listed 1 directory") : t("listed {n} directories", { n: directories.size }), directorySteps);
  }
  if (diagnostics.size > 0) {
    const file = baseName([...diagnostics][0]!);
    add(diagnostics.size === 1 ? t("Checked {file} for problems", { file }) : t("Checked {n} paths for problems", { n: diagnostics.size }),
      diagnostics.size === 1 ? t("checked {file} for problems", { file }) : t("checked {n} paths for problems", { n: diagnostics.size }), diagnosticSteps);
  }
  if (failed > 0) labels.push({ text: failed === 1 ? t("1 tool call failed") : t("{n} tool calls failed", { n: failed }), steps: failed, overflow: t("{n} failed", { n: failed }) });
  if (skipped > 0) labels.push({ text: skipped === 1 ? t("1 tool call skipped") : t("{n} tool calls skipped", { n: skipped }), steps: skipped, overflow: t("{n} skipped", { n: skipped }) });
  if (denied > 0) labels.push({ text: denied === 1 ? t("1 tool call denied") : t("{n} tool calls denied", { n: denied }), steps: denied, overflow: t("{n} denied", { n: denied }) });
  if (unfinished > 0) labels.push({ text: unfinished === 1 ? t("1 unfinished tool call") : t("{n} unfinished tool calls", { n: unfinished }), steps: unfinished, overflow: t("{n} unfinished", { n: unfinished }) });
  const shown = labels.slice(0, 3).map((label) => label.text);
  const overflow = labels.slice(3);
  other += overflow.reduce((total, label) => total + label.steps, 0);
  if (other > 0 && shown.length > 0) {
    const others = other === 1 ? t("1 other step") : t("{n} other steps", { n: other });
    const outcomes = combine(overflow.flatMap((label) => label.overflow === undefined ? [] : [label.overflow]), t);
    shown.push(outcomes === null ? others : t("{a} ({b})", { a: others, b: outcomes }));
  }
  const title = combine(shown, t)
    ?? (steps === 0 ? t("Finished Working") : steps === 1 ? t("Finished with 1 step") : t("Finished with {n} steps", { n: steps }));
  return { title, added, removed };
}

function combine(labels: readonly string[], t: Translate): string | null {
  return labels.reduce<string | null>((sum, label) => sum === null ? label : t("{a}, {b}", { a: sum, b: label }), null);
}
