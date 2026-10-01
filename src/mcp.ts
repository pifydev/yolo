/**
 * MCP tools on the gradient.
 *
 * pi 0.99 connects MCP servers and declares their tools to the model, each
 * with the hints its server chose (`annotations`: readOnlyHint,
 * destructiveHint, idempotentHint, openWorldHint) and under a namespace
 * named `mcp__<server>`. Nothing here used to see them: the gate knew
 * read/edit/write/grep, bash/powershell and the suite's own delegation
 * tools, and an MCP tool that deletes an issue or sends a message walked
 * straight past it in every mode.
 *
 * The verdict follows the MCP defaults, as pi's own docs suggest: a tool
 * that says it is read-only runs; one that says it is destructive asks; one
 * that says nothing asks too, because the protocol's default for a missing
 * hint is "may be destructive, reaches an open world". The mode gradient
 * then applies as for any ask. Pure; the extension supplies the lookup.
 */

export interface ToolAnnotationsLike {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolInfoLike {
  name?: unknown;
  namespace?: { name?: unknown } | null;
  annotations?: ToolAnnotationsLike | null;
}

/** True for a tool pi reports under an MCP namespace, or named the way pi names MCP tools. */
export function isMcpTool(info: ToolInfoLike | undefined, toolName: string): boolean {
  const ns = info?.namespace && typeof info.namespace.name === "string" ? info.namespace.name : "";
  return ns.startsWith("mcp__") || toolName.startsWith("mcp__");
}

/** What the hints say about one call: run it, or ask first. Missing hints take the MCP defaults. */
export function mcpVerdict(hints: ToolAnnotationsLike | null | undefined): { action: "allow" | "ask"; rule: string } {
  if (hints?.readOnlyHint === true) return { action: "allow", rule: "mcp:read-only" };
  if (hints?.destructiveHint === true) return { action: "ask", rule: "mcp:destructive" };
  if (hints?.destructiveHint === false && hints?.openWorldHint === false) return { action: "allow", rule: "mcp:non-destructive" };
  return { action: "ask", rule: hints?.destructiveHint === false ? "mcp:open-world" : "mcp:unannotated" };
}

/** One line for the confirmation dialog. */
export function describeHints(hints: ToolAnnotationsLike | null | undefined): string {
  if (!hints || Object.keys(hints).length === 0) return "no hints from the server (treated as possibly destructive)";
  const parts: string[] = [];
  if (hints.readOnlyHint !== undefined) parts.push(`read-only: ${hints.readOnlyHint}`);
  if (hints.destructiveHint !== undefined) parts.push(`destructive: ${hints.destructiveHint}`);
  if (hints.idempotentHint !== undefined) parts.push(`idempotent: ${hints.idempotentHint}`);
  if (hints.openWorldHint !== undefined) parts.push(`open world: ${hints.openWorldHint}`);
  return parts.join(", ");
}

/** A short, safe preview of the call's arguments for the dialog. */
export function previewArgs(input: unknown, max = 200): string {
  let text = "";
  try {
    text = JSON.stringify(input ?? {});
  } catch {
    text = "{…}";
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
