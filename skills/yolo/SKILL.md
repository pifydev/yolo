---
name: yolo
description: Use when a bash command gets blocked or needs confirmation by the yolo guard, or when the user asks about undoing recent changes
---

# YOLO guard & undo trail

This project has the `@pify/yolo` extension installed: a three-tier bash
safety gate plus an always-on undo trail of file pre-images.

## When your command is blocked or denied

- A BLOCK (catastrophic tier: `rm -rf /`, mkfs, device writes…) is final —
  never retry or rephrase to evade it; choose a fundamentally safer
  approach and tell the user why.
- An ASK denial may include the user's reason — treat it as a course
  correction, not an obstacle. Adjust the plan accordingly.
- Do not suggest the user enable yolo mode to bypass a block.

## The undo trail

- Every edit/write saves the file's pre-image first, in both modes. If the
  user asks to revert recent changes, point them to `/yolo undo [n]`
  (or restore specific files yourself from the visible trail).
- Bash effects are logged but NOT undoable — before a risky-but-approved
  command, mention what it will destroy if that's not obvious.

## Modes

- guard (default): catastrophic → block, destructive → confirm, rest runs.
- yolo (`/yolo`): everything auto-approves; the trail keeps recording.
  The user toggles this — never you.
