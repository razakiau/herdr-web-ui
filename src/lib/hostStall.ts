// A sent message the agent never started on (owner, ZAC-233, 2026-10-26). After an abort or a
// session error the Copilot CLI sometimes runs its prompt hooks and then drops the prompt: VS Code's
// host says the send returned, the chat stays "working", and nothing ever comes (seen on Specifica
// 2026-10-25 17:51 and sparklin-devops 21:06). The owner's fix each time was Stop, then send again.
import type { ConversationTurn } from "../../shared/protocol.ts";

/** How long a running turn may show nothing before the chat offers to send it again. A real turn's
 * first reasoning or text came within 2-19 s in the same logs; 45 s leaves a slow model room. */
export const STALL_MS = 45_000;

/**
 * The running turn's message, when the turn has shown nothing for STALL_MS since it started; null
 * otherwise, or when it carried pictures (the transcript keeps a reference, not the bytes).
 */
export function stalledMessage(chat: { busy: boolean; turns: readonly ConversationTurn[] }, now: number): { text: string } | null {
  if (!chat.busy) return null;
  const reply = chat.turns.at(-1);
  const asked = chat.turns.at(-2);
  if (reply?.role !== "assistant" || asked?.role !== "user" || reply.parts.length > 0) return null;
  const started = Date.parse(asked.ts ?? "");
  if (!Number.isFinite(started) || now - started < STALL_MS) return null;
  if (asked.parts.some((part) => part.kind !== "text")) return null;
  const text = asked.parts.map((part) => part.kind === "text" ? part.text : "").join("");
  return text.trim() === "" ? null : { text };
}
