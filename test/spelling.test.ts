/**
 * The same thing, spelled differently. Every gate here matches a string; the
 * tool that runs it resolves a path, expands an alias or joins an option and
 * its value — and each of those is a spelling the string never saw. These are
 * the ones the 2026-09-16 review found still open.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import yolo from "../extensions/yolo.ts";
import { evaluateCommand, evaluatePath, secretPathKind, secretPathsIn } from "../src/rules.ts";
import { StubHost } from "./host.ts";

const verdict = (command: string) => evaluateCommand(command).action;

test("a secret path is judged as the tool resolves it, not as the agent spelled it", () => {
  // pi strips a leading `@`; path.resolve drops a trailing slash and folds
  // `./` and `a/../` — all of these opened .env unasked.
  for (const spelling of [
    "@.env",
    ".env/",
    ".env\\",
    "./.env",
    "x/../.env",
    ".env/.",
    "'@.env'",
    "@~/.ssh/id_rsa/",
    "C:\\repo\\.aws\\credentials\\",
  ]) {
    assert.ok(secretPathKind(spelling), spelling);
    assert.equal(evaluatePath(spelling).action, "ask", spelling);
  }
  // Folding must not invent a secret: these resolve to something else.
  assert.equal(secretPathKind(".env/.."), null);
  assert.equal(secretPathKind("x/.env/.."), null);
  assert.equal(secretPathKind(".env.example/"), null);
  assert.equal(secretPathKind("/"), null);
  // Command tokens get the same treatment.
  assert.deepEqual(secretPathsIn("cat @.env"), ["env-file"]);
});

test("formatting a drive by any other name is catastrophic", () => {
  for (const command of [
    "format.com D:",
    "format.exe /q E:",
    "C:\\Windows\\System32\\format.com D:",
    "& 'C:\\Windows\\System32\\format.com' D:",
    "format 'D:'",
    "Format-Volume -DriveLetter D -FileSystem NTFS",
    "Clear-Disk -Number 0 -RemoveData -Confirm:$false",
    "Initialize-Disk -Number 1",
    "diskpart /s wipe.txt",
  ]) {
    assert.equal(verdict(command), "block", command);
  }
  // The flag, and formatting that is not a drive, are still not the verb.
  assert.notEqual(verdict("git log --format=%H C:\\repo"), "block");
  assert.notEqual(verdict("ls --format=long C:\\"), "block");
  assert.notEqual(verdict("cargo fmt --check"), "block");
});

test("a drive root is a root however cmd or PowerShell spells it", () => {
  for (const command of [
    "del /s /q C:\\*.*",
    "Remove-Item -Recurse -Force C:\\.",
    "Remove-Item -Recurse -Force C:\\..",
    "Remove-Item -Path:C:\\ -Recurse",
    "Remove-Item -LiteralPath:'C:\\' -Rec",
    "Remove-Item -p:C:\\ -Recurse:$true",
  ]) {
    assert.equal(verdict(command), "block", command);
  }
  // A root spelled as a value of some other option names no target.
  assert.equal(verdict("Remove-Item -Exclude:C:\\ -Recurse x"), "ask");
});

function boot(opts: { cwd: string; hasUI?: boolean; confirm?: boolean }): StubHost {
  const host = new StubHost(opts);
  yolo(host.api as unknown as ExtensionAPI);
  return host;
}

test("grep: a yes to the secret-file question is honoured by the result", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pify-yolo-spell-"));
  try {
    const host = boot({ cwd, hasUI: true, confirm: true });
    assert.equal(await host.toolCall("grep", { pattern: "=", path: ".env" }), undefined);
    assert.equal(host.confirms.length, 1);
    // The file the user approved comes back whole — not withheld with
    // advice to go and be asked.
    assert.equal(await host.toolResult("grep", { pattern: "=", path: ".env" }, ".env:1: A=1\n.env:2: B=2"), undefined);
    // That yes was for one call. A later directory walk reaching the same
    // file was never asked about, and is withheld as before.
    const walk = await host.toolResult("grep", { pattern: "=", path: "." }, "src/a.ts:1: x\n.env:1: A=1");
    assert.match(walk?.content?.[0]?.text ?? "", /^src\/a\.ts:1: x\n\[yolo\] 1 matching line in \.env withheld/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("grep: the misspelt secret path is asked about too", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pify-yolo-spell-"));
  try {
    const host = boot({ cwd });
    for (const path of ["@.env", ".env/", "./.env"]) {
      const denied = await host.toolCall("grep", { pattern: "=", path });
      assert.equal(denied?.block, true, path);
    }
    for (const path of ["@.env", ".env/"]) {
      const denied = await host.toolCall("read", { path });
      assert.equal(denied?.block, true, path);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
