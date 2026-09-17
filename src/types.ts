/**
 * Local structural types for @pify/yolo.
 * No imports from pi packages: src/ typechecks and runs standalone.
 */

/** Four positions on the safety gradient; see src/modes.ts (v0.4). */
export type Mode = "yolo" | "auto" | "approve" | "strict";

export type RuleAction = "allow" | "ask" | "block";

export interface RuleHit {
  action: RuleAction;
  /** Human label of the matching rule, e.g. "rm-rf-root". */
  rule: string;
}

export interface UserRule {
  pattern: string;
  action: RuleAction;
}

export interface TrailEntry {
  seq: number;
  timestamp: number;
  /** undo: a marker recording which file entries a /yolo undo already consumed. */
  type: "file" | "bash" | "prompt" | "undo";
  /** file: absolute path edited/written. bash: the command. prompt: what you typed. undo: a summary. */
  target: string;
  /** file/undo: saved pre-image filename (null when the file did not exist). */
  saved: string | null;
  /** file: whether the file existed before the change. */
  existed: boolean;
  cwd?: string;
  /** bash: which shell tool ran it ("bash" | "powershell"); absent on older entries means bash. */
  tool?: string;
  gitHead?: string;
  /** bash/prompt: dangling `git stash create` commit holding the tree as it stood. */
  stashSha?: string;
  /**
   * prompt: the tree was clean at prompt time, so `gitHead` IS the tree to
   * restore even though no stash was taken. Only set when git confirmed the
   * tracked tree had nothing to save — never on a failed checkpoint.
   */
  cleanAtHead?: boolean;
  /** prompt: the session entry the message became, for conversation rewind. */
  entryId?: string;
  /** undo: the file-entry seqs this restore consumed, excluded from the next undo. */
  undone?: number[];
}

export interface BranchEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
