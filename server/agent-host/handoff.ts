/**
 * "Hand off & continue" (ZAC-262): `/handoff` is sent to a chat, its turn awaited, and the
 * `/resume <topic>` line its reply ends with starts the next chat in the same folder on the same
 * model; the old chat is archived only once the new one exists. The steps that touch the host are
 * the route's (routes.ts, handoffChat); this file holds the jobs and their order.
 *
 * Invariants:
 * - One job per chat at a time: a second start while one runs is that job.
 * - Nothing is archived unless a new chat was made and its `/resume` message went.
 * - A job is forgotten HANDOFF_FORGET_MS after it ends; the bridge's restart forgets them all.
 */
import type { HandoffJob } from "../../shared/host-chats.ts";
import type { AgentHost, LeaseClock } from "./routes.ts";

/** The harness skill's fixed last line (plugins/harness handoff): the topic the next chat resumes. */
export const RESUME_LINE = /^Start the next chat with: \/resume (\S+)$/m;
/** How long the `/handoff` turn may run before the job gives up (owner-approved, spec 2b). */
export const HANDOFF_WAIT_MS = 20 * 60_000;
/** How long an ended job stays readable, so a phone or CT 208 following it reads how it ended. */
export const HANDOFF_FORGET_MS = 60 * 60_000;

/** The topic of the last `/resume` line in `text`, else null. */
export function resumeTopic(text: string): string | null {
  let topic: string | null = null;
  for (const match of text.matchAll(new RegExp(RESUME_LINE.source, "gm"))) topic = match[1]!;
  return topic;
}

const jobSets = new WeakMap<AgentHost, Map<string, HandoffJob>>();
function jobsOf(host: AgentHost): Map<string, HandoffJob> {
  let jobs = jobSets.get(host);
  if (!jobs) { jobs = new Map(); jobSets.set(host, jobs); }
  return jobs;
}

export const handoffJob = (host: AgentHost, session: string): HandoffJob | undefined => jobsOf(host).get(session);
export const handoffRunning = (job: HandoffJob | undefined): job is HandoffJob => job !== undefined && job.endedAt === null;

/** What a job does to the host, in order; each throws when the host fails it. */
export interface HandoffSteps {
  /** Sends `/handoff` as the chat's next turn. */
  send(): Promise<void>;
  /** The ended turn's response text, or null when it has not ended by the deadline. */
  ended(): Promise<string | null>;
  /** Starts the next chat with `/resume <topic>`: its session, and whether that message went. */
  start(topic: string): Promise<{ session: string; sent: boolean }>;
  /** Archives the old chat. */
  archive(): Promise<void>;
}

/** Starts `session`'s job; the caller has checked none runs. The job runs on after this returns. */
export function startHandoff(host: AgentHost, clock: LeaseClock, session: string, steps: HandoffSteps, errorCode: (error: unknown) => string): HandoffJob {
  const job: HandoffJob = { session, state: "sending", startedAt: Date.now(), endedAt: null, topic: null, newSession: null, error: null };
  const jobs = jobsOf(host);
  jobs.set(session, job);
  const end = (state: HandoffJob["state"], error: string | null = null): void => {
    job.state = state;
    job.error = error;
    job.endedAt = Date.now();
    clock.setTimeout(() => { if (jobs.get(session) === job) jobs.delete(session); }, HANDOFF_FORGET_MS);
  };
  void (async () => {
    try {
      await steps.send();
      job.state = "waiting";
      const text = await steps.ended();
      if (text === null) return end("timeout");
      job.topic = resumeTopic(text);
      if (job.topic === null) return end("no_resume");
      job.state = "starting";
      const made = await steps.start(job.topic);
      job.newSession = made.session;
      // an empty new chat would lose the thread: the old one stays where it is, to open by hand
      if (!made.sent) return end("failed", "resume_not_sent");
      await steps.archive();
      end("done");
    } catch (error) {
      end("failed", errorCode(error));
    }
  })();
  return job;
}
