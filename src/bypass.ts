/**
 * Bash as a side door.
 *
 * Two guards this package already ships only see the dedicated tools: the
 * grep tool's result has secret lines withheld, and edit/write are refused
 * blind or stale. Run the same action through bash and neither fires —
 * `grep -rn password .` prints every .env line the grep tool would have
 * hidden, and `sed -i` rewrites a file nobody read. This recognises those
 * shapes so the gate can ask (in the modes that ask) and point the agent
 * at the tool that is guarded. Recognition only; the mode gradient decides.
 *
 * Deliberately narrow: a recursive grep over a directory (or over nothing,
 * which is the directory), and an in-place editor with a file operand. A
 * `grep` on one named file, or a piped `| grep`, is not a sweep.
 * (oh-my-pi's bash-interceptor, reduced to the two cases that bypass a guard.)
 */
import { unwrapCommand } from "./unwrap.ts";

export type Bypass =
  | { kind: "grep-sweep"; rule: "bypass:grep-sweep"; command: string }
  | { kind: "inplace-edit"; rule: "bypass:inplace-edit"; command: string; paths: string[] };

const GREP_LIKE = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
/** Tools whose default is already recursive. */
const RECURSIVE_BY_DEFAULT = new Set(["rg", "ag", "ack"]);

function words(segment: string): string[] {
  return segment.trim().split(/\s+/).filter(Boolean);
}

/** Drop `FOO=bar` assignments and privilege/scheduling wrappers in front of the real command. */
function stripLeading(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || t === "sudo" || t === "command" || t === "nice" || t === "time") i++;
    else break;
  }
  return tokens.slice(i);
}

function commandName(token: string): string {
  return token.replace(/^.*[\\/]/, "").replace(/^["']|["']$/g, "");
}

/** `.`, `..`, `~`, `/`, `src/`, `src`, `*` — a target that is a tree, not one file. */
export function isDirLike(target: string): boolean {
  const t = target.replace(/^["']|["']$/g, "");
  if (t === "" || t === "." || t === ".." || t === "~" || t === "/" || t.endsWith("/")) return true;
  if (/[*?[]/.test(t)) return true;
  const base = t.replace(/^.*[\\/]/, "");
  return !base.includes(".");
}

function grepSweep(tokens: string[]): boolean {
  const cmd = commandName(tokens[0]!);
  const rest = tokens.slice(1);
  const flags = rest.filter((x) => x.startsWith("-") && x !== "-");
  const args = rest.filter((x) => !x.startsWith("-") || x === "-");
  const recursive =
    RECURSIVE_BY_DEFAULT.has(cmd) ||
    flags.some((f) => f === "--recursive" || f === "--dereference-recursive" || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(f));
  if (!recursive) return false;
  // args[0] is the pattern (unless given via -e); what follows are the targets.
  const hasE = flags.some((f) => f === "-e" || f.startsWith("--regexp"));
  const targets = hasE ? args : args.slice(1);
  return targets.length === 0 || targets.some(isDirLike);
}

function inPlacePaths(tokens: string[]): string[] | null {
  const cmd = commandName(tokens[0]!);
  const rest = tokens.slice(1);
  if (cmd === "sed") {
    const inPlace = rest.some((x) => /^--in-place(=|$)/.test(x) || /^-(?!-)[A-Za-z]*i/.test(x));
    if (!inPlace) return null;
    const files: string[] = [];
    let scriptGiven = false;
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i]!;
      if (t === "-e" || t === "--expression" || t === "-f" || t === "--file") {
        scriptGiven = true;
        i++;
        continue;
      }
      if (t.startsWith("-") && t !== "-") continue;
      files.push(t);
    }
    return scriptGiven ? files : files.slice(1);
  }
  if (cmd === "perl") {
    const inPlace = rest.some((x) => /^-(?!-)[A-Za-z]*i/.test(x));
    if (!inPlace) return null;
    const files: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i]!;
      if (/^-(?!-)[A-Za-z]*[eE]$/.test(t)) {
        i++; // the script
        continue;
      }
      if (t.startsWith("-") && t !== "-") continue;
      files.push(t);
    }
    return files;
  }
  if (cmd === "awk" || cmd === "gawk") {
    const joined = rest.join(" ");
    if (!/(^|\s)(?:-i\s+inplace|--inplace)(\s|$)/.test(joined)) return null;
    const files: string[] = [];
    let programGiven = false;
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i]!;
      if (t === "-i" || t === "-v" || t === "-F") {
        i++;
        continue;
      }
      if (t === "-f") {
        programGiven = true;
        i++;
        continue;
      }
      if (t.startsWith("-")) continue;
      files.push(t);
    }
    return programGiven ? files : files.slice(1);
  }
  return null;
}

/** The first side-door shape found in the command, or null. */
export function detectBypass(command: string): Bypass | null {
  for (const segment of unwrapCommand(command)) {
    const tokens = stripLeading(words(segment));
    if (tokens.length === 0) continue;
    const cmd = commandName(tokens[0]!);
    if (GREP_LIKE.has(cmd) && grepSweep(tokens)) {
      return { kind: "grep-sweep", rule: "bypass:grep-sweep", command: segment };
    }
    const paths = inPlacePaths(tokens);
    if (paths !== null) return { kind: "inplace-edit", rule: "bypass:inplace-edit", command: segment, paths };
  }
  return null;
}

/** What to do instead, for the model. */
export function bypassAdvice(rule: string): string {
  if (rule === "bypass:grep-sweep") {
    return "A recursive grep through bash walks into .env files and credentials and prints their lines; use the grep tool instead — it withholds secret material and is not asked about.";
  }
  if (rule === "bypass:inplace-edit") {
    return "An in-place editor through bash rewrites a file nobody read; read the file, then use the edit tool, which checks that.";
  }
  return "";
}
