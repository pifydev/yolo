import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PROMPT_CHARS,
  clipPrompt,
  formatRewindList,
  parseRewindArgs,
  restoreChoices,
  restoreSummary,
  rewindPoints,
} from "../src/rewind.ts";
import type { TrailEntry } from "../src/types.ts";

const entry = (over: Partial<TrailEntry> & { seq: number }): TrailEntry => ({
  timestamp: 1_700_000_000_000 + over.seq * 1000,
  type: "prompt",
  target: `prompt ${over.seq}`,
  saved: null,
  existed: false,
  ...over,
});

test("only prompts are checkpoints, newest first", () => {
  const points = rewindPoints([
    entry({ seq: 1, entryId: "e1", stashSha: "aaa1111" }),
    { ...entry({ seq: 2 }), type: "file", target: "src/a.ts" },
    { ...entry({ seq: 3 }), type: "bash", target: "rm -rf x" },
    entry({ seq: 4, entryId: "e4", stashSha: "bbb2222" }),
  ]);
  assert.equal(points.length, 2);
  assert.equal(points[0]!.seq, 4, "newest first is how you will pick them");
  assert.equal(points[1]!.seq, 1);
  assert.equal(points[0]!.entryId, "e4");
  assert.equal(points[0]!.stashSha, "bbb2222");
});

test("missing halves come back as null, not undefined or empty string", () => {
  const [point] = rewindPoints([entry({ seq: 1, entryId: "", stashSha: undefined })]);
  assert.equal(point!.entryId, null);
  assert.equal(point!.stashSha, null);
  assert.equal(point!.gitHead, null);
});

test("a checkpoint only offers what it can actually deliver", () => {
  const full = rewindPoints([entry({ seq: 1, entryId: "e1", stashSha: "sha" })])[0]!;
  assert.deepEqual(restoreChoices(full), ["code", "conversation", "both"]);

  // A prompt sent with a clean tree has no stash to come back to.
  const noTree = rewindPoints([entry({ seq: 1, entryId: "e1" })])[0]!;
  assert.deepEqual(restoreChoices(noTree), ["conversation"]);

  const noEntry = rewindPoints([entry({ seq: 1, stashSha: "sha" })])[0]!;
  assert.deepEqual(restoreChoices(noEntry), ["code"]);

  // Nothing to offer at all, so the caller must not show an empty menu.
  const neither = rewindPoints([entry({ seq: 1 })])[0]!;
  assert.deepEqual(restoreChoices(neither), []);
});

test("the confirmation says what is unrecoverable before anything is touched", () => {
  const point = rewindPoints([entry({ seq: 1, entryId: "e1", stashSha: "abcdef1234" })])[0]!;

  const code = restoreSummary(point, "code");
  assert.match(code, /abcdef12/, "names the commit it is restoring from");
  assert.match(code, /overwritten/);
  assert.match(code, /not recoverable/);
  assert.ok(!code.includes("session moves back"), "a code-only rewind must not claim to move the conversation");

  const talk = restoreSummary(point, "conversation");
  assert.match(talk, /session moves back/);
  // Navigating the tree does not delete anything, and saying otherwise would
  // scare people out of using it.
  assert.match(talk, /reachable, not deleted/);
  assert.ok(!talk.includes("overwritten"));

  const both = restoreSummary(point, "both");
  assert.match(both, /overwritten/);
  assert.match(both, /session moves back/);
});

test("argument parsing: bare lists, a number picks, anything else explains", () => {
  assert.deepEqual(parseRewindArgs(""), { kind: "list" });
  assert.deepEqual(parseRewindArgs("   "), { kind: "list" });
  assert.deepEqual(parseRewindArgs(" 3 "), { kind: "pick", index: 3 });
  assert.equal(parseRewindArgs("0").kind, "error");
  assert.equal(parseRewindArgs("-1").kind, "error");
  assert.equal(parseRewindArgs("last").kind, "error");
  assert.match((parseRewindArgs("last") as { message: string }).message, /Usage/);
});

test("the list says what each checkpoint can restore", () => {
  const points = rewindPoints([
    entry({ seq: 1, target: "fix the parser", entryId: "e1", stashSha: "sha" }),
    entry({ seq: 2, target: "just a question", entryId: "e2" }),
    entry({ seq: 3, target: "nothing recorded" }),
  ]);
  const text = formatRewindList(points, 15);
  assert.match(text, /3 checkpoint\(s\), newest first/);
  assert.match(text, /1\. .*nothing recorded/);
  assert.match(text, /can restore: code \+ conversation/);
  assert.match(text, /can restore: conversation/);
  assert.match(text, /nothing — no tree change/);
  assert.match(text, /\/yolo rewind <n>/);
});

test("an empty list explains itself rather than printing nothing", () => {
  const text = formatRewindList([], 15);
  assert.match(text, /No prompts recorded yet/);
  assert.match(text, /each time you send one/);
});

test("a prompt is identified by its first real line, clipped", () => {
  assert.equal(clipPrompt("fix the parser"), "fix the parser");
  // Leading blank lines are not what you typed.
  assert.equal(clipPrompt("\n\n  fix the parser  \nand more"), "fix the parser");
  const long = "x".repeat(MAX_PROMPT_CHARS + 40);
  const clipped = clipPrompt(long);
  assert.equal(clipped.length, MAX_PROMPT_CHARS);
  assert.ok(clipped.endsWith("…"));
  assert.equal(clipPrompt("   \n  "), "");
});
