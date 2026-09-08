/**
 * Editing a file nobody looked at.
 *
 * pi's `write` tool overwrites a file whole, with no requirement that anyone
 * ever read it; `edit` matches its `oldString` against the file on disk, which
 * proves the string is there and nothing about whether the agent knew what
 * else was. So the two shapes this catches are real and neither is covered
 * upstream:
 *
 *   - a whole-file `write` to a file this session never read, which throws
 *     away everything the agent did not know was in it;
 *   - an edit to a file that changed on disk since it *was* read — by a
 *     formatter, a rebase, another tool — where the agent is editing against
 *     a picture that is no longer true.
 *
 * Reads are cheap and the agent can always take one. What this refuses is
 * writing blind, which is the one mistake a confirmation cannot be undone
 * into.
 *
 * Pure: the caller supplies what it saw on disk.
 */

/** What a file looked like the last time this session read it. */
export interface ReadRecord {
  size: number;
  mtimeMs: number;
}

/** What the file looks like right now, or null when it does not exist. */
export type OnDisk = { size: number; mtimeMs: number } | null;

export type BlindVerdict =
  | { ok: true }
  | { ok: false; kind: "never-read" | "stale"; reason: string };

export class ReadLedger {
  private seen = new Map<string, ReadRecord>();

  private key(path: string): string {
    return path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  }

  /** Record what a `read` — or a `write` that created the file — saw. */
  note(path: string, record: ReadRecord): void {
    this.seen.set(this.key(path), record);
  }

  read(path: string): ReadRecord | undefined {
    return this.seen.get(this.key(path));
  }

  forget(path: string): void {
    this.seen.delete(this.key(path));
  }

  get size(): number {
    return this.seen.size;
  }
}

/**
 * Judge a `write` or `edit` before it happens.
 *
 * A file that does not exist yet cannot be overwritten, so creating one is
 * never blind. Everything else needs a read this session, and that read has to
 * still describe the file.
 */
export function assessBlindWrite(
  tool: "write" | "edit",
  path: string,
  onDisk: OnDisk,
  ledger: ReadLedger,
): BlindVerdict {
  // Creating a new file destroys nothing.
  if (onDisk === null) return { ok: true };

  const record = ledger.read(path);
  if (!record) {
    return {
      ok: false,
      kind: "never-read",
      reason:
        tool === "write"
          ? `${path} already exists and this session has not read it. A write replaces the whole file, so everything currently in it that the agent does not know about would be lost.`
          : `${path} has not been read in this session, so the agent is editing a file it has not seen.`,
    };
  }

  if (record.mtimeMs !== onDisk.mtimeMs || record.size !== onDisk.size) {
    return {
      ok: false,
      kind: "stale",
      reason:
        `${path} changed on disk after this session read it — a formatter, another tool, or something outside pi. ` +
        "The agent is working from a picture that is no longer true; reading it again would settle it.",
    };
  }

  return { ok: true };
}

/** One line for the confirmation dialog's title. */
export function blindTitle(kind: "never-read" | "stale"): string {
  return kind === "never-read" ? "Write to an unread file" : "File changed since it was read";
}
