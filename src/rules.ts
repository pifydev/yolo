import type { RuleAction, RuleHit, UserRule } from "./types.ts";

/**
 * Three-tier bash safety rules (pi-yolo-seatbelt's model):
 * BLOCK for catastrophic patterns, ASK for destructive ones, ALLOW the rest.
 * User rules (wildcard, last-match-wins — zhushanwen semantics) can retune
 * ASK/ALLOW, but catastrophic BLOCKs are a hard floor no rule can override.
 * Fail-closed: anything that throws during evaluation blocks.
 */

interface BuiltinRule {
  name: string;
  action: Exclude<RuleAction, "allow">;
  re: RegExp;
}

/** Catastrophic — never overridable. */
const CATASTROPHIC: BuiltinRule[] = [
  { name: "rm-rf-root", action: "block", re: /\brm\s+(-\w*[rR]\w*\s+)*(-\w*[rR]\w*)\s+(["']?)(\/|\/\*)\3(\s|$)/ },
  { name: "rm-rf-home", action: "block", re: /\brm\s+-\w*[rR]\w*\s+(["']?)(~|\$HOME)\1(\/?)(\s|$)/ },
  { name: "rm-rf-git", action: "block", re: /\brm\s+-\w*[rR]\w*[fF]?\w*\s+\S*\.git(\s|$|\/)/ },
  { name: "mkfs", action: "block", re: /\bmkfs(\.\w+)?\b/ },
  { name: "dd-device", action: "block", re: /\bdd\b[^|;&]*\bof=\/dev\// },
  { name: "fork-bomb", action: "block", re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { name: "chmod-777-root", action: "block", re: /\bchmod\s+(-\w+\s+)*777\s+\/(\s|$)/ },
  { name: "write-device", action: "block", re: />\s*\/dev\/(sd[a-z]|nvme\d|disk\d)/ },
];

/** Destructive — confirmation required in guard mode; user rules may retune. */
const DESTRUCTIVE: BuiltinRule[] = [
  { name: "rm-rf", action: "ask", re: /\brm\s+-\w*([rR]\w*[fF]|[fF]\w*[rR])\w*\s/ },
  { name: "rm-r", action: "ask", re: /\brm\s+-\w*[rR]\w*\s/ },
  { name: "git-push-force", action: "ask", re: /\bgit\s+push\b[^|;&]*(\s--force(-with-lease)?\b|\s-f\b)/ },
  { name: "git-reset-hard", action: "ask", re: /\bgit\s+reset\s+--hard\b/ },
  { name: "git-clean-force", action: "ask", re: /\bgit\s+clean\b[^|;&]*\s-\w*[fdx]/ },
  { name: "git-branch-delete", action: "ask", re: /\bgit\s+branch\s+(-D|--delete\s+--force)\b/ },
  { name: "git-discard", action: "ask", re: /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/ },
  { name: "pipe-to-shell", action: "ask", re: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/ },
  { name: "find-delete", action: "ask", re: /\bfind\b[^|;&]*\s-delete\b/ },
  { name: "chmod-777", action: "ask", re: /\bchmod\s+(-\w+\s+)*777\b/ },
  { name: "truncate", action: "ask", re: /\btruncate\s+-s\s*0\b/ },
  { name: "history-rewrite", action: "ask", re: /\bgit\s+(rebase|filter-branch|filter-repo)\b/ },
];

/**
 * Secret material (cc-safety-net's second pillar). Reading these is how a
 * credential leaves the machine, so the check is on the path, not the verb —
 * and unlike the destructive tier it still asks in yolo mode.
 */
const SECRET_PATHS: BuiltinRule[] = [
  { name: "env-file", action: "ask", re: /(^|\/)\.env(\.[\w-]+)*$/ },
  { name: "ssh-key", action: "ask", re: /(^|\/)(\.ssh\/.*|id_(rsa|dsa|ecdsa|ed25519)(_\w+)?)$/ },
  { name: "aws-credentials", action: "ask", re: /(^|\/)\.aws\/(credentials|config)$/ },
  { name: "agent-auth", action: "ask", re: /(^|\/)(\.pi\/agent\/auth\.json|\.claude\/\.credentials\.json)$/ },
  { name: "registry-token", action: "ask", re: /(^|\/)(\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials)$/ },
  { name: "gh-hosts", action: "ask", re: /(^|\/)\.config\/gh\/hosts\.ya?ml$/ },
  { name: "private-key", action: "ask", re: /\.(pem|key|p12|pfx|keystore|jks)$/ },
  { name: "secrets-file", action: "ask", re: /(^|\/)(secrets?|credentials)\.(json|ya?ml|toml)$/ },
];

/** Example/sample templates carry no secrets — never worth a prompt. */
const SECRET_EXEMPT = /(^|\/)[\w.-]*\.(example|sample|template|dist)$|\.pub$/;

/** Name of the secret class this path belongs to, or null. */
export function secretPathKind(path: string): string | null {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^["']|["']$/g, "").toLowerCase();
  if (!normalized || SECRET_EXEMPT.test(normalized)) return null;
  for (const rule of SECRET_PATHS) {
    if (rule.re.test(normalized)) return rule.name;
  }
  return null;
}

/** Secret paths named anywhere in a shell command (cat, cp, curl -T, …). */
export function secretPathsIn(command: string): string[] {
  const kinds = new Set<string>();
  for (const token of command.split(/[\s;|&()<>]+/)) {
    const kind = secretPathKind(token);
    if (kind) kinds.add(kind);
  }
  return [...kinds];
}

/**
 * Verdict for a file path a tool is about to touch. Default is allow; secret
 * material asks. User rules (matched against the path) get the last word, so
 * a wildcard rule ending in `/.env` with action "allow" opts a project out.
 */
export function evaluatePath(path: string, userRules: UserRule[] = []): RuleHit {
  try {
    const kind = secretPathKind(path);
    let verdict: RuleHit = kind ? { action: "ask", rule: `secret:${kind}` } : { action: "allow", rule: "default" };
    const normalized = path.replace(/\\/g, "/");
    for (const rule of userRules) {
      try {
        if (wildcardToRegex(rule.pattern).test(normalized)) {
          verdict = { action: rule.action, rule: `user:${rule.pattern}` };
        }
      } catch {
        // invalid user pattern — ignore that rule
      }
    }
    return verdict;
  } catch {
    return { action: "block", rule: "fail-closed" };
  }
}

/** Convert a user wildcard pattern (`git push*`) to a regex. */
export function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function normalize(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

export function evaluateCommand(command: string, userRules: UserRule[] = []): RuleHit {
  try {
    const normalized = normalize(command);
    if (!normalized) return { action: "allow", rule: "empty" };

    // Hard floor: catastrophic patterns are non-negotiable.
    for (const rule of CATASTROPHIC) {
      if (rule.re.test(normalized)) return { action: "block", rule: rule.name };
    }

    // Builtin destructive verdict, then user rules last-match-wins on top.
    let verdict: RuleHit = { action: "allow", rule: "default" };
    for (const rule of DESTRUCTIVE) {
      if (rule.re.test(normalized)) {
        verdict = { action: rule.action, rule: rule.name };
        break;
      }
    }
    if (verdict.action === "allow") {
      const secrets = secretPathsIn(normalized);
      if (secrets.length > 0) verdict = { action: "ask", rule: `secret:${secrets.join(",")}` };
    }
    for (const rule of userRules) {
      try {
        if (wildcardToRegex(rule.pattern).test(normalized)) {
          verdict = { action: rule.action, rule: `user:${rule.pattern}` };
        }
      } catch {
        // invalid user pattern — ignore that rule
      }
    }
    return verdict;
  } catch {
    // Fail-closed (zhushanwen's rule): evaluation errors never allow.
    return { action: "block", rule: "fail-closed" };
  }
}

export function parseUserRules(raw: unknown): UserRule[] {
  if (typeof raw !== "object" || raw === null) return [];
  const rules = (raw as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return [];
  const valid: UserRule[] = [];
  for (const rule of rules) {
    if (
      typeof rule === "object" &&
      rule !== null &&
      typeof (rule as UserRule).pattern === "string" &&
      ["allow", "ask", "block"].includes((rule as UserRule).action)
    ) {
      valid.push({ pattern: (rule as UserRule).pattern, action: (rule as UserRule).action });
    }
  }
  return valid;
}
