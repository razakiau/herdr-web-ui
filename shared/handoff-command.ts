/**
 * The hand-off skill's "/" commands as a chat lists them (ZAC-262), or null when it lists none.
 *
 * The skill is the harness plugin's: a host lists a plugin's skills namespaced in its "/"
 * completions (`harness:handoff`, `harness:resume`), and a skill installed on its own plainly
 * (`handoff`, `resume`). Either form counts, the plain one first when both are listed; another
 * plugin's `<plugin>:handoff` is a different skill (it writes no `/resume` line) and never counts.
 * `resume` is the name listed for it, else the hand-off's own form: the plain one may not exist
 * where only the plugin's is installed.
 */
export function handoffCommand(commands: readonly { name: string }[]): { handoff: string; resume: string } | null {
  const names = new Set(commands.map((each) => each.name));
  const form = names.has("handoff") ? "" : names.has("harness:handoff") ? "harness:" : null;
  if (form === null) return null;
  const resume = names.has(`${form}resume`) ? `${form}resume` : names.has("resume") ? "resume" : names.has("harness:resume") ? "harness:resume" : `${form}resume`;
  return { handoff: `/${form}handoff`, resume: `/${resume}` };
}

/**
 * The resume skill's "/" command alone (ZAC-266, chat/continue: no note, so no `/handoff` needed),
 * or null when the chat lists none: the plain `resume` first, else the harness plugin's
 * `harness:resume`; another plugin's `<plugin>:resume` never counts.
 */
export function resumeCommand(commands: readonly { name: string }[]): string | null {
  const names = new Set(commands.map((each) => each.name));
  return names.has("resume") ? "/resume" : names.has("harness:resume") ? "/harness:resume" : null;
}
