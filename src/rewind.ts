/**
 * Going back to before you asked.
 *
 * The trail already records every file change and every risky command, and
 * `/yolo undo 3` walks back three of them. That is the right unit for the
 * gate and the wrong unit for a person: nobody thinks "undo the last four
 * file writes", they think "forget I asked that". A turn is a dozen trail
 * entries, and counting them is work the human should not be doing.
 *
 * So every prompt gets a checkpoint of its own — the working tree as it stood
 * when you hit enter, plus the session entry your message became. Those are
 * two independent things to come back to, and which one you want depends on
 * what went wrong: the code went sideways, or the conversation did, or both.
 *
 * Pure: choosing and describing. The extension runs git and moves the session.
 */

import type { TrailEntry } from "./types.ts";

export interface RewindPoint {
  seq: number;
  timestamp: number;
  /** What you typed, clipped. */
  prompt: string;
  /** The session entry the message became, for conversation rewind. */
  entryId: string | null;
  /** Dangling commit holding the tree as it stood, for code rewind. */
  stashSha: string | null;
  gitHead: string | null;
}

export function rewindPoints(entries: readonly TrailEntry[]): RewindPoint[] {
  return entries
    .filter((e) => e.type === "prompt")
    .sort((a, b) => b.seq - a.seq)
    .map((e) => ({
      seq: e.seq,
      timestamp: e.timestamp,
      prompt: e.target,
      entryId: typeof e.entryId === "string" && e.entryId ? e.entryId : null,
      stashSha: e.stashSha ?? null,
      gitHead: e.gitHead ?? null,
    }));
}

function when(timestamp: number): string {
  return new Date(timestamp).toISOString().replace("T", " ").slice(0, 19);
}

/** One line per prompt, newest first, numbered the way you will pick them. */
export function formatRewindList(points: readonly RewindPoint[], limit: number): string {
  if (points.length === 0) {
    return "No prompts recorded yet in this project. A checkpoint is taken each time you send one.";
  }
  const rows = points.slice(0, limit).map((point, index) => {
    const has = [point.stashSha ? "code" : null, point.entryId ? "conversation" : null]
      .filter(Boolean)
      .join(" + ");
    return `${index + 1}. ${when(point.timestamp)}  ${point.prompt}\n     can restore: ${has || "nothing — no tree change and no session entry"}`;
  });
  return [`${points.length} checkpoint(s), newest first:`, ...rows, "", "Rewind to one with: /yolo rewind <n>"].join(
    "\n",
  );
}

export type RewindArgs =
  | { kind: "list" }
  | { kind: "pick"; index: number }
  | { kind: "error"; message: string };

export function parseRewindArgs(rest: string): RewindArgs {
  const text = rest.trim();
  if (text === "") return { kind: "list" };
  if (!/^\d+$/.test(text)) {
    return { kind: "error", message: `Usage: /yolo rewind [n] — got ${JSON.stringify(rest)}.` };
  }
  const index = Number.parseInt(text, 10);
  if (index < 1) return { kind: "error", message: "Checkpoints are numbered from 1." };
  return { kind: "pick", index };
}

export type RestoreChoice = "code" | "conversation" | "both";

export const RESTORE_LABELS: Record<RestoreChoice, string> = {
  code: "The working tree only — put the files back, keep the conversation",
  conversation: "The conversation only — go back to before that message, keep the files",
  both: "Both — the files and the conversation",
};

/**
 * Only offer what this checkpoint can actually deliver. A prompt sent with a
 * clean tree has no stash to come back to, and one recorded before the
 * session entry could be resolved has nothing to navigate to; offering either
 * would be a menu entry that does nothing.
 */
export function restoreChoices(point: RewindPoint): RestoreChoice[] {
  const choices: RestoreChoice[] = [];
  if (point.stashSha) choices.push("code");
  if (point.entryId) choices.push("conversation");
  if (choices.length === 2) choices.push("both");
  return choices;
}

/** What the confirmation has to say before anything is touched. */
export function restoreSummary(point: RewindPoint, choice: RestoreChoice): string {
  const lines = [`Rewind to ${when(point.timestamp)}:`, `  ${point.prompt}`, ""];
  if (choice === "code" || choice === "both") {
    lines.push(
      `The working tree goes back to how it stood then (from ${point.stashSha?.slice(0, 8)}).`,
      "Anything written since — by you or by the agent — is overwritten, and work never committed is not recoverable afterwards.",
    );
  }
  if (choice === "conversation" || choice === "both") {
    lines.push(
      "The session moves back to just before that message. Later turns stay in the session tree and are reachable, not deleted.",
    );
  }
  lines.push("", "Go ahead?");
  return lines.join("\n");
}

/** Prompts are clipped in the trail: the first line is what identifies a turn. */
export const MAX_PROMPT_CHARS = 160;

export function clipPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r\n|\r|\n/).find((line) => line.trim() !== "") ?? "";
  const text = firstLine.trim();
  return text.length <= MAX_PROMPT_CHARS ? text : `${text.slice(0, MAX_PROMPT_CHARS - 1)}…`;
}
