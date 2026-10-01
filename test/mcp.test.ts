import { test } from "node:test";
import assert from "node:assert/strict";
import { describeHints, isMcpTool, mcpVerdict, previewArgs } from "../src/mcp.ts";

test("an MCP tool is recognised by its namespace or its name", () => {
  assert.equal(isMcpTool({ name: "delete_issue", namespace: { name: "mcp__jira" } }, "delete_issue"), true);
  assert.equal(isMcpTool(undefined, "mcp__jira__delete_issue"), true);
  assert.equal(isMcpTool({ name: "read" }, "read"), false);
  assert.equal(isMcpTool({ name: "agent_run", namespace: { name: "pify" } }, "agent_run"), false);
});

test("the verdict follows the hints and the MCP defaults for missing ones", () => {
  assert.deepEqual(mcpVerdict({ readOnlyHint: true, destructiveHint: true }), { action: "allow", rule: "mcp:read-only" });
  assert.deepEqual(mcpVerdict({ destructiveHint: true }), { action: "ask", rule: "mcp:destructive" });
  assert.deepEqual(mcpVerdict({ destructiveHint: false, openWorldHint: false }), { action: "allow", rule: "mcp:non-destructive" });
  assert.deepEqual(mcpVerdict({ destructiveHint: false }), { action: "ask", rule: "mcp:open-world" });
  assert.deepEqual(mcpVerdict(undefined), { action: "ask", rule: "mcp:unannotated" });
  assert.deepEqual(mcpVerdict({}), { action: "ask", rule: "mcp:unannotated" });
});

test("dialog helpers are short and never throw", () => {
  assert.match(describeHints(undefined), /no hints/);
  assert.equal(describeHints({ readOnlyHint: false, destructiveHint: true }), "read-only: false, destructive: true");
  assert.equal(previewArgs({ id: 1 }), '{"id":1}');
  assert.ok(previewArgs({ big: "x".repeat(500) }).length <= 200);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(previewArgs(cyclic), "{…}");
});
