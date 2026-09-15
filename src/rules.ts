import type { RuleAction, RuleHit, UserRule } from "./types.ts";
import { opacityOf, unwrapCommand } from "./unwrap.ts";

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
  // Windows: formatting a drive is the mkfs of this platform. Anchored to a
  // command boundary so the `--format` flag of other tools is not caught.
  { name: "win-format", action: "block", re: /(^|[\s;&|(])format\s+(?:\/[\w:]+\s+)*[a-zA-Z]:/i },
];

/** Destructive — confirmation required in guard mode; user rules may retune. */
const DESTRUCTIVE: BuiltinRule[] = [
  { name: "rm-rf", action: "ask", re: /\brm\s+-\w*([rR]\w*[fF]|[fF]\w*[rR])\w*(\s|$)/ },
  { name: "rm-r", action: "ask", re: /\brm\s+-\w*[rR]\w*(\s|$)/ },
  // GNU long flag: `rm --recursive dir` is `rm -r dir`, and used to auto-run
  // because the short-flag patterns above never saw it.
  { name: "rm-r", action: "ask", re: /\brm\s+[^|;&]*--recursive\b/ },
  { name: "git-push-force", action: "ask", re: /\bgit\s+push\b[^|;&]*(\s--force(-with-lease)?\b|\s-f\b)/ },
  { name: "git-reset-hard", action: "ask", re: /\bgit\s+reset\s+--hard\b/ },
  { name: "git-clean-force", action: "ask", re: /\bgit\s+clean\b[^|;&]*\s-\w*[fdx]/ },
  { name: "git-branch-delete", action: "ask", re: /\bgit\s+branch\s+(-D|--delete\s+--force)\b/ },
  { name: "git-discard", action: "ask", re: /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/ },
  { name: "pipe-to-shell", action: "ask", re: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/ },
  { name: "find-delete", action: "ask", re: /\bfind\b[^|;&]*\s-delete\b/ },
  // `-exec rm {} +` deletes every match. Unwrapping exposes only the bare
  // `rm`, which is not itself flagged — the danger is in the pairing.
  {
    name: "find-exec-mutating",
    action: "ask",
    re: /\bfind\b[^|;&]*\s-exec(dir)?\s+(sudo\s+)?(rm|mv|cp|chmod|chown|truncate|dd|tee|sh|bash|zsh)\b/,
  },
  { name: "chmod-777", action: "ask", re: /\bchmod\s+(-\w+\s+)*777\b/ },
  { name: "truncate", action: "ask", re: /\btruncate\s+-s\s*0\b/ },
  { name: "history-rewrite", action: "ask", re: /\bgit\s+(rebase|filter-branch|filter-repo)\b/ },
  // Windows destructive shapes. `rmdir`/`rd` and `del` recurse a whole tree
  // with `/s`; PowerShell's `Remove-Item -Recurse` is `rm -rf` by another
  // name. Flags are case-insensitive on Windows, and the payload may arrive
  // through `cmd /c` or `powershell -Command`, which unwrapCommand sees through.
  { name: "win-rmdir", action: "ask", re: /\b(?:rmdir|rd)\b[^|;&]*\/[sS]\b/i },
  { name: "win-del", action: "ask", re: /\bdel\b[^|;&]*\/[sS]\b/i },
  { name: "win-remove-item", action: "ask", re: /\bremove-item\b[^|;&]*\s-r(?:ecurse)?\b/i },
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

/** Actions ordered by restrictiveness, for "most restrictive wins". */
const SEVERITY: Record<RuleAction, number> = { allow: 0, ask: 1, block: 2 };

/**
 * A catastrophic-rm supplement that runs ALONGSIDE the anchored regexes in
 * CATASTROPHIC and only ever ADDS a block. Those regexes miss several shapes
 * that still wipe a filesystem root: GNU long flags (`rm --recursive --force
 * /`), a `--` end-of-options separator (`rm -rf -- /`), doubled or dotted
 * roots (`//`, `/.`, `/..`), an ANSI-C quoted target (`rm -rf $'/'`), and a
 * Windows drive root (`rm -rf C:\`). This detects any rm carrying a recursive
 * flag whose target normalizes to a root, and errs toward blocking — only true
 * roots, never a deep path like `/home/x/tmp`.
 */
function rmRecursivelyHitsRoot(command: string): boolean {
  // `rm` used as a command word: at the start or after a shell separator.
  for (const match of command.matchAll(/(?:^|[\s;&|(])rm(?=\s)/g)) {
    const rest = command.slice((match.index ?? 0) + match[0].length);
    if (rmArgsHitRoot(rest)) return true;
  }
  return false;
}

/** Whether an rm argument list carries a recursive flag and a root target. */
function rmArgsHitRoot(rest: string): boolean {
  let recursive = false;
  let target = false;
  let optionsEnded = false;
  for (const token of rest.split(/\s+/)) {
    if (token === "") continue;
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("-")) {
      // A recursive flag: --recursive, or a short cluster containing r/R.
      if (token === "--recursive" || (/^-[a-zA-Z]+$/.test(token) && /[rR]/.test(token))) {
        recursive = true;
      }
      continue; // any other flag (--force, --no-preserve-root, …)
    }
    if (isFilesystemRoot(token)) target = true;
  }
  return recursive && target;
}

/** True when a bare rm target normalizes to a filesystem root. */
function isFilesystemRoot(rawTarget: string): boolean {
  const t = stripQuotes(rawTarget);
  if (t === "") return false;
  if (t === "~" || t === "$HOME" || t === "${HOME}") return true;
  // Windows backslashes → forward, then collapse runs of slashes.
  const collapsed = t.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (collapsed === "/" || collapsed === "/." || collapsed === "/.." || collapsed === "/*") return true;
  // A bare drive root: C:, C:/, C:\ (already forward-slashed above).
  if (/^[a-zA-Z]:\/?$/.test(collapsed)) return true;
  return false;
}

/** Strip surrounding quotes and a $'…' / $"…" ANSI-C wrapper, repeatedly. */
function stripQuotes(raw: string): string {
  let t = raw.trim();
  let prev = "";
  while (t !== prev) {
    prev = t;
    if (t.length >= 3 && (t.startsWith("$'") || t.startsWith('$"')) && t.at(-1) === t[1]) {
      t = t.slice(2, -1);
    } else if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.at(-1) === t[0]) {
      t = t.slice(1, -1);
    }
    t = t.trim();
  }
  return t;
}

export function evaluateCommand(command: string, userRules: UserRule[] = []): RuleHit {
  try {
    const normalized = normalize(command);
    if (!normalized) return { action: "allow", rule: "empty" };

    // A wrapper is not a disguise. The tiers are matched against every
    // command hiding inside this one as well as the one as written, because
    // `bash -c 'rm -rf /'` used to reach the ASK tier and `find -exec rm`
    // reached nothing at all.
    const forms = unwrapCommand(normalized).map(normalize).filter(Boolean);

    // Hard floor: catastrophic patterns are non-negotiable, wherever they hide.
    for (const rule of CATASTROPHIC) {
      for (const form of forms) {
        if (rule.re.test(form)) return { action: "block", rule: rule.name };
      }
    }
    // Robust supplement to the anchored rm patterns above (adds blocks only,
    // never weakens them): a recursive rm whose target normalizes to a root.
    for (const form of forms) {
      if (rmRecursivelyHitsRoot(form)) return { action: "block", rule: "rm-rf-root" };
    }

    // Builtin destructive verdict, then user rules last-match-wins on top.
    let verdict: RuleHit = { action: "allow", rule: "default" };
    outer: for (const rule of DESTRUCTIVE) {
      for (const form of forms) {
        if (rule.re.test(form)) {
          verdict = { action: rule.action, rule: rule.name };
          break outer;
        }
      }
    }
    if (verdict.action === "allow") {
      const secrets = forms.flatMap((form) => secretPathsIn(form));
      if (secrets.length > 0) verdict = { action: "ask", rule: `secret:${[...new Set(secrets)].join(",")}` };
    }
    // A command whose payload cannot be read proves nothing about itself, and
    // "I could not tell" must not round down to yes. Checked per form, not
    // just on the original: `sh -c` unwraps to an inner command, and an
    // opaque INNER command — an eval buried one wrapper down — is exactly as
    // unreadable as an opaque outer one.
    if (verdict.action === "allow") {
      for (const form of forms) {
        const opaque = opacityOf(form);
        if (opaque) {
          verdict = { action: "ask", rule: `opaque:${opaque}` };
          break;
        }
      }
    }
    // User rules, last-match-wins on the command as written — all three
    // actions, preserving the historical semantics and the conservative allow.
    for (const rule of userRules) {
      try {
        if (wildcardToRegex(rule.pattern).test(normalized)) {
          verdict = { action: rule.action, rule: `user:${rule.pattern}` };
        }
      } catch {
        // invalid user pattern — ignore that rule
      }
    }
    // A wrapper must not void a block/ask rule the user wrote: `sudo npm run
    // deploy` and `bash -c 'npm run deploy'` both hide `npm run deploy`, so a
    // restrictive rule is matched against every hidden form too and the most
    // restrictive wins. ALLOW rules stay matched against the original only (the
    // conservative asymmetry), so a wrapper can only ever tighten, never relax.
    const hidden = forms.filter((form) => form !== normalized);
    if (hidden.length > 0) {
      for (const rule of userRules) {
        if (rule.action === "allow") continue;
        try {
          const re = wildcardToRegex(rule.pattern);
          if (hidden.some((form) => re.test(form)) && SEVERITY[rule.action] > SEVERITY[verdict.action]) {
            verdict = { action: rule.action, rule: `user:${rule.pattern}` };
          }
        } catch {
          // invalid user pattern — ignore that rule
        }
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
