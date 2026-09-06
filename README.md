# @pify/yolo

A safety gradient for [pi](https://github.com/earendil-works/pi), from auto-approve-everything to ask-about-anything — with an undo trail so YOLO never means unrecoverable.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install yolo`](https://github.com/pifydev/cli) or `pi install npm:@pify/yolo`.

## Four modes, one command (v0.4)

`/yolo <mode>` moves along a gradient. Two things hold in **every** mode, which is what makes the gradient safe to move along: catastrophic commands block, and secret material asks.

| Mode | Catastrophic | Built-in destructive | Your `.pi/yolo.json` ask-rules | Everything else |
|---|---|---|---|---|
| `⚡ yolo` | blocked | runs | runs | runs |
| `⚙ auto` | blocked | runs | asks | runs |
| `🛡 approve` *(default)* | blocked | asks | asks | runs |
| `🔒 strict` | blocked | asks | asks | asks unless plainly read-only |

Bare `/yolo` still flips between `yolo` and `approve` — the two ends people actually toggle between. Sessions saved before v0.4 carried `guard`; that is what `approve` is now called, and they reopen there.

**Behaviour change in v0.4**: `yolo` used to stand the *whole* gate down, catastrophic patterns included, which contradicted the rules' own claim that the floor is never overridable. The floor now holds in yolo mode too. If you were relying on `rm -rf /` auto-approving, you were relying on a bug.

| Tier | Examples | Behavior |
|---|---|---|
| **BLOCK** | `rm -rf /`, `rm -rf ~`, `rm -rf .git`, `mkfs`, `dd of=/dev/…`, fork bomb, `> /dev/sda` | Refused outright, in every mode. Never overridable — not by user rules, not by a mode. |
| **ASK** | `rm -rf <path>`, `git push --force`, `git reset --hard`, `git clean -f`, `curl \| sh`, `find -delete`, `chmod 777`, history rewrites | Confirmation dialog with the command shown. Denials can carry your reason back to the agent. |
| ALLOW | everything else | Runs untouched (unless you are in `strict`). |

Fail-closed everywhere: rule-evaluation errors block; ASK without a UI (headless/CI) denies.

## Secret files (v0.2)

Credentials are the one thing no mode waves through — auto-approving speed is worth it, auto-approving your AWS keys into a prompt is not. Any `read`/`edit`/`write` on secret material, and any bash command that names it, asks first in every mode:

`.env` (and `.env.*`, but not `.env.example`/`.sample`/`.template`) · `~/.ssh/*` and `id_rsa`/`id_ed25519`-style keys (`.pub` halves are fine) · `.aws/credentials` · `.pi/agent/auth.json`, `.claude/.credentials.json` · `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials` · `~/.config/gh/hosts.yml` · `*.pem`, `*.key`, `*.p12`, `*.pfx` · `secrets.json`/`credentials.yaml`

A user rule opts a project out: `{ "pattern": "*/.env", "action": "allow" }`.

## Checkpoints (v0.2)

Before every risky bash command in a git repo, the trail records a `git stash create` checkpoint — a dangling commit holding the working tree exactly as it was, kept alive under `refs/pify/yolo/`. It writes nothing to your tree, index, or stash list. `/yolo trail` prints the recovery line next to the command:

```
#7 2026-09-06 11:00:12 bash  git reset --hard @a1b2c3d4
    ↩ git stash apply 9f8e7d6c5b4a
```

That covers what `/yolo undo` can't: damage done by a command rather than by an `edit`/`write`.

## The undo trail

Always on, in every mode:

- Every `edit`/`write` saves the file's **pre-image** first (per-project trail under the agent dir — survives restarts).
- Risky bash commands are logged with cwd, timestamp, and git HEAD.
- `/yolo trail` shows history; `/yolo undo [n]` restores the newest n file changes (with a confirmation listing exactly what will be touched). Files that didn't exist before are deleted; bash effects are logged but not undoable.

## AI classifier (v0.3, opt-in)

`/yolo classifier on` adds a third tier behind the regexes. Regexes only know the destructive shapes someone thought to write down — `find . -name '*.ts' -exec sed -i … {} +` is not one of them. When no rule matches, a model reads the command and can raise it to a confirmation.

Two rules keep it honest:

- **Escalation only.** It can turn `allow` into `ask`. It can never turn an `ask` or a `block` into an `allow`, so a classifier that gets talked into approving something cannot open the gate.
- **A broken classifier changes nothing.** Timeout (20s), unreadable answer, no model available → the deterministic verdict stands. Safety comes from the rules; this is a second pair of eyes, not the gate.

Obviously-safe commands (`git status`, `ls`, `cat`, `bun test`, …) skip the call entirely, so the cost lands only on unfamiliar ones.

Measured over OpenRouter on six commands (three genuinely destructive, three read-only):

| Model | Correct | Unreadable → no opinion |
|---|---|---|
| GPT-5.6 luna | 6/6 | 0 |
| GPT-5.5 | 6/6 | 0 |
| Claude Opus 4.8 | 6/6 | 0 |
| GPT-5.6 terra / sol | 5/6 | 1 |
| Claude Opus 5 | 4/6 | 1 |
| Gemini 3.1 Pro | 2/6 | 4 |
| Qwen3 235B | 2/6 | 4 |

Every miss fell back to *allow* — no run ever downgraded a command the rules had already flagged. Weaker models simply give you less extra protection.

## Custom rules

`.pi/yolo.json` — wildcard patterns, last-match-wins, may retune ASK/ALLOW but never the BLOCK floor:

```json
{
  "rules": [
    { "pattern": "git push origin dev*", "action": "allow" },
    { "pattern": "npm run deploy*", "action": "ask" }
  ]
}
```

## Commands

```
/yolo            # flip between yolo and approve
/yolo strict     # or: yolo | auto | approve | strict (v0.4)
/yolo status     # mode, the other modes, rule count, trail size
/yolo trail      # recent trail entries
/yolo undo 3     # restore the newest 3 file pre-images
/yolo classifier on   # let a model flag unfamiliar commands (v0.3)
```

## License

MIT © [Pify maintainers](https://github.com/pifydev)
