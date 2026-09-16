/**
 * The grep leak. pi's `grep` tool returns matching line CONTENT, runs ripgrep
 * with `--hidden`, and takes a `path` that may be a file — so both
 * `grep {pattern:"=", path:".env"}` and `grep {pattern:"SECRET", path:"."}`
 * hand the model the values the read gate would have asked about. Two halves
 * close it: the search path is gated like a read (in the extension), and the
 * result is scanned here, after the fact, for lines that came from secret
 * material. Those are withheld — not asked about: the command already ran,
 * and a question whose answer changes nothing is noise.
 *
 * The parser mirrors dist/core/tools/grep.js exactly. A match line is
 * `${file}:${line}: ${text}`, a context line is `${file}-${line}- ${text}`,
 * an unreadable file is `${file}:${line}: (unable to read file)`, and pi's
 * own notices come after a blank line in `[…]`. `file` is relative to the
 * search path with forward slashes when that path is a directory, and just
 * the basename when it is a file — which is why a file search needs the
 * search path itself as a candidate.
 *
 * Pure: the caller supplies the secret classifier, so user rules apply.
 */
import { posix } from "node:path";

export interface Withheld {
  /** The file as grep printed it. */
  file: string;
  /** Matching lines dropped (context lines go too, but are not counted). */
  lines: number;
}

export interface WithholdResult {
  /** The original string when nothing was withheld, so callers can compare by reference. */
  text: string;
  withheld: Withheld[];
}

function slash(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Where pi searched: the same resolution as its `resolveToCwd` — a leading
 * `@` dropped, `~` expanded, relative joined onto cwd — done in forward
 * slashes so Windows and POSIX roots join the same way.
 */
export function grepSearchRoot(path: unknown, cwd: string, home: string): string {
  const base = slash(cwd);
  const raw = typeof path === "string" ? path.trim() : "";
  const input = slash(raw.startsWith("@") ? raw.slice(1) : raw);
  let root: string;
  if (!input || input === ".") root = base;
  else if (input === "~") root = slash(home);
  else if (input.startsWith("~/")) root = posix.join(slash(home), input.slice(2));
  else if (input.startsWith("/") || /^[a-zA-Z]:\//.test(input)) root = posix.normalize(input);
  else root = posix.join(base, input);
  return root.length > 1 ? root.replace(/\/+$/, "") : root;
}

/**
 * Absolute paths a printed grep file name may stand for. A directory search
 * prints `relative(root, file)`, so the join is right; a file search prints
 * `basename(file)`, and joining that under the root would give
 * `.aws/credentials/credentials` — so when the name is the root's own
 * basename, the root itself is a candidate too.
 */
export function grepFileCandidates(root: string, file: string): string[] {
  const rel = slash(file);
  const candidates = [posix.join(root, rel)];
  if (!rel.includes("/") && posix.basename(root) === rel) candidates.push(root);
  return candidates;
}

const MATCH_LINE = /^(.+?):(\d+): /;
const CONTEXT_LINE = /^(.+?)-(\d+)- /;

/**
 * Which file a grep output line belongs to, and whether it is a match. Both
 * delimiters are tried and the EARLIER one wins: the true delimiter always
 * comes before anything in the line's content, so content that happens to
 * contain `:5: ` or `-3- ` can only make the wrong parse longer, never
 * shorter. (A file whose own name contains the other delimiter followed by a
 * space could still fool this; no rg output has ever printed one.)
 */
function parseLine(line: string): { file: string; isMatch: boolean } | null {
  const match = MATCH_LINE.exec(line);
  const context = CONTEXT_LINE.exec(line);
  if (!match && !context) return null;
  if (match && (!context || match[1]!.length <= context[1]!.length)) {
    return { file: match[1]!, isMatch: true };
  }
  return { file: context![1]!, isMatch: false };
}

function note(file: string, lines: number): string {
  return `[yolo] ${lines} matching line${lines === 1 ? "" : "s"} in ${file} withheld: secret material — use read on it to be asked`;
}

/**
 * Replace every line that came from a secret file with one note per file, in
 * the position the file first appeared. Everything else — other files, blank
 * lines, pi's trailing notices — comes back byte-identical.
 */
export function withholdSecretMatches(text: string, isSecret: (file: string) => boolean): WithholdResult {
  const verdicts = new Map<string, boolean>();
  const secret = (file: string): boolean => {
    let v = verdicts.get(file);
    if (v === undefined) {
      v = isSecret(file);
      verdicts.set(file, v);
    }
    return v;
  };

  const out: string[] = [];
  const counts = new Map<string, number>();
  const slots = new Map<string, number>();
  for (const line of text.split("\n")) {
    const parsed = parseLine(line);
    if (!parsed || !secret(parsed.file)) {
      out.push(line);
      continue;
    }
    if (!counts.has(parsed.file)) {
      counts.set(parsed.file, 0);
      slots.set(parsed.file, out.length);
      out.push(""); // the note goes here once the count is known
    }
    if (parsed.isMatch) counts.set(parsed.file, (counts.get(parsed.file) ?? 0) + 1);
  }
  if (counts.size === 0) return { text, withheld: [] };

  const withheld: Withheld[] = [];
  for (const [file, lines] of counts) {
    out[slots.get(file)!] = note(file, lines);
    withheld.push({ file, lines });
  }
  return { text: out.join("\n"), withheld };
}
