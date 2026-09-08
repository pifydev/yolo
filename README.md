# @pify/yolo

A safety gradient for [pi](https://github.com/earendil-works/pi), from auto-approve-everything to ask-about-anything — with an undo trail so YOLO never means unrecoverable.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install yolo`](https://github.com/pifydev/cli) or `pi install npm:@pify/yolo`.

## Why

Approving every command is exhausting and you stop reading them; approving none of them means an agent that cannot work. Both ends are wrong, and which end you want changes several times a day — scaffolding a prototype is not the same as touching production config.

So this is a gradient rather than a switch, with two properties that hold at *every* setting: catastrophic commands are refused outright, and anything touching credentials asks. Those two make the rest safe to slide.

The second half is the undo trail. A guard that only says no is a guard you turn off; a guard that lets you take the risk *and* take it back is one you can live with.

## Four modes, one command

`/yolo <mode>` moves along a gradient. Two things hold in **every** mode, which is what makes the gradient safe to move along: catastrophic commands block, and secret material asks.

| Mode | Catastrophic | Built-in destructive | Your `.pi/yolo.json` ask-rules | Everything else |
|---|---|---|---|---|
| `⚡ yolo` | blocked | runs | runs | runs |
| `⚙ auto` | blocked | runs | asks | runs |
| `🛡 approve` *(default)* | blocked | asks | asks | runs |
| `🔒 strict` | blocked | asks | asks | asks unless plainly read-only |

Bare `/yolo` still flips between `yolo` and `approve` — the two ends people actually toggle between. Sessions saved before the gradient existed carried `guard`; that is what `approve` is now called, and they reopen there.

**A behaviour change worth knowing about**: `yolo` used to stand the *whole* gate down, catastrophic patterns included, which contradicted the rules' own claim that the floor is never overridable. The floor now holds in yolo mode too. If you were relying on `rm -rf /` auto-approving, you were relying on a bug.

| Tier | Examples | Behavior |
|---|---|---|
| **BLOCK** | `rm -rf /`, `rm -rf ~`, `rm -rf .git`, `mkfs`, `dd of=/dev/…`, fork bomb, `> /dev/sda` | Refused outright, in every mode. Never overridable — not by user rules, not by a mode. |
| **ASK** | `rm -rf <path>`, `git push --force`, `git reset --hard`, `git clean -f`, `curl \| sh`, `find -delete`, `chmod 777`, history rewrites | Confirmation dialog with the command shown. Denials can carry your reason back to the agent. |
| ALLOW | everything else | Runs untouched (unless you are in `strict`). |

Fail-closed everywhere: rule-evaluation errors block; ASK without a UI (headless/CI) denies.

## Writing a file nobody looked at

pi's `write` tool replaces a file whole, with no requirement that anyone ever read it. `edit` matches its `oldString` against what is on disk, which proves the string is there and nothing about whether the agent knew what else was. So two shapes get through upstream, and both destroy work:

- a whole-file `write` to a file this session never read — everything in it the agent did not know about is gone;
- an edit to a file that changed on disk *after* it was read, by a formatter, a rebase, or another tool — the agent is editing against a picture that is no longer true.

In `approve` and `strict` these ask, with the file named and the reason spelled out. In `yolo` and `auto` they run, like every other risk on the gradient. Creating a new file is never blind and never asks, and a file the agent wrote itself counts as read — otherwise writing a file and immediately editing it would be refused for not having read something the agent had just authored.

The answer to a refusal is always available: reads are cheap, and the agent is told to take one.

| Mode | Blind write / stale edit |
|---|---|
| `⚡ yolo` | runs |
| `⚙ auto` | runs |
| `🛡 approve` *(default)* | asks |
| `🔒 strict` | asks |

## Secret files

Credentials are the one thing no mode waves through — auto-approving speed is worth it, auto-approving your AWS keys into a prompt is not. Any `read`/`edit`/`write` on secret material, and any bash command that names it, asks first in every mode:

`.env` (and `.env.*`, but not `.env.example`/`.sample`/`.template`) · `~/.ssh/*` and `id_rsa`/`id_ed25519`-style keys (`.pub` halves are fine) · `.aws/credentials` · `.pi/agent/auth.json`, `.claude/.credentials.json` · `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials` · `~/.config/gh/hosts.yml` · `*.pem`, `*.key`, `*.p12`, `*.pfx` · `secrets.json`/`credentials.yaml`

A user rule opts a project out: `{ "pattern": "*/.env", "action": "allow" }`.

## Trust and retention

**`.pi/yolo.json` is only read once you have approved it.** A repository ships that file, and a user rule can *relax* the destructive tier — so a repo you just cloned could otherwise turn the guard down on its own say-so, silently, on the first command it runs.

pi's own project trust is necessary but not sufficient here. pi asks about trust only when the repository ships one of the resources **pi itself** loads — `.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `SYSTEM.md`, `APPEND_SYSTEM.md`. A repo carrying only `.pi/yolo.json` triggers no prompt, and `isProjectTrusted()` then returns true by default — measured, not assumed. So the question is this extension's to ask: once per project, remembered afterwards, refused outright in a headless run with no answer on record, and never able to override a project pi itself refused. `/yolo status` says the file was found and refused rather than pretending it does not exist. Global rules are unaffected.

For CI, set `PIFY_TRUST_PROJECT=1` — an environment variable, because the repository being read cannot set one for itself.

**The trail is kept 30 days.** Before this, nothing was ever deleted: every edit copied a whole file into the trail, and every checkpoint pinned a whole-tree stash commit under `refs/pify/yolo/*` — and git cannot reclaim an object a ref still points at, so the object store grew for the life of the machine. Pruning runs once per session and deletes the refs it releases.

## Checkpoints

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

## Rewind to before you asked

The trail's unit is the file change, and `/yolo undo 3` walks back three of them. That is right for the gate and wrong for a person: nobody thinks "undo the last four writes", they think *forget I asked that*. A turn is a dozen trail entries, and counting them is work you should not be doing.

So every prompt gets a checkpoint of its own — the working tree as it stood when you hit enter, and the session entry your message became:

```
/yolo rewind            # list the checkpoints, newest first
/yolo rewind 3          # go back to the third one
```

Picking one asks what to restore, offering only what that checkpoint can actually deliver:

- **the working tree only** — the files go back, the conversation stays;
- **the conversation only** — the session moves to just before that message, the files stay;
- **both**.

A prompt sent with a clean tree has no stash to return to, so it does not offer one; a prompt whose message left no session entry does not offer the conversation. The confirmation says which of those you are about to do and what it costs — a tree restore overwrites anything written since and uncommitted work is not recoverable afterwards, while moving the conversation deletes nothing, because the later turns stay reachable in the session tree.

Checkpoints live on the same trail as everything else, so they inherit the same 30-day retention and the same ref cleanup.

## AI classifier (opt-in)

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
/yolo strict     # or: yolo | auto | approve | strict
/yolo status     # mode, the other modes, rule count, trail size
/yolo trail      # recent trail entries
/yolo rewind     # list prompt checkpoints; /yolo rewind <n> to go back
/yolo undo 3     # restore the newest 3 file pre-images
/yolo classifier on   # let a model flag unfamiliar commands
```

## License

MIT © [Pify maintainers](https://github.com/pifydev)
