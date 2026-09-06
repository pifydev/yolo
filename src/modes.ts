/**
 * The four-mode gradient (zhushanwen). One toggle was too blunt: "guard"
 * asked about every `rm -rf build`, and "yolo" stood the whole gate down,
 * including the catastrophic floor the rules call non-negotiable. These are
 * the four positions people actually want between those extremes.
 *
 * Two invariants hold in every mode, which is what makes the gradient safe
 * to move along: the catastrophic tier always blocks, and secret material
 * always asks.
 */
import type { GuardAction } from "./classify.ts";
import type { Mode, RuleHit } from "./types.ts";

export const MODES: readonly Mode[] = ["yolo", "auto", "approve", "strict"];

export const MODE_LABELS: Record<Mode, string> = {
  yolo: "⚡ YOLO — only catastrophic commands and secrets stop you",
  auto: "⚙ auto — built-in destructive commands run; your own ask-rules still ask",
  approve: "🛡 approve — catastrophic blocks, destructive asks (default)",
  strict: "🔒 strict — anything not plainly read-only asks first",
};

export const MODE_BADGES: Record<Mode, string | undefined> = {
  yolo: "⚡ YOLO",
  auto: "⚙ auto",
  // The default needs no badge; a permanent one just becomes furniture.
  approve: undefined,
  strict: "🔒 strict",
};

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

/** Pre-v0.4 sessions stored "guard"; it is what "approve" is now called. */
export function normalizeMode(value: unknown): Mode | null {
  if (value === "guard") return "approve";
  return isMode(value) ? value : null;
}

export interface ResolveInput {
  mode: Mode;
  verdict: RuleHit;
  /** The command is on the read-only list (see classify.ts). */
  obviouslySafe: boolean;
}

/**
 * The effective action for a command, given the deterministic verdict and the
 * current mode. Modes may relax the destructive tier and tighten the allow
 * tier; they can never touch the two invariants.
 */
export function resolveAction({ mode, verdict, obviouslySafe }: ResolveInput): GuardAction {
  // Invariant 1: catastrophic patterns block everywhere, yolo included. The
  // rules call this floor non-negotiable, so a mode must not be a way under it.
  if (verdict.action === "block") return "block";
  // Invariant 2: credentials are never auto-approved (cc-safety-net pillar 2).
  if (verdict.rule.startsWith("secret:")) return "ask";

  switch (mode) {
    case "yolo":
      return "allow";
    case "auto":
      // A rule the user wrote by hand is an instruction, not a default.
      return verdict.action === "ask" && verdict.rule.startsWith("user:") ? "ask" : "allow";
    case "approve":
      return verdict.action;
    case "strict":
      return verdict.action === "allow" && obviouslySafe ? "allow" : "ask";
  }
}

/** Explains a mode-driven decision in the confirmation dialog. */
export function askTitle(mode: Mode, verdict: RuleHit): string {
  if (verdict.rule.startsWith("secret:")) return "Command touches secret material";
  if (mode === "strict" && verdict.action === "allow") return "Strict mode — unrecognised command";
  return "Destructive command";
}
