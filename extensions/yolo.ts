/**
 * @pify/yolo — one toggle to auto-approve everything, with an undo trail.
 *
 * Two modes. guard (default): bash runs through a three-tier safety gate —
 * catastrophic patterns BLOCK outright (never overridable), destructive
 * ones ASK with the command shown (denial reasons flow back to the agent),
 * everything else runs. yolo: the gate stands down and everything
 * auto-approves — but the trail keeps recording. In BOTH modes every
 * edit/write saves a pre-image first and risky bash commands are logged,
 * so /yolo undo can walk file changes back even after a restart.
 *
 * Fail-closed everywhere (zhushanwen's rule): evaluation errors block,
 * headless ASK becomes deny. User rules in .pi/yolo.json (wildcard,
 * last-match-wins) can retune ASK/ALLOW but never the catastrophic floor.
 *
 * Design synthesis: three-tier rules (pi-yolo-seatbelt), fail-closed +
 * reject-with-reason + wildcard rules (@zhushanwen/pi-permission),
 * /yolo session toggle (valdo766hi).
 */
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { evaluateCommand, parseUserRules } from "../src/rules.ts";
import { formatTrail, readManifest, recordBash, recordPreImage, trailDir, undo } from "../src/trail.ts";
import { isRecord, type Mode, type UserRule } from "../src/types.ts";

const MODE_ENTRY = "yolo-mode";

type UiContext = ExtensionContext;

export default function yolo(pi: ExtensionAPI) {
  let mode: Mode = "guard";
  let userRules: UserRule[] = [];
  let dir = "";

  function updateFooter(ctx: UiContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("yolo", mode === "yolo" ? "⚡ YOLO" : undefined);
  }

  function setMode(ctx: UiContext, next: Mode): void {
    mode = next;
    pi.appendEntry(MODE_ENTRY, { mode: next });
    updateFooter(ctx);
    if (ctx.hasUI) {
      ctx.ui.notify(
        next === "yolo"
          ? "⚡ YOLO on — everything auto-approves. The undo trail keeps recording; /yolo to turn the guard back on."
          : "🛡 Guard on — catastrophic commands block, destructive ones ask.",
        next === "yolo" ? "warning" : "info",
      );
    }
  }

  function gitHead(cwd: string): string | null {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd,
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
      }).trim();
    } catch {
      return null;
    }
  }

  function loadUserRules(cwd: string): void {
    try {
      userRules = parseUserRules(JSON.parse(readFileSync(join(cwd, ".pi", "yolo.json"), "utf8")));
    } catch {
      userRules = [];
    }
  }

  // ── The gate + the trail ─────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    // Trail: pre-image every file mutation, in both modes.
    if (event.toolName === "edit" || event.toolName === "write") {
      const path = (event as { input?: { path?: unknown } }).input?.path;
      if (typeof path === "string" && dir) {
        recordPreImage(dir, path, Date.now());
      }
      return undefined;
    }

    if (event.toolName !== "bash") return undefined;
    const command = (event as { input?: { command?: unknown } }).input?.command;
    if (typeof command !== "string") {
      return { block: true, reason: "yolo guard: bash call without a command (fail-closed)." };
    }

    const verdict = evaluateCommand(command, userRules);

    // Log risky commands (and everything in yolo mode) to the trail.
    if (dir && (mode === "yolo" ? verdict.action !== "allow" : verdict.action !== "allow")) {
      recordBash(dir, command, ctx.cwd, gitHead(ctx.cwd), Date.now());
    }

    if (mode === "yolo") return undefined; // gate stands down; trail recorded

    if (verdict.action === "allow") return undefined;

    if (verdict.action === "block") {
      return {
        block: true,
        reason: `yolo guard blocked this command (${verdict.rule}) — catastrophic patterns are never auto-approved. Do not retry it; choose a safer approach.`,
      };
    }

    // ASK tier.
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `yolo guard: '${verdict.rule}' needs confirmation but no UI is available (fail-closed deny).`,
      };
    }
    const approved = await ctx.ui.confirm(
      "Destructive command",
      `${command}\n\nRule: ${verdict.rule}. Run it?`,
    );
    if (approved) return undefined;

    // Reject-with-reason: the user's why helps the agent adjust course.
    const reason = await ctx.ui.input("Why not? (optional — sent to the agent)");
    return {
      block: true,
      reason: reason?.trim()
        ? `The user declined (${verdict.rule}): ${reason.trim()}`
        : `The user declined this command (${verdict.rule}). Choose a different approach.`,
    };
  });

  // ── Lifecycle ────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    dir = trailDir(getAgentDir(), ctx.cwd);
    loadUserRules(ctx.cwd);
    mode = "guard";
    for (const entry of ctx.sessionManager.getBranch()) {
      const e = entry as { type?: string; customType?: string; data?: unknown };
      if (e.type === "custom" && e.customType === MODE_ENTRY && isRecord(e.data)) {
        if (e.data.mode === "yolo" || e.data.mode === "guard") mode = e.data.mode;
      }
    }
    updateFooter(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    mode = "guard";
    for (const entry of ctx.sessionManager.getBranch()) {
      const e = entry as { type?: string; customType?: string; data?: unknown };
      if (e.type === "custom" && e.customType === MODE_ENTRY && isRecord(e.data)) {
        if (e.data.mode === "yolo" || e.data.mode === "guard") mode = e.data.mode;
      }
    }
    updateFooter(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("yolo", undefined);
  });

  // ── Command ──────────────────────────────────────────────────────────

  pi.registerCommand("yolo", {
    description: "Toggle auto-approve: /yolo [on|off|status|trail|undo [n]]",
    handler: async (args, ctx) => {
      const [route, countRaw] = (args ?? "").trim().toLowerCase().split(/\s+/);
      switch (route || "toggle") {
        case "toggle":
          setMode(ctx, mode === "yolo" ? "guard" : "yolo");
          return;
        case "on":
          setMode(ctx, "yolo");
          return;
        case "off":
          setMode(ctx, "guard");
          return;
        case "status": {
          if (!ctx.hasUI) return;
          const entries = readManifest(dir);
          ctx.ui.notify(
            [
              `Mode: ${mode === "yolo" ? "⚡ YOLO (gate off)" : "🛡 guard"}`,
              `User rules: ${userRules.length} (.pi/yolo.json)`,
              `Trail: ${entries.length} entries — /yolo trail to view, /yolo undo [n] to restore`,
            ].join("\n"),
            "info",
          );
          return;
        }
        case "trail": {
          if (!ctx.hasUI) return;
          ctx.ui.notify(formatTrail(readManifest(dir), 20), "info");
          return;
        }
        case "undo": {
          if (!ctx.hasUI) return;
          const count = Math.max(1, Math.min(50, Number.parseInt(countRaw ?? "1", 10) || 1));
          const preview = readManifest(dir)
            .filter((e) => e.type === "file")
            .sort((a, b) => b.seq - a.seq)
            .slice(0, count);
          if (preview.length === 0) {
            ctx.ui.notify("Nothing to undo — the trail has no file entries.", "warning");
            return;
          }
          const ok = await ctx.ui.confirm(
            "Undo file changes",
            `Restore ${preview.length} file(s) to their pre-images?\n${preview.map((e) => e.target).join("\n")}`,
          );
          if (!ok) return;
          const result = undo(dir, count);
          ctx.ui.notify(
            [
              result.restored.length > 0 ? `Restored: ${result.restored.join(", ")}` : "",
              result.deleted.length > 0 ? `Deleted (were new): ${result.deleted.join(", ")}` : "",
              result.skipped.length > 0 ? `Skipped: ${result.skipped.join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("\n") || "Nothing changed.",
            "info",
          );
          return;
        }
        default:
          if (ctx.hasUI) ctx.ui.notify("Usage: /yolo [on|off|status|trail|undo [n]]", "warning");
      }
    },
  });
}
