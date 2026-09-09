/**
 * Seeing through a wrapper.
 *
 * The tiers match patterns against the command as written, which is exactly
 * as strong as the writing. Measured against the shipped rules:
 *
 *   rm -rf /                    block
 *   sudo rm -rf /               block
 *   bash -c 'rm -rf /'          ask     ← the quotes broke the match
 *   sh -c "rm -rf /"            ask
 *   eval "$DANGEROUS"           allow   ← nothing to match at all
 *   find . -name '*.ts' -exec rm {} +   allow
 *
 * The README calls the catastrophic tier "never overridable", and three of
 * those six get through it. A floor with a `bash -c` shaped hole in it is not
 * a floor.
 *
 * Two jobs, and they are different. **Unwrapping** recovers the real command
 * from a wrapper that hides it, so the tiers get a fair look. **Opacity** is
 * the other half: a command whose payload cannot be recovered at all —
 * `eval "$X"`, a pipe into a shell — proves nothing about its own safety, and
 * the honest verdict there is to ask rather than to assume the best.
 *
 * Pure, and deliberately conservative: unwrapping only ever produces *more*
 * strings to check, never fewer, so it can add a verdict but never remove one.
 */

/** Prefixes that run the rest of the line, contributing nothing themselves. */
const TRANSPARENT = [
  /^sudo\s+(-\w+\s+)*/,
  /^doas\s+/,
  /^nohup\s+/,
  /^time\s+/,
  /^nice\s+(-n\s*-?\d+\s+)*/,
  /^ionice\s+(-\w+\s*\d*\s+)*/,
  /^command\s+/,
  /^builtin\s+/,
  /^exec\s+/,
  /^stdbuf\s+(-\w+\s*\S*\s+)*/,
  // `env` with any number of NAME=value assignments in front.
  /^env\s+(-\w+\s+)*(\w+=\S*\s+)*/,
  // A bare assignment prefix: FOO=1 rm -rf /
  /^(\w+=\S*\s+)+/,
];

/**
 * `<shell> -c <script>` — the script is the real command. The alternatives
 * capture a single- or double-quoted script exactly, rather than taking the
 * rest of the line: `sh -c 'rm -rf /' &` would otherwise carry the trailing
 * `&` into the payload and stop the pattern matching.
 */
const SHELL_C =
  /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|k|da|fi|a)?sh\s+(?:-\w+\s+)*-\w*c\w*\s+(?:'([^']*)'|"([^"]*)"|(.*?))\s*&?\s*$/;

/** `xargs [flags] <command>` and `find … -exec <command>` both run a command. */
const XARGS = /^xargs\s+(?:-\w+(?:\s*\S+)?\s+)*(.*)$/;
const FIND_EXEC = /\s-(?:exec|execdir)\s+(.+?)\s*(?:\\;|;|\{\}\s*\+|\+)\s*$/;

/** Strip one layer of matching quotes, if the whole string is wrapped in them. */
function unquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === '"' || first === "'") && trimmed.at(-1) === first) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Every command hiding inside this one, including the original.
 *
 * Bounded on purpose: wrappers nest, but a handful of layers covers what
 * anyone writes, and an unbounded peel on adversarial input is its own
 * problem.
 */
export function unwrapCommand(command: string, depth = 6): string[] {
  const seen = new Set<string>();
  const queue: string[] = [command.trim()];

  while (queue.length > 0 && seen.size < 64) {
    const current = queue.shift();
    if (current === undefined) break;
    const text = current.trim();
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    if (seen.size > depth * 8) break;

    for (const prefix of TRANSPARENT) {
      const stripped = text.replace(prefix, "");
      if (stripped !== text) queue.push(stripped);
    }

    const shell = SHELL_C.exec(text);
    const script = shell?.[1] ?? shell?.[2] ?? shell?.[3];
    if (script) queue.push(unquote(script));

    const xargs = XARGS.exec(text);
    if (xargs?.[1]) queue.push(unquote(xargs[1]));

    const exec = FIND_EXEC.exec(text);
    if (exec?.[1]) queue.push(unquote(exec[1]));

    // Each side of a chain is its own command; a safe left half must not
    // vouch for a dangerous right half.
    for (const part of text.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
      if (part && part !== text) queue.push(part);
    }
  }

  return [...seen];
}

/**
 * Commands whose payload cannot be read from the text.
 *
 * `eval "$CMD"` and `sh -c "$SCRIPT"` are not dangerous because of what they
 * say — they say nothing. Passing them because no pattern matched is
 * answering "is this safe?" with "I could not tell", which is the one answer
 * a gate must never round down to yes.
 */
const OPAQUE: Array<{ name: string; re: RegExp }> = [
  { name: "eval", re: /(^|[\s;&|])eval(\s|$)/ },
  // A shell whose script is a variable, a substitution, or read from stdin.
  { name: "shell-from-variable", re: /-\w*c\w*\s+["']?\$[\w{(]/ },
  { name: "shell-from-stdin", re: /(^|\|)\s*(?:ba|z|k|da|fi)?sh\s*(?:-\w+\s*)*$/ },
  { name: "source-variable", re: /(^|[\s;&|])(source|\.)\s+["']?\$/ },
  { name: "base64-to-shell", re: /\bbase64\s+(-\w+\s+)*-{1,2}d\w*\b[^|]*\|/ },
];

export function opacityOf(command: string): string | null {
  const text = command.trim();
  for (const rule of OPAQUE) {
    if (rule.re.test(text)) return rule.name;
  }
  return null;
}
