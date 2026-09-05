/**
 * Local structural types for @pify/yolo.
 * No imports from pi packages: src/ typechecks and runs standalone.
 */

export type Mode = "guard" | "yolo";

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
  type: "file" | "bash";
  /** file: absolute path edited/written. bash: the command. */
  target: string;
  /** file: saved pre-image filename (null when the file did not exist). */
  saved: string | null;
  /** file: whether the file existed before the change. */
  existed: boolean;
  cwd?: string;
  gitHead?: string;
  /** bash: dangling `git stash create` commit holding the pre-command tree. */
  stashSha?: string;
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
