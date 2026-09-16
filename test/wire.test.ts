/**
 * The extension's own wiring, driven through a stub host.
 *
 * Every rule in src/ was right about `Remove-Item -Recurse -Force C:\`, and
 * the gate never asked them: it returned early on any toolName that was not
 * "bash", and pi 0.85 ships a first-class `powershell` tool with the same
 * {command} input. These tests exercise the hook, not the helpers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import yolo from "../extensions/yolo.ts";
import { formatTrail, readManifest, trailDir } from "../src/trail.ts";
import { StubHost } from "./host.ts";

function boot(opts: { cwd: string; hasUI?: boolean; confirm?: boolean }): StubHost {
  const host = new StubHost(opts);
  yolo(host.api as unknown as ExtensionAPI);
  return host;
}

test("powershell: a catastrophic command is blocked, even in yolo mode", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pify-yolo-wire-"));
  try {
    const host = boot({ cwd });
    await host.run("yolo", "yolo");
    for (const command of ["Remove-Item -Recurse -Force C:\\", "format D:", "ri -Recurse -Force C:\\"]) {
      const result = await host.toolCall("powershell", { command });
      assert.equal(result?.block, true, command);
      assert.match(result?.reason ?? "", /catastrophic patterns are never auto-approved/, command);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("powershell: a benign command runs in yolo mode, a destructive one asks in approve mode", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pify-yolo-wire-"));
  try {
    const host = boot({ cwd });
    await host.run("yolo", "yolo");
    assert.equal(await host.toolCall("powershell", { command: "Get-ChildItem -Recurse src" }), undefined);
    assert.equal(await host.toolCall("powershell", { command: "git status" }), undefined);

    await host.run("yolo", "approve");
    // Headless: the ASK tier is a fail-closed deny, same as bash.
    const denied = await host.toolCall("powershell", { command: "Remove-Item -Recurse -Force .\\build" });
    assert.equal(denied?.block, true);
    assert.match(denied?.reason ?? "", /win-remove-item/);
    assert.match(denied?.reason ?? "", /no UI is available/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("powershell: a call without a command fails closed, and names the tool", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pify-yolo-wire-"));
  try {
    const host = boot({ cwd });
    const ps = await host.toolCall("powershell", {});
    assert.equal(ps?.block, true);
    assert.match(ps?.reason ?? "", /powershell call without a command/);
    const bash = await host.toolCall("bash", {});
    assert.match(bash?.reason ?? "", /bash call without a command/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("powershell: the trail entry names the shell, so /yolo trail says powershell", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pify-yolo-wire-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pify-yolo-agent-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const host = boot({ cwd });
    await host.fire("session_start", { type: "session_start", reason: "startup" });
    await host.run("yolo", "yolo");
    await host.toolCall("powershell", { command: "Remove-Item -Recurse -Force .\\dist" });
    await host.toolCall("bash", { command: "rm -rf build" });

    const entries = readManifest(trailDir(agentDir, cwd));
    const shells = entries.filter((e) => e.type === "bash");
    assert.equal(shells.length, 2);
    assert.equal(shells[0]!.tool, "powershell");
    assert.equal(shells[1]!.tool, "bash");
    const text = formatTrail(entries, 10);
    assert.match(text, /powershell\s+Remove-Item -Recurse -Force \.\\dist/);
    assert.match(text, /bash\s+rm -rf build/);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("grep: a secret search path is gated like a read, in every mode", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pify-yolo-wire-"));
  try {
    const host = boot({ cwd });
    for (const mode of ["yolo", "auto", "approve", "strict"]) {
      await host.run("yolo", mode);
      const denied = await host.toolCall("grep", { pattern: "=", path: ".env" });
      assert.equal(denied?.block, true, mode);
      assert.match(denied?.reason ?? "", /secret material \(secret:env-file\)/, mode);
      const aws = await host.toolCall("grep", { pattern: "key", path: join(cwd, ".aws", "credentials") });
      assert.equal(aws?.block, true, mode);
    }
    // An ordinary directory or no path at all is not a secret.
    assert.equal(await host.toolCall("grep", { pattern: "=", path: "src" }), undefined);
    assert.equal(await host.toolCall("grep", { pattern: "=" }), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("grep: with a UI the secret search path asks, and a yes lets it through", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pify-yolo-wire-"));
  try {
    const host = boot({ cwd, hasUI: true, confirm: true });
    assert.equal(await host.toolCall("grep", { pattern: "=", path: ".env" }), undefined);
    assert.equal(host.confirms.length, 1);
    assert.equal(host.confirms[0]!.title, "Secret file");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("grep: matching lines from secret files are withheld from the result", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pify-yolo-wire-"));
  try {
    const host = boot({ cwd });
    const text = [
      "src/config.ts:3: const url = process.env.DATABASE_URL;",
      ".env:1: DATABASE_URL=postgres://user:hunter2@db/prod",
      ".env:2: AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG",
    ].join("\n");
    const result = await host.toolResult("grep", { pattern: "=", path: "." }, text);
    const out = result?.content?.[0]?.text ?? "";
    assert.ok(!out.includes("hunter2"));
    assert.ok(out.includes("src/config.ts:3: const url = process.env.DATABASE_URL;"));
    assert.ok(out.includes("[yolo] 2 matching lines in .env withheld: secret material — use read on it to be asked"));

    // A search rooted at home that walks into ~/.aws/credentials.
    const home = [
      ".profile:1: export PATH=$HOME/bin:$PATH",
      ".aws/credentials:2: aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ].join("\n");
    const homeResult = await host.toolResult("grep", { pattern: "=", path: cwd }, home);
    const homeOut = homeResult?.content?.[0]?.text ?? "";
    assert.ok(!homeOut.includes("bPxRfiCYEXAMPLEKEY"));
    assert.ok(homeOut.includes(".profile:1: export PATH=$HOME/bin:$PATH"));
    assert.ok(homeOut.includes("[yolo] 1 matching line in .aws/credentials withheld"));

    // Nothing secret: the hook stays out of the way and returns nothing.
    assert.equal(await host.toolResult("grep", { pattern: "x" }, "src/a.ts:1: x"), undefined);
    // A failed grep has no content worth scanning.
    assert.equal(await host.toolResult("grep", { pattern: "x", path: "." }, ".env:1: X=1", true), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("grep: a user rule that opts a project's .env out also stops the withholding", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pify-yolo-wire-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pify-yolo-agent-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "yolo.json"), JSON.stringify({ rules: [{ pattern: "*/.env", action: "allow" }] }));
    const host = boot({ cwd });
    process.env.PIFY_TRUST_PROJECT = "1";
    try {
      await host.fire("session_start", { type: "session_start", reason: "startup" });
    } finally {
      delete process.env.PIFY_TRUST_PROJECT;
    }
    assert.equal(await host.toolCall("grep", { pattern: "=", path: join(cwd, ".env") }), undefined);
    const result = await host.toolResult("grep", { pattern: "=", path: "." }, ".env:1: X=1");
    assert.equal(result, undefined);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
