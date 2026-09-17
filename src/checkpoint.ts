/**
 * Deciding what a `git stash create` told us.
 *
 * `git stash create` prints a dangling-commit sha when the tracked tree is
 * dirty, and nothing when it is clean — but "nothing" also comes back when the
 * command FAILED (a held index.lock, a timeout on a large repo, not a repo at
 * all). A clean tree is safe to rewind to via HEAD; a failed checkpoint is not
 * — the tree may be dirty with no snapshot, and restoring to HEAD would then
 * destroy uncommitted work the confirmation promised was captured. So empty
 * output is only trusted as "clean" once git separately confirms the tracked
 * tree has nothing to save.
 *
 * Pure: the caller supplies a `runGit` that runs git and returns stdout (and
 * throws on a non-zero exit), so this decision is testable without a repo.
 */

export type CheckpointResult =
  /** A snapshot commit was created; rewind restores from this sha. */
  | { sha: string }
  /** The tracked tree was clean; rewind restores from HEAD. */
  | { clean: true }
  /** `git stash create` failed or its output was unreadable; take no chances. */
  | { failed: true };

const SHA = /^[0-9a-f]{7,40}$/;

export function decideCheckpoint(runGit: (args: string[]) => string): CheckpointResult {
  let out: string;
  try {
    out = runGit(["stash", "create"]).trim();
  } catch {
    return { failed: true };
  }
  if (SHA.test(out)) return { sha: out };
  // Non-empty but not a sha is output we cannot act on — do not call it clean.
  if (out !== "") return { failed: true };
  // Empty: clean tree or a silent failure. Only "clean" if git agrees.
  try {
    const status = runGit(["status", "--porcelain", "--untracked-files=no"]).trim();
    return status === "" ? { clean: true } : { failed: true };
  } catch {
    return { failed: true };
  }
}

/** The stash sha, or null for a clean/failed checkpoint. */
export function checkpointSha(result: CheckpointResult): string | null {
  return "sha" in result ? result.sha : null;
}
