/**
 * Child-agent delegations (f196). Children spawned by agent_run/swarm_run/
 * workflow run with noExtensions:true, so yolo's gate never fires inside them.
 * The parent gates the SPAWN instead: a provably read-only delegation
 * (scout/reviewer, no isolation) is left alone; anything that could mutate is
 * checkpointed, and in approve/strict confirmed first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import yolo from "../extensions/yolo.ts";
import { classifyDelegation, delegationTarget, isDelegationTool } from "../src/delegation.ts";
import { readManifest, trailDir } from "../src/trail.ts";
import { StubHost } from "./host.ts";

// ── The pure read-only judgement ───────────────────────────────────────────

test("f196 only scout/reviewer delegations with no isolation are provably read-only", () => {
  assert.equal(classifyDelegation("agent_run", { agent: "scout", task: "survey" })!.readOnly, true);
  assert.equal(classifyDelegation("agent_run", { agent: "reviewer", task: "review" })!.readOnly, true);
  assert.equal(classifyDelegation("agent_run", { agent: "worker", task: "build" })!.readOnly, false);
  // A missing agent, or any isolation, is not provably read-only.
  assert.equal(classifyDelegation("agent_run", { task: "x" })!.readOnly, false);
  assert.equal(classifyDelegation("agent_run", { agent: "scout", task: "x", isolation: "worktree" })!.readOnly, false);
  // A workflow script can spawn anything, so it is never read-only.
  assert.equal(classifyDelegation("workflow", { name: "deploy" })!.readOnly, false);
  // A swarm is read-only only when EVERY item names a read-only agent.
  assert.equal(
    classifyDelegation("swarm_run", { agent: "scout", items: [{ task: "a", agent: "scout" }, { task: "b", agent: "reviewer" }] })!.readOnly,
    true,
  );
  assert.equal(classifyDelegation("swarm_run", { agent: "scout", items: ["a", "b"] })!.readOnly, false);
  assert.equal(classifyDelegation("swarm_run", { agent: "scout", items: [{ task: "a", agent: "worker" }] })!.readOnly, false);
  assert.equal(classifyDelegation("swarm_run", { agent: "worker", items: [{ task: "a", agent: "scout" }] })!.readOnly, false);
  // Not a delegation tool at all.
  assert.equal(classifyDelegation("bash", { command: "ls" }), null);
  assert.ok(isDelegationTool("agent_run") && isDelegationTool("swarm_run") && isDelegationTool("workflow"));
  assert.ok(!isDelegationTool("bash"));
});

test("f196 delegationTarget names the tool, the agent and the task head", () => {
  const info = classifyDelegation("agent_run", { agent: "worker", task: "delete the legacy module\nand rewrite config" })!;
  assert.equal(delegationTarget(info), "agent_run agent=worker task=delete the legacy module");
});

// ── The wired gate, through a stub host ─────────────────────────────────────

function boot(opts: { cwd: string; hasUI?: boolean; confirm?: boolean }): StubHost {
  const host = new StubHost(opts);
  yolo(host.api as unknown as ExtensionAPI);
  return host;
}

/** A git repo with one uncommitted change, so `git stash create` yields a sha. */
function dirtyRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pify-yolo-deleg-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd, windowsHide: true });
  run(["init", "-q"]);
  run(["config", "user.email", "t@t.t"]);
  run(["config", "user.name", "t"]);
  run(["config", "core.autocrlf", "false"]);
  writeFileSync(join(cwd, "f.txt"), "a\n");
  run(["add", "f.txt"]);
  run(["commit", "-qm", "init"]);
  writeFileSync(join(cwd, "f.txt"), "a\nb\n"); // dirty → a real checkpoint
  return cwd;
}

function withAgentDir<T>(fn: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = mkdtempSync(join(tmpdir(), "pify-yolo-agent-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return fn(agentDir).finally(() => {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(agentDir, { recursive: true, force: true });
  });
}

test("f196 wire: a worker delegation asks in approve", async () => {
  const cwd = dirtyRepo();
  try {
    await withAgentDir(async () => {
      const host = boot({ cwd, hasUI: true, confirm: true });
      await host.fire("session_start", { type: "session_start", reason: "startup" });
      await host.run("yolo", "approve");
      const result = await host.toolCall("agent_run", { agent: "worker", task: "delete the legacy module" });
      assert.equal(result, undefined, "a yes lets it through");
      assert.equal(host.confirms.length, 1);
      assert.match(host.confirms[0]!.title, /child agent/i);
      assert.match(host.confirms[0]!.message, /worker/);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("f196 wire: a worker delegation in yolo is allowed and leaves one checkpointed trail entry", async () => {
  const cwd = dirtyRepo();
  try {
    await withAgentDir(async () => {
      const host = boot({ cwd });
      await host.fire("session_start", { type: "session_start", reason: "startup" });
      await host.run("yolo", "yolo");
      assert.equal(await host.toolCall("agent_run", { agent: "worker", task: "scaffold" }), undefined);

      const entries = readManifest(trailDir(process.env.PI_CODING_AGENT_DIR!, cwd)).filter((e) => e.tool === "agent_run");
      assert.equal(entries.length, 1, "one delegation entry");
      assert.match(entries[0]!.target, /agent_run agent=worker task=scaffold/);
      assert.ok(entries[0]!.stashSha, "with a checkpoint field");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("f196 wire: a scout delegation neither asks nor checkpoints", async () => {
  const cwd = dirtyRepo();
  try {
    await withAgentDir(async () => {
      const host = boot({ cwd, hasUI: true, confirm: true });
      await host.fire("session_start", { type: "session_start", reason: "startup" });
      await host.run("yolo", "approve");
      assert.equal(await host.toolCall("agent_run", { agent: "scout", task: "survey the tree" }), undefined);
      assert.equal(host.confirms.length, 0, "no confirmation");
      const entries = readManifest(trailDir(process.env.PI_CODING_AGENT_DIR!, cwd)).filter((e) => e.tool === "agent_run");
      assert.equal(entries.length, 0, "no checkpoint");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("f196 wire: a workflow asks in strict and a decline stops the turn", async () => {
  const cwd = dirtyRepo();
  try {
    await withAgentDir(async () => {
      const host = boot({ cwd, hasUI: true, confirm: false });
      await host.fire("session_start", { type: "session_start", reason: "startup" });
      await host.run("yolo", "strict");
      const result = await host.toolCall("workflow", { name: "deploy" });
      assert.equal(host.confirms.length, 1, "strict asks about a workflow");
      assert.equal(result?.block, true);
      assert.match(result?.reason ?? "", /declined the workflow/);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
