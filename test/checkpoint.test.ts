/**
 * decideCheckpoint (f190): a clean tree is safe to rewind to via HEAD, but a
 * FAILED `git stash create` — index.lock, a timeout — also prints nothing, and
 * treating that as clean would let a rewind wipe uncommitted work. The decision
 * is driven through a stubbed git runner so both look-alikes are pinned down.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkpointSha, decideCheckpoint } from "../src/checkpoint.ts";

test("f190 a dirty tree yields the stash sha", () => {
  const result = decideCheckpoint((args) => (args[0] === "stash" ? "abc123def4560\n" : ""));
  assert.deepEqual(result, { sha: "abc123def4560" });
  assert.equal(checkpointSha(result), "abc123def4560");
});

test("f190 a clean tree (empty stash, empty status) is clean, restorable via HEAD", () => {
  const result = decideCheckpoint(() => "");
  assert.deepEqual(result, { clean: true });
  assert.equal(checkpointSha(result), null);
});

test("f190 a failed stash create is never treated as clean", () => {
  // Throwing (non-zero exit) on the stash create.
  const threw = decideCheckpoint((args) => {
    if (args[0] === "stash") throw new Error("index.lock held");
    return "";
  });
  assert.deepEqual(threw, { failed: true });

  // Empty stash but a DIRTY status — a silent failure, not a clean tree.
  const dirtyNoStash = decideCheckpoint((args) => (args[0] === "stash" ? "" : " M src/app.ts"));
  assert.deepEqual(dirtyNoStash, { failed: true });

  // Unreadable stash output (not a sha) is also not clean.
  const garbage = decideCheckpoint((args) => (args[0] === "stash" ? "not-a-sha" : ""));
  assert.deepEqual(garbage, { failed: true });
});
