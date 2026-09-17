/**
 * The one thing the gate cannot see into: a child agent.
 *
 * `agent_run`, `swarm_run` and `workflow` (from @pify/subagent, @pify/swarm,
 * @pify/workflow) spawn child sessions that run with `noExtensions: true` — so
 * yolo's own tool_call hook never fires inside them. A worker child gets full
 * bash/edit/write and walks straight past the catastrophic floor, the secret
 * gate, the mode gradient and the undo trail. On this pi there is no per-tool
 * seam to close inside the child, so the honest fix is at the delegation
 * boundary: gate the SPAWN, and take one checkpoint before it so /yolo rewind
 * and the trail can put the tree back after the child has run.
 *
 * The gate trusts the agent NAME. `scout` and `reviewer` are pi's built-in
 * read-only agent types, so a delegation to only those (with no isolation) is
 * treated as provably read-only and skipped. Everything else — a worker, a
 * custom agent, any isolation, any workflow (whose script can spawn anything),
 * or a swarm with an item that is not plainly a read-only agent — is not
 * provably read-only and gets the checkpoint (and, in approve/strict, a
 * confirmation). This cannot see a project `.pi/agents/scout.md` that OVERRIDES
 * the builtin to make "scout" write; that is the documented limitation.
 *
 * Pure: the caller supplies the tool name and its input.
 */

import { isRecord } from "./types.ts";

/** pi's built-in read-only agent types. A project override can subvert these. */
const READ_ONLY_AGENTS = new Set(["scout", "reviewer"]);

const DELEGATION_TOOLS = new Set(["agent_run", "swarm_run", "workflow"]);

export interface Delegation {
  /** "agent_run" | "swarm_run" | "workflow". */
  tool: string;
  /** True only when nothing here can mutate: read-only agent(s), no isolation. */
  readOnly: boolean;
  /** A short label of the agent(s), for the confirmation and the trail. */
  agent: string;
  /** The head of the task/name, clipped, for the confirmation and the trail. */
  taskHead: string;
}

export function isDelegationTool(name: unknown): name is string {
  return typeof name === "string" && DELEGATION_TOOLS.has(name);
}

function head(text: unknown, max = 80): string {
  if (typeof text !== "string") return "";
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const t = line.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export function classifyDelegation(toolName: string, input: unknown): Delegation | null {
  if (!DELEGATION_TOOLS.has(toolName)) return null;
  const data = isRecord(input) ? input : {};

  if (toolName === "workflow") {
    // A workflow script can spawn any agent, so it is never provably read-only.
    return {
      tool: toolName,
      readOnly: false,
      agent: "workflow",
      taskHead: head(data.name ?? data.script) || "(script)",
    };
  }

  if (toolName === "agent_run") {
    const agent = typeof data.agent === "string" ? data.agent : "";
    const readOnly = READ_ONLY_AGENTS.has(agent) && data.isolation == null;
    return { tool: toolName, readOnly, agent: agent || "(default)", taskHead: head(data.task) };
  }

  // swarm_run: read-only only if the default agent is read-only, there is no
  // isolation, and EVERY item names a read-only agent. A bare-string item, or
  // one with a missing or different agent, could run a writeable worker, so it
  // makes the whole swarm non-read-only.
  const topAgent = typeof data.agent === "string" ? data.agent : "";
  const items = Array.isArray(data.items) ? data.items : [];
  const allItemsReadOnly =
    items.length > 0 &&
    items.every((item) => isRecord(item) && typeof item.agent === "string" && READ_ONLY_AGENTS.has(item.agent));
  const readOnly = READ_ONLY_AGENTS.has(topAgent) && data.isolation == null && allItemsReadOnly;
  const first = items.length > 0 ? (isRecord(items[0]) ? items[0].task : items[0]) : "";
  return {
    tool: toolName,
    readOnly,
    agent: topAgent ? `swarm/${topAgent}` : "swarm",
    taskHead: head(first) || `${items.length} item(s)`,
  };
}

/** The trail target line for a delegation, e.g. `agent_run agent=worker task=…`. */
export function delegationTarget(d: Delegation): string {
  return `${d.tool} agent=${d.agent} task=${d.taskHead}`.slice(0, 500);
}
