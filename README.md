# @pify/yolo

One toggle to auto-approve everything in [pi](https://github.com/earendil-works/pi) — with an undo trail so YOLO never means unrecoverable.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install yolo`](https://github.com/pifydev/cli) or `pi install npm:@pify/yolo`.

## Two modes, one toggle

**🛡 guard** (default) — every bash call runs through a three-tier gate:

| Tier | Examples | Behavior |
|---|---|---|
| **BLOCK** | `rm -rf /`, `rm -rf ~`, `rm -rf .git`, `mkfs`, `dd of=/dev/…`, fork bomb, `> /dev/sda` | Refused outright. Never overridable — not even by user rules. |
| **ASK** | `rm -rf <path>`, `git push --force`, `git reset --hard`, `git clean -f`, `curl \| sh`, `find -delete`, `chmod 777`, history rewrites | Confirmation dialog with the command shown. Denials can carry your reason back to the agent. |
| ALLOW | everything else | Runs untouched. |

**⚡ yolo** (`/yolo`) — the gate stands down and everything auto-approves. The trail keeps recording.

Fail-closed everywhere: rule-evaluation errors block; ASK without a UI (headless/CI) denies.

## Secret files (v0.2)

Credentials are the one thing yolo mode does **not** wave through — auto-approving speed is worth it, auto-approving your AWS keys into a prompt is not. Any `read`/`edit`/`write` on secret material, and any bash command that names it, asks first in both modes:

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

Always on, in both modes:

- Every `edit`/`write` saves the file's **pre-image** first (per-project trail under the agent dir — survives restarts).
- Risky bash commands are logged with cwd, timestamp, and git HEAD.
- `/yolo trail` shows history; `/yolo undo [n]` restores the newest n file changes (with a confirmation listing exactly what will be touched). Files that didn't exist before are deleted; bash effects are logged but not undoable.

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
/yolo            # toggle guard ↔ yolo
/yolo status     # mode, rule count, trail size
/yolo trail      # recent trail entries
/yolo undo 3     # restore the newest 3 file pre-images
```

## License

MIT © [Pify maintainers](https://github.com/pifydev)
