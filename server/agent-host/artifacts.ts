/**
 * What a host session produced and what still runs for it, as VS Code's agent-host pills read them
 * (workbench agentHostSessionInputPills, VS Code 1.142, read 2026-10-22):
 *
 * - artifacts: the session's `_meta["agentHost/sessionArtifacts"]`, which the host's artifact tools
 *   write; each entry is checked as VS Code's `cas` checks it and the list is shown newest first
 *   (`tKn`). `isArtifact: false` is a Reference.
 * - background work: the chat's `backgroundWork`, which lists only what still runs. A shell whose
 *   `_meta["vscode.stopBackgroundWork"]` is true can be stopped (`vscode/stopBackgroundWork`).
 */
import type { HostArtifact, HostArtifactType, HostBackgroundWork } from "../../shared/host-chats.ts";

export const ARTIFACTS_META = "agentHost/sessionArtifacts";
export const STOPPABLE_META = "vscode.stopBackgroundWork";

const TYPES: readonly HostArtifactType[] = ["pullRequest", "issue", "commit", "website", "file", "resource"];

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function artifactOf(value: unknown): HostArtifact | null {
  if (!isRecord(value)) return null;
  const { id, label, type, isArtifact } = value;
  if (typeof id !== "string" || typeof label !== "string" || !TYPES.includes(type as HostArtifactType)) return null;
  if (isArtifact !== undefined && typeof isArtifact !== "boolean") return null;
  const out: HostArtifact = { id, type: type as HostArtifactType, label, isArtifact: isArtifact ?? true };
  if (typeof value["link"] === "string") out.link = value["link"];
  if (typeof value["uri"] === "string") out.uri = value["uri"];
  if (typeof value["commitHash"] === "string") out.commitHash = value["commitHash"];
  if (typeof value["isGitHub"] === "boolean") out.isGitHub = value["isGitHub"];
  return out;
}

/** The session's artifacts and references, newest first; none when its `_meta` holds no list. */
export function artifactsOf(meta: Record<string, unknown> | undefined): HostArtifact[] {
  const list = meta?.[ARTIFACTS_META];
  if (!Array.isArray(list)) return [];
  return list.flatMap((each) => { const artifact = artifactOf(each); return artifact ? [artifact] : []; }).reverse();
}

/** The chat's background work still running: each shell (a blank label is its command) and subagent. */
export function workOf(work: readonly unknown[] | undefined): HostBackgroundWork[] {
  return (work ?? []).flatMap((each): HostBackgroundWork[] => {
    if (!isRecord(each) || typeof each["id"] !== "string" || typeof each["startedAt"] !== "string") return [];
    const label = typeof each["label"] === "string" ? each["label"] : "";
    if (each["kind"] === "shell") {
      const command = typeof each["command"] === "string" ? each["command"] : "";
      const stoppable = isRecord(each["_meta"]) && each["_meta"][STOPPABLE_META] === true;
      return [{ id: each["id"], kind: "shell", label: label.trim() || command, command, started: each["startedAt"], stoppable }];
    }
    // its chat: the subagent row of the parent's transcript a tap on it goes to
    if (each["kind"] === "subagent") return [{ id: each["id"], kind: "subagent", label, started: each["startedAt"], stoppable: false, ...(typeof each["chat"] === "string" ? { chat: each["chat"] } : {}) }];
    return [];
  });
}
