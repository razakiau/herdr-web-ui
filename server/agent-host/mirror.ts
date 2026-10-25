/**
 * The package's AhpStateMirror routes sessions by the `ahp-session:` scheme, but VS Code's agent
 * host names them by provider (`copilotcli:/<uuid>`) and its chats `ahp-chat://…`, so the base
 * class would drop both. This mirror tracks the channels it was given a snapshot for, and runs the
 * package's reducers on them; everything else goes to the base class.
 *
 * Reducers get a silent log: a newer host sends actions this package version does not know, and
 * those are skipped by design (they would otherwise warn on every frame).
 */
import {
  chatReducer,
  rootReducer,
  sessionReducer,
  type ActionEnvelope,
  type ChatAction,
  type ChatState,
  type RootAction,
  type RootState,
  type SessionAction,
  type SessionState,
  type Snapshot,
} from "@microsoft/agent-host-protocol";
import { AhpStateMirror } from "@microsoft/agent-host-protocol/client";

const ROOT = "ahp-root://";
const quiet = (): void => {};

export class AgentHostMirror extends AhpStateMirror {
  private ownRoot: RootState = { agents: [] };
  private readonly ownSessions = new Map<string, SessionState>();
  private readonly ownChats = new Map<string, ChatState>();

  override get root(): RootState { return this.ownRoot; }
  override get sessions(): ReadonlyMap<string, SessionState> { return this.ownSessions; }
  get chats(): ReadonlyMap<string, ChatState> { return this.ownChats; }
  override getSession(uri: string): SessionState | undefined { return this.ownSessions.get(uri); }
  getChat(uri: string): ChatState | undefined { return this.ownChats.get(uri); }

  /** Root snapshots, and anything the base class knows by scheme. */
  override applySnapshot(snapshot: Snapshot): void {
    if (snapshot.resource === ROOT) this.ownRoot = snapshot.state as RootState;
    else if (this.ownSessions.has(snapshot.resource)) this.ownSessions.set(snapshot.resource, snapshot.state as SessionState);
    else if (this.ownChats.has(snapshot.resource)) this.ownChats.set(snapshot.resource, snapshot.state as ChatState);
    else super.applySnapshot(snapshot);
  }

  /** A session channel's snapshot: from now on its actions are reduced here. */
  applySessionSnapshot(snapshot: Snapshot): void { this.ownSessions.set(snapshot.resource, snapshot.state as SessionState); }
  /** A chat channel's snapshot: from now on its actions are reduced here. */
  applyChatSnapshot(snapshot: Snapshot): void { this.ownChats.set(snapshot.resource, snapshot.state as ChatState); }

  forget(uri: string): void {
    this.ownSessions.delete(uri);
    this.ownChats.delete(uri);
  }

  /** Drops everything, for a fresh connection. */
  reset(): void {
    this.ownRoot = { agents: [] };
    this.ownSessions.clear();
    this.ownChats.clear();
  }

  override apply(envelope: ActionEnvelope): void {
    const { channel, action } = envelope;
    if (channel === ROOT) { this.ownRoot = rootReducer(this.ownRoot, action as RootAction, quiet); return; }
    const session = this.ownSessions.get(channel);
    if (session) { this.ownSessions.set(channel, sessionReducer(session, action as SessionAction, quiet)); return; }
    const chat = this.ownChats.get(channel);
    if (chat) { this.ownChats.set(channel, droppedSteer(chatReducer(chat, action as ChatAction, quiet), action as ChatAction)); return; }
    super.apply(envelope);
  }
}

/**
 * VS Code's host lists its steer in `queuedMessages` too (kind "steering") and drops that entry on a
 * steering pendingMessageRemoved; the package's reducer clears only `steeringMessage`, so a removed
 * steer stayed in this mirror's queue and every read showed it again (owner's X did nothing, ZAC-233).
 */
export function droppedSteer(chat: ChatState, action: ChatAction): ChatState {
  if (action.type !== "chat/pendingMessageRemoved" || action.kind !== "steering") return chat;
  const queue = (chat.queuedMessages ?? []) as readonly { id: string; kind?: string }[];
  const kept = queue.filter((each) => !(each.id === action.id && each.kind === "steering"));
  if (kept.length === queue.length) return chat;
  return { ...chat, queuedMessages: kept as ChatState["queuedMessages"] };
}
