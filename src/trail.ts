import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { TrailEntry } from "./types.ts";

/**
 * The undo trail: before every edit/write the file's pre-image is saved, and
 * risky bash commands are logged with their context. One rolling trail per
 * project (keyed by cwd hash) under the agent dir — surviving sessions, so
 * "undo what just happened" works even after a restart.
 */

export function trailDir(agentDir: string, cwd: string): string {
  const key = createHash("sha256").update(cwd.toLowerCase()).digest("hex").slice(0, 12);
  return join(agentDir, "yolo-trail", key);
}

function manifestPath(dir: string): string {
  return join(dir, "manifest.jsonl");
}

export function readManifest(dir: string): TrailEntry[] {
  try {
    return readFileSync(manifestPath(dir), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as TrailEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is TrailEntry => e !== null && typeof e.seq === "number");
  } catch {
    return [];
  }
}

function nextSeq(dir: string): number {
  const entries = readManifest(dir);
  return entries.length === 0 ? 1 : Math.max(...entries.map((e) => e.seq)) + 1;
}

function append(dir: string, entry: TrailEntry): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(manifestPath(dir), `${JSON.stringify(entry)}\n`);
}

/** Save a file's pre-image before it is modified. Never throws. */
export function recordPreImage(dir: string, filePath: string, now: number): TrailEntry | null {
  try {
    const seq = nextSeq(dir);
    const existed = existsSync(filePath);
    let saved: string | null = null;
    if (existed) {
      saved = `${seq}-${basename(filePath).slice(0, 80)}`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, saved), readFileSync(filePath));
    }
    const entry: TrailEntry = { seq, timestamp: now, type: "file", target: filePath, saved, existed };
    append(dir, entry);
    return entry;
  } catch {
    return null;
  }
}

/** Log a risky/mutating bash command. Never throws. */
export function recordBash(
  dir: string,
  command: string,
  cwd: string,
  gitHead: string | null,
  now: number,
): void {
  try {
    append(dir, {
      seq: nextSeq(dir),
      timestamp: now,
      type: "bash",
      target: command.slice(0, 500),
      saved: null,
      existed: false,
      cwd,
      ...(gitHead ? { gitHead } : {}),
    });
  } catch {
    // trail must never break the tool call
  }
}

export interface UndoResult {
  restored: string[];
  deleted: string[];
  skipped: string[];
}

/**
 * Restore the newest `count` file pre-images (newest first). Files that did
 * not exist before their change are deleted. Bash entries cannot be undone
 * and are skipped. Returns what happened for reporting.
 */
export function undo(dir: string, count: number): UndoResult {
  const result: UndoResult = { restored: [], deleted: [], skipped: [] };
  const entries = readManifest(dir)
    .filter((e) => e.type === "file")
    .sort((a, b) => b.seq - a.seq)
    .slice(0, count);

  for (const entry of entries) {
    try {
      if (entry.existed && entry.saved) {
        writeFileSync(entry.target, readFileSync(join(dir, entry.saved)));
        result.restored.push(entry.target);
      } else if (!entry.existed && existsSync(entry.target)) {
        unlinkSync(entry.target);
        result.deleted.push(entry.target);
      } else {
        result.skipped.push(entry.target);
      }
    } catch {
      result.skipped.push(entry.target);
    }
  }
  return result;
}

export function formatTrail(entries: TrailEntry[], limit: number): string {
  if (entries.length === 0) return "Trail is empty.";
  const recent = entries.slice(-limit).reverse();
  return recent
    .map((e) => {
      const when = new Date(e.timestamp).toISOString().replace("T", " ").slice(0, 19);
      if (e.type === "file") {
        return `#${e.seq} ${when} file  ${e.target}${e.existed ? "" : " (new file)"}`;
      }
      return `#${e.seq} ${when} bash  ${e.target}${e.gitHead ? ` @${e.gitHead.slice(0, 8)}` : ""}`;
    })
    .join("\n");
}
