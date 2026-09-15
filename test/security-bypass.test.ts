import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCommand, parseUserRules } from "../src/rules.ts";
import { unwrapCommand } from "../src/unwrap.ts";

const verdict = (command: string, rules = parseUserRules({ rules: [] })) =>
  evaluateCommand(command, rules).action;

test("catastrophic rm floor: GNU long flags, `--`, //, /., /.., $'/', drive roots", () => {
  // Every one of these auto-ran (rated merely ASK, which yolo/auto approve)
  // because the anchored regexes only recognised short flags and a bare `/`.
  for (const command of [
    "rm --recursive --force /",
    "rm -rf -- /",
    "rm -rf --no-preserve-root /",
    "rm -rf //",
    "rm -rf /.",
    "rm -rf /..",
    "rm -rf /*",
    "rm -rf $'/'",
    "rm -rf C:/",
    "rm -rf C:\\",
    "rm -rf C:",
    "rm --recursive ~",
    "rm --recursive --force $HOME",
    "rm -R --force ${HOME}",
  ]) {
    assert.equal(verdict(command), "block", command);
  }
});

test("catastrophic rm floor survives wrappers too", () => {
  for (const command of [
    "sudo rm -rf -- /",
    "bash -c 'rm --recursive --force /'",
    "cmd /c rm -rf /",
    "pwsh -c 'rm -rf /'",
    "echo done && rm -rf //",
  ]) {
    assert.equal(verdict(command), "block", command);
  }
});

test("the supplement never blocks a deep path — only true roots", () => {
  // Erring toward BLOCK must not swallow ordinary recursive deletes; these
  // stay in the destructive (ASK) tier.
  for (const command of [
    "rm -rf build",
    "rm -rf /tmp",
    "rm -rf /home/x/tmp",
    "rm -rf ~/Documents",
    "rm --recursive node_modules",
    "rm -rf ./project/dist",
  ]) {
    assert.equal(verdict(command), "ask", command);
  }
});

test("even user rules cannot override the rm-root supplement", () => {
  const rules = parseUserRules({ rules: [{ pattern: "*", action: "allow" }] });
  assert.equal(verdict("rm --recursive --force /", rules), "block");
  assert.equal(verdict("rm -rf C:\\", rules), "block");
});

test("Windows destructive shapes ask", () => {
  for (const command of [
    "rmdir /s /q C:\\temp",
    "rmdir /S C:\\build",
    "rd /s folder",
    "rd /S /Q C:\\Windows\\Temp",
    "del /f /s /q C:\\temp\\*",
    "del /s *.tmp",
    "del /F /S /Q logs",
    "Remove-Item -Recurse -Force C:\\temp",
    "Remove-Item -r ./build",
    "remove-item -Recurse dist",
  ]) {
    assert.equal(verdict(command), "ask", command);
  }
});

test("formatting a drive is catastrophic", () => {
  for (const command of ["format C:", "format /q D:", "format /FS:NTFS /Q E:"]) {
    assert.equal(verdict(command), "block", command);
  }
  // `--format` and friends of other tools are not the disk formatter.
  assert.equal(verdict("docker ps --format '{{.Names}}'"), "allow");
  assert.equal(verdict("git log --pretty=format:%H"), "allow");
});

test("cmd /c and powershell -Command are wrappers, and the tiers apply inside", () => {
  assert.equal(verdict('cmd /c "rmdir /s /q C:\\temp"'), "ask");
  assert.equal(verdict("cmd /c del /f /s /q C:\\x"), "ask");
  assert.equal(verdict('cmd /s /c "rm -rf /"'), "block");
  assert.equal(verdict('powershell -Command "Remove-Item -Recurse -Force C:\\temp"'), "ask");
  assert.equal(verdict('powershell -NoProfile -Command "format C:"'), "block");
  assert.equal(verdict("pwsh -c 'Remove-Item -r ./dist'"), "ask");
  // The wrappers surface the inner command as an unwrapped form.
  assert.ok(unwrapCommand('cmd /c "rmdir /s /q C:\\temp"').includes("rmdir /s /q C:\\temp"));
  assert.ok(
    unwrapCommand('powershell -NoProfile -Command "format C:"').includes("format C:"),
  );
  // Ordinary Windows-shell payloads still pass.
  assert.equal(verdict('cmd /c "echo hello"'), "allow");
  assert.equal(verdict('powershell -Command "Get-ChildItem"'), "allow");
});

test("a wrapper cannot void a block/ask user rule", () => {
  const block = parseUserRules({ rules: [{ pattern: "npm run deploy*", action: "block" }] });
  assert.equal(verdict("npm run deploy", block), "block");
  assert.equal(verdict("sudo npm run deploy", block), "block");
  assert.equal(verdict("bash -c 'npm run deploy'", block), "block");
  assert.equal(verdict("sudo bash -c 'npm run deploy production'", block), "block");

  const ask = parseUserRules({ rules: [{ pattern: "npm run deploy*", action: "ask" }] });
  assert.equal(verdict("sudo npm run deploy", ask), "ask");
  assert.equal(verdict("bash -c 'npm run deploy'", ask), "ask");
});

test("an ALLOW user rule only relaxes the command as written, never via a wrapper", () => {
  // The conservative asymmetry: an allow that matches only the unwrapped form
  // must NOT relax a verdict the wrapper was hiding.
  const allow = parseUserRules({ rules: [{ pattern: "rm -rf build*", action: "allow" }] });
  assert.equal(verdict("rm -rf build", allow), "allow"); // matches the original → relaxes
  assert.equal(verdict("sudo rm -rf build", allow), "ask"); // only the hidden form matches → stays
});

test("most restrictive wins: a hidden block beats an original-text allow", () => {
  const rules = parseUserRules({
    rules: [
      { pattern: "*", action: "allow" },
      { pattern: "npm run deploy*", action: "block" },
    ],
  });
  assert.equal(verdict("sudo npm run deploy", rules), "block");
});
