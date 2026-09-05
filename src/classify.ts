/**
 * Layer 3 of the guard (zhushanwen's model): a model reads the commands the
 * regex tiers had no opinion about. Regexes only know the destructive shapes
 * someone thought to write down; `find . -name '*.ts' -exec sed -i ... {} +`
 * is not one of them.
 *
 * Two rules keep this honest. The classifier can only ESCALATE — it may turn
 * an allow into an ask, never an ask or a block into an allow, so a model
 * that is talked into approving something cannot open the gate. And when it
 * is slow, broken, or unreadable, the deterministic verdict stands: safety
 * here comes from the rules, and the model is an extra pair of eyes.
 */

export type Risk = "safe" | "risky";

export interface Classification {
  risk: Risk;
  reason: string;
  /** True when the model was not consulted or could not be read. */
  fallback: boolean;
}

export const CLASSIFY_SYSTEM_PROMPT = [
  "You classify shell commands for a coding agent's safety guard.",
  "A command is RISKY if running it could destroy work or state that is hard to get back:",
  "deleting or overwriting files, rewriting git history, force-pushing, resetting or cleaning a",
  "working tree, mass in-place edits, dropping databases, killing processes, changing permissions",
  "or ownership broadly, downloading and executing code, or writing outside the project.",
  "A command is SAFE if it only reads, inspects, queries, builds, or tests.",
  "Judge what the command actually does, not what it is named. When you are unsure, answer risky.",
  'Answer with ONE line of JSON and nothing else: {"risk":"safe","reason":"…"} or',
  '{"risk":"risky","reason":"…"}. Keep the reason under 140 characters.',
  "Do not explain. Do not use markdown. Your entire reply must start with { and end with }.",
];

/** Commands so common that asking a model about them is pure latency. */
const OBVIOUSLY_SAFE =
  /^(git (status|log|diff|show|branch|remote|fetch)|ls|pwd|cat|head|tail|wc|grep|rg|find|which|echo|node -v|npm (ls|view|test)|bun (test|--version)|python -V|cd|whoami|date|env)\b/i;

/** Flags that turn a read-only-looking command into an executor. */
const EXECUTOR_FLAGS = /\s-(exec|execdir|delete|ok|okdir)\b/i;

/** Should the classifier be consulted for this command at all? */
export function needsClassification(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // A pipeline or chain hides its real work; always look at those.
  if (/[|;&]|&&|\$\(|`/.test(trimmed)) return true;
  // `find` is on the safe list, but `find … -exec` is a way to run anything.
  if (EXECUTOR_FLAGS.test(trimmed)) return true;
  return !OBVIOUSLY_SAFE.test(trimmed);
}

export function buildClassifyPrompt(command: string, cwd: string): string {
  return [
    `Working directory: ${cwd}`,
    "Command:",
    "```sh",
    command.trim(),
    "```",
    "Classify it.",
  ].join("\n");
}

const MAX_REASON = 140;

const RISKY_WORDS = new Set(["risky", "unsafe", "dangerous", "destructive", "irreversible"]);
const SAFE_WORDS = new Set(["safe", "harmless", "benign"]);

/** First meaningful sentence of a prose answer, trimmed to reason length. */
function summarize(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.slice(0, MAX_REASON);
}

/**
 * Read the classifier's answer. Anything unreadable falls back to safe with
 * `fallback: true` — the caller then keeps the deterministic verdict rather
 * than inventing an escalation from noise.
 */
export function parseClassification(text: string): Classification {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { risk: "safe", reason: "the classifier returned nothing", fallback: true };

  const objects = [...trimmed.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]).reverse();
  for (const raw of objects) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, MAX_REASON) : "";
    for (const key of ["risk", "verdict", "classification", "result"]) {
      const value = String(parsed[key] ?? "").toLowerCase();
      if (value === "risky" || value === "unsafe" || value === "dangerous" || value === "destructive") {
        return { risk: "risky", reason: reason || "the classifier flagged it", fallback: false };
      }
      if (value === "safe" || value === "harmless") {
        return { risk: "safe", reason: reason || "the classifier saw no risk", fallback: false };
      }
    }
    if (typeof parsed.risky === "boolean") {
      return {
        risk: parsed.risky ? "risky" : "safe",
        reason: reason || (parsed.risky ? "the classifier flagged it" : "the classifier saw no risk"),
        fallback: false,
      };
    }
  }

  // Models routinely ignore the format and write an explanation instead. Read
  // the verdict out of the prose rather than throwing the answer away: a
  // labelled verdict first, then a standalone RISKY/SAFE token (the last one
  // wins — the conclusion comes at the end), then a single unambiguous signal.
  const labelled = [...trimmed.matchAll(/\b(?:classification|verdict|risk|answer)\b\s*[:=]?\s*\**\s*(\w+)/gi)];
  for (const match of labelled.reverse()) {
    const word = match[1]!.toLowerCase();
    if (RISKY_WORDS.has(word)) return { risk: "risky", reason: summarize(trimmed), fallback: false };
    if (SAFE_WORDS.has(word)) return { risk: "safe", reason: summarize(trimmed), fallback: false };
  }

  const tokens = [...trimmed.matchAll(/\b(RISKY|SAFE|UNSAFE|DANGEROUS|DESTRUCTIVE)\b/g)];
  const lastToken = tokens.length > 0 ? tokens[tokens.length - 1]![1]! : null;
  if (lastToken) {
    return {
      risk: lastToken === "SAFE" ? "safe" : "risky",
      reason: summarize(trimmed),
      fallback: false,
    };
  }

  const risky = /\b(risky|unsafe|dangerous|destructive|irreversible)\b/i.test(trimmed);
  const safe = /\b(safe|harmless|read-only|benign)\b/i.test(trimmed);
  if (risky && !safe) return { risk: "risky", reason: summarize(trimmed), fallback: false };
  if (safe && !risky) return { risk: "safe", reason: summarize(trimmed), fallback: false };
  return { risk: "safe", reason: `unreadable classifier answer: ${trimmed.slice(0, 80)}`, fallback: true };
}

export type GuardAction = "allow" | "ask" | "block";

/**
 * Fold a classification into the deterministic verdict. Escalation only:
 * allow can become ask, nothing can become allow.
 */
export function applyClassification(
  action: GuardAction,
  classification: Classification,
): { action: GuardAction; rule: string | null } {
  if (action !== "allow") return { action, rule: null };
  if (classification.fallback || classification.risk === "safe") return { action, rule: null };
  return { action: "ask", rule: `classifier:${classification.reason}` };
}
