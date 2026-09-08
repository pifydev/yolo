import { test } from "node:test";
import assert from "node:assert/strict";
import { ReadLedger, assessBlindWrite, blindTitle } from "../src/reads.ts";

const disk = (size = 100, mtimeMs = 1000) => ({ size, mtimeMs });

test("creating a file is never blind", () => {
  const ledger = new ReadLedger();
  // Nothing on disk means nothing to destroy, read or not.
  assert.deepEqual(assessBlindWrite("write", "new.ts", null, ledger), { ok: true });
  assert.deepEqual(assessBlindWrite("edit", "new.ts", null, ledger), { ok: true });
});

test("overwriting a file this session never read is refused", () => {
  const ledger = new ReadLedger();
  const verdict = assessBlindWrite("write", "src/app.ts", disk(), ledger);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.kind, "never-read");
    // The reason has to say what is actually at stake.
    assert.match(verdict.reason, /replaces the whole file/);
    assert.match(verdict.reason, /would be lost/);
  }
});

test("editing an unread file is refused too, in its own words", () => {
  const ledger = new ReadLedger();
  const verdict = assessBlindWrite("edit", "src/app.ts", disk(), ledger);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.kind, "never-read");
    assert.match(verdict.reason, /has not seen/);
    // An edit does not replace the file, so it must not claim to.
    assert.ok(!verdict.reason.includes("whole file"));
  }
});

test("a file read this session, unchanged since, passes", () => {
  const ledger = new ReadLedger();
  ledger.note("src/app.ts", disk());
  assert.deepEqual(assessBlindWrite("write", "src/app.ts", disk(), ledger), { ok: true });
  assert.deepEqual(assessBlindWrite("edit", "src/app.ts", disk(), ledger), { ok: true });
});

test("a file that changed after it was read is stale, not unread", () => {
  const ledger = new ReadLedger();
  ledger.note("src/app.ts", disk(100, 1000));

  // A formatter rewrote it: same length, different time.
  const touched = assessBlindWrite("edit", "src/app.ts", disk(100, 2000), ledger);
  assert.equal(touched.ok, false);
  if (!touched.ok) {
    assert.equal(touched.kind, "stale");
    assert.match(touched.reason, /changed on disk/);
    assert.match(touched.reason, /reading it again/);
  }

  // Something appended to it: same time, different length.
  const grown = assessBlindWrite("edit", "src/app.ts", disk(140, 1000), ledger);
  assert.equal(grown.ok === false && grown.kind, "stale");
});

test("the path key survives separator, case and trailing-slash differences", () => {
  const ledger = new ReadLedger();
  ledger.note("D:\\Repo\\Src\\App.ts", disk());
  assert.deepEqual(assessBlindWrite("edit", "D:/repo/src/app.ts", disk(), ledger), { ok: true });
});

test("a write that created a file registers as having seen it", () => {
  // Otherwise writing a new file and immediately editing it would be refused
  // for not having read a file the agent just authored.
  const ledger = new ReadLedger();
  assert.deepEqual(assessBlindWrite("write", "fresh.ts", null, ledger), { ok: true });
  ledger.note("fresh.ts", disk(50, 500));
  assert.deepEqual(assessBlindWrite("edit", "fresh.ts", disk(50, 500), ledger), { ok: true });
});

test("forgetting a path makes the next write blind again", () => {
  const ledger = new ReadLedger();
  ledger.note("a.ts", disk());
  assert.equal(ledger.size, 1);
  ledger.forget("a.ts");
  assert.equal(ledger.size, 0);
  assert.equal(assessBlindWrite("write", "a.ts", disk(), ledger).ok, false);
});

test("the dialog title names which of the two problems it is", () => {
  assert.match(blindTitle("never-read"), /unread/i);
  assert.match(blindTitle("stale"), /changed/i);
});
