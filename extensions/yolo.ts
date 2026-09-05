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
 * v0.2 adds two things yolo mode deliberately does not stand down for:
 * secret material (.env, ssh keys, cloud/registry credentials) asks before
 * any read/edit/write or naming command, and every risky bash command gets a
 * `git stash create` checkpoint recorded on the trail so command damage —
 * not just file edits — has a way back.
 *
 * Design synthesis: three-tier rules (pi-yolo-seatbelt), fail-closed +
 * reject-with-reason + wildcard rules (@zhushanwen/pi-permission),
 * /yolo session toggle (valdo766hi).
 */
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  getAgentDir,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CLASSIFY_SYSTEM_PROMPT,
  applyClassification,
  buildClassifyPrompt,
  needsClassification,
  parseClassification,
  type Classification,
} from "../src/classify.ts";
import { evaluateCommand, evaluatePath, parseUserRules } from "../src/rules.ts";
import { formatTrail, readManifest, recordBash, recordPreImage, trailDir, undo } from "../src/trail.ts";
import { isRecord, type Mode, type UserRule } from "../src/types.ts";

const MODE_ENTRY = "yolo-mode";
const CLASSIFIER_ENTRY = "yolo-classifier";
/** In front of every bash call: a slow answer costs seconds, not minutes. */
const CLASSIFY_TIMEOUT_MS = 20_000;

type UiContext = ExtensionContext;

export default function yolo(pi: ExtensionAPI) {
  let mode: Mode = "guard";
  /** Opt-in: layer 3 costs a model call on unfamiliar commands. */
  let classifierEnabled = false;
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

  /**
   * Snapshot the working tree into a dangling commit before a risky command.
   * `git stash create` writes nothing to the tree, the index, or the stash
   * list — it just gives us a sha to come back to. A ref keeps it out of gc's
   * reach; empty output means there was nothing to save.
   */
  function gitCheckpoint(cwd: string, now: number): string | null {
    try {
      const sha = execFileSync("git", ["stash", "create"], {
        cwd,
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      }).trim();
      if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;
      try {
        execFileSync("git", ["update-ref", `refs/pify/yolo/${now}`, sha], {
          cwd,
          timeout: 5000,
          windowsHide: true,
        });
      } catch {
        // unreachable-but-recent commits still survive the default gc window
      }
      return sha;
    } catch {
      return null;
    }
  }

  /** Confirmation gate for a file path (secret material). */
  async function guardPath(
    ctx: UiContext,
    path: string,
    rule: string,
    action: "ask" | "block",
  ): Promise<{ block: true; reason: string } | undefined> {
    if (action === "block") {
      return { block: true, reason: `yolo guard blocked access to ${path} (${rule}).` };
    }
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `yolo guard: ${path} holds secret material (${rule}) and there is no UI to confirm (fail-closed deny).`,
      };
    }
    const approved = await ctx.ui.confirm(
      "Secret file",
      `${path}\n\nRule: ${rule}. Allow this access?`,
    );
    if (approved) return undefined;
    return {
      block: true,
      reason: `The user declined access to ${path} (${rule}). Continue without its contents; ask for the value you need instead.`,
    };
  }

  /**
   * Ask a model whether an unmatched command is risky. Short timeout: this
   * sits in front of every bash call, so a slow answer must cost the session
   * seconds, not minutes — and a timeout is simply "no opinion".
   */
  async function classifyCommand(ctx: UiContext, command: string): Promise<Classification> {
    let session: AgentSession | null = null;
    try {
      const created = await createAgentSession({
        sessionManager: SessionManager.inMemory(ctx.cwd),
        model: ctx.model as never,
        tools: [],
        resourceLoader: new DefaultResourceLoader({
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
          noExtensions: true,
          noPromptTemplates: true,
          noThemes: true,
          // Replace the coding-agent prompt rather than append to it: with
          // the default prompt in place, models answer a classification
          // request with a markdown explanation instead of the JSON line.
          systemPrompt: CLASSIFY_SYSTEM_PROMPT.join(" "),
        } as never),
      });
      session = created.session;
      await session.prompt(buildClassifyPrompt(command, ctx.cwd), {
        signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
      } as never);
      const messages = session.messages as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
      const last = [...messages].reverse().find((m) => m.role === "assistant");
      const text = (last?.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
      return parseClassification(text);
    } catch (err) {
      return {
        risk: "safe",
        reason: `classifier unavailable (${err instanceof Error ? err.message : String(err)})`,
        fallback: true,
      };
    } finally {
      try {
        session?.dispose();
      } catch {
        // best-effort
      }
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
    // Secret material is checked in BOTH modes: yolo trades safety for speed,
    // not for handing credentials to a model.
    if (event.toolName === "read" || event.toolName === "edit" || event.toolName === "write") {
      const path = (event as { input?: { path?: unknown } }).input?.path;
      if (typeof path === "string") {
        const verdict = evaluatePath(path, userRules);
        if (verdict.action !== "allow") {
          const denial = await guardPath(ctx, path, verdict.rule, verdict.action);
          if (denial) return denial;
        }
        // Trail: pre-image every file mutation, in both modes.
        if (event.toolName !== "read" && dir) recordPreImage(dir, path, Date.now());
      }
      return undefined;
    }

    if (event.toolName !== "bash") return undefined;
    const command = (event as { input?: { command?: unknown } }).input?.command;
    if (typeof command !== "string") {
      return { block: true, reason: "yolo guard: bash call without a command (fail-closed)." };
    }

    let verdict = evaluateCommand(command, userRules);

    // Layer 3: a model looks at what the regexes had no opinion about. It can
    // only escalate allow → ask, so a talked-into-it classifier cannot open
    // the gate, and a broken one leaves the deterministic verdict standing.
    if (classifierEnabled && verdict.action === "allow" && needsClassification(command)) {
      const classification = await classifyCommand(ctx, command);
      const escalated = applyClassification(verdict.action, classification);
      if (escalated.rule) verdict = { action: "ask", rule: escalated.rule };
    }

    const touchesSecret = verdict.rule.startsWith("secret:");

    // Log risky commands, with a checkpoint of the tree as it was.
    if (dir && verdict.action !== "allow") {
      const now = Date.now();
      recordBash(dir, command, ctx.cwd, gitHead(ctx.cwd), now, gitCheckpoint(ctx.cwd, now));
    }

    // The gate stands down in yolo mode — except for secrets.
    if (mode === "yolo" && !touchesSecret) return undefined;

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
      touchesSecret ? "Command touches secret material" : "Destructive command",
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
    classifierEnabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      const e = entry as { type?: string; customType?: string; data?: unknown };
      if (e.type === "custom" && e.customType === MODE_ENTRY && isRecord(e.data)) {
        if (e.data.mode === "yolo" || e.data.mode === "guard") mode = e.data.mode;
      }
      if (e.type === "custom" && e.customType === CLASSIFIER_ENTRY && isRecord(e.data)) {
        if (typeof e.data.enabled === "boolean") classifierEnabled = e.data.enabled;
      }
    }
    updateFooter(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    mode = "guard";
    classifierEnabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      const e = entry as { type?: string; customType?: string; data?: unknown };
      if (e.type === "custom" && e.customType === MODE_ENTRY && isRecord(e.data)) {
        if (e.data.mode === "yolo" || e.data.mode === "guard") mode = e.data.mode;
      }
      if (e.type === "custom" && e.customType === CLASSIFIER_ENTRY && isRecord(e.data)) {
        if (typeof e.data.enabled === "boolean") classifierEnabled = e.data.enabled;
      }
    }
    updateFooter(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("yolo", undefined);
  });

  // ── Command ──────────────────────────────────────────────────────────

  pi.registerCommand("yolo", {
    description: "Toggle auto-approve: /yolo [on|off|status|trail|undo [n]|classifier on|off]",
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
              `AI classifier: ${classifierEnabled ? "on" : "off"} (/yolo classifier on)`,
              `Trail: ${entries.length} entries — /yolo trail to view, /yolo undo [n] to restore`,
            ].join("\n"),
            "info",
          );
          return;
        }
        case "classifier": {
          const value = (countRaw ?? "").toLowerCase();
          if (value !== "on" && value !== "off") {
            if (ctx.hasUI) {
              ctx.ui.notify(
                [
                  `AI classifier: ${classifierEnabled ? "on" : "off"}.`,
                  "When on, commands no rule matched are read by a model, which can escalate them to a confirmation — never to an approval.",
                  "Usage: /yolo classifier <on|off>",
                ].join("\n"),
                "info",
              );
            }
            return;
          }
          classifierEnabled = value === "on";
          pi.appendEntry(CLASSIFIER_ENTRY, { enabled: classifierEnabled });
          if (ctx.hasUI) {
            ctx.ui.notify(
              classifierEnabled
                ? "AI classifier ON — unmatched commands get a second opinion before they run."
                : "AI classifier OFF.",
              "info",
            );
          }
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
          if (ctx.hasUI) ctx.ui.notify("Usage: /yolo [on|off|status|trail|undo [n]|classifier on|off]", "warning");
      }
    },
  });
}
