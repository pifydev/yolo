/**
 * @pify/yolo — one toggle to auto-approve everything, with an undo trail.
 *
 * A four-mode gradient (v0.4): yolo · auto · approve (default) · strict.
 * Bash runs through a three-tier rule set — catastrophic patterns BLOCK,
 * destructive ones ASK with the command shown (denial reasons flow back to
 * the agent), everything else runs — and the mode decides how much of that
 * to relax or tighten. Two invariants hold in every mode: the catastrophic
 * floor blocks, and secret material asks. In EVERY mode
 * edit/write saves a pre-image first and risky bash commands are logged,
 * so /yolo undo can walk file changes back even after a restart.
 *
 * Fail-closed everywhere (zhushanwen's rule): evaluation errors block,
 * headless ASK becomes deny. User rules in .pi/yolo.json (wildcard,
 * last-match-wins) can retune ASK/ALLOW but never the catastrophic floor.
 *
 * v0.2 adds two things no mode stands down for:
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
import { readFileSync, statSync, writeFileSync } from "node:fs";
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
import { withUiLock } from "../src/ui-lock.ts";
import { ReadLedger, assessBlindWrite, blindTitle } from "../src/reads.ts";
import {
  RESTORE_LABELS,
  clipPrompt,
  formatRewindList,
  parseRewindArgs,
  restoreChoices,
  restoreSummary,
  rewindPoints,
  type RestoreChoice,
} from "../src/rewind.ts";
import {
  consentQuestion,
  decideConsent,
  envConsent,
  parseConsent,
  readConsent,
  writeConsent,
} from "../src/consent.ts";
import {
  DEFAULT_RETENTION_DAYS,
  formatTrail,
  pruneTrail,
  readManifest,
  recordBash,
  recordPreImage,
  recordPrompt,
  trailDir,
  undo,
} from "../src/trail.ts";
import {
  MODES,
  MODE_BADGES,
  MODE_LABELS,
  askTitle,
  normalizeMode,
  resolveAction,
} from "../src/modes.ts";
import { isRecord, type Mode, type UserRule } from "../src/types.ts";

/** Today's guard, under its new name. */
const DEFAULT_MODE: Mode = "approve";

const MODE_ENTRY = "yolo-mode";
const CLASSIFIER_ENTRY = "yolo-classifier";
/** In front of every bash call: a slow answer costs seconds, not minutes. */
const CLASSIFY_TIMEOUT_MS = 20_000;

type UiContext = ExtensionContext;

export default function yolo(pi: ExtensionAPI) {
  let mode: Mode = DEFAULT_MODE;
  /** Opt-in: layer 3 costs a model call on unfamiliar commands. */
  let classifierEnabled = false;
  let userRules: UserRule[] = [];
  /** A project shipped rules we did not load because the project is untrusted. */
  let rulesRefused = false;
  let dir = "";

  function updateFooter(ctx: UiContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("yolo", MODE_BADGES[mode]);
  }

  function setMode(ctx: UiContext, next: Mode): void {
    mode = next;
    pi.appendEntry(MODE_ENTRY, { mode: next });
    updateFooter(ctx);
    if (ctx.hasUI) {
      ctx.ui.notify(
        [
          MODE_LABELS[next],
          "Catastrophic commands block and secrets ask in every mode. The undo trail keeps recording.",
        ].join("\n"),
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

  /**
   * What this session has read, and what the file looked like at the time.
   * Per session by design: a read from an hour ago in a different session is
   * not knowledge this agent has.
   */
  const reads = new ReadLedger();

  function statOf(path: string): { size: number; mtimeMs: number } | null {
    try {
      const s = statSync(path);
      return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
    } catch {
      return null;
    }
  }

  /**
   * Refuse to write a file blind. pi's `write` replaces a file whole with no
   * requirement that anyone read it, and `edit` proves only that its
   * oldString is present — not that the agent knew what else was.
   *
   * It follows the mode gradient like every other risk here: the two fast
   * modes run, the two careful ones ask. Reads are cheap, so the answer to a
   * refusal is always available to the agent.
   */
  async function guardBlindWrite(
    ctx: UiContext,
    tool: "write" | "edit",
    path: string,
  ): Promise<{ block: true; reason: string } | undefined> {
    if (mode === "yolo" || mode === "auto") return undefined;

    const verdict = assessBlindWrite(tool, path, statOf(path), reads);
    if (verdict.ok) return undefined;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `yolo guard: ${verdict.reason} No UI to confirm (fail-closed deny). Read the file first.`,
      };
    }
    const approved = await withUiLock(() => ctx.ui.confirm(blindTitle(verdict.kind), `${verdict.reason}

Go ahead anyway?`));
    if (approved) {
      // Approving it means the user has taken responsibility for this file;
      // asking again on the next edit would be nagging, not guarding.
      reads.note(path, statOf(path) ?? { size: 0, mtimeMs: 0 });
      return undefined;
    }
    return {
      block: true,
      reason: `The user declined. ${verdict.reason} Read the file, then try again.`,
    };
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
    const approved = await withUiLock(() => ctx.ui.confirm(
      "Secret file",
      `${path}\n\nRule: ${rule}. Allow this access?`,
    ));
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
      // `reload()` is not optional. `createAgentSession` only loads a resource
      // loader it builds itself; one passed in is used exactly as handed over,
      // and a fresh DefaultResourceLoader resolves neither `systemPrompt` nor
      // `appendSystemPrompt` until it loads. Without it the child ran with no
      // instructions at all — the call succeeds, the model answers, and it
      // answers as a generic assistant with nothing to say it went wrong.
      const loader = new DefaultResourceLoader({
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        // Replace the coding-agent prompt rather than append to it: with
        // the default prompt in place, models answer a classification
        // request with a markdown explanation instead of the JSON line.
        systemPrompt: CLASSIFY_SYSTEM_PROMPT.join(" "),
      } as never);
      await loader.reload();
      const created = await createAgentSession({
      sessionManager: SessionManager.inMemory(ctx.cwd),
      model: ctx.model as never,
      tools: [],
      resourceLoader: loader,
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

  /**
   * Delete the refs a prune released, so git can finally reclaim the commits
   * they pinned. Best-effort: a ref that is already gone is the outcome we
   * wanted anyway.
   */
  function releaseRefs(cwd: string, refs: string[]): void {
    for (const ref of refs) {
      try {
        execFileSync("git", ["update-ref", "-d", ref], { cwd, timeout: 5000, windowsHide: true });
      } catch {
        // already gone, or not a repo any more
      }
    }
  }

  async function loadUserRules(ctx: UiContext): Promise<void> {
    userRules = [];
    rulesRefused = false;
    let raw: string;
    try {
      raw = readFileSync(join(ctx.cwd, ".pi", "yolo.json"), "utf8");
    } catch {
      return;
    }
    // A repository ships this file, and a user rule can RELAX the destructive
    // tier — a cloned repo could otherwise turn the guard down on its own say
    // so, silently, on the first command.
    //
    // pi's own trust decision is necessary but not sufficient: pi only asks
    // about trust when the repository ships one of the resources pi itself
    // loads, and `.pi/yolo.json` is not one of them. Measured, a repo whose
    // only pi file was an extension's own config reported
    // `isProjectTrusted=true` — so the question has to be ours to put.
    if (!(await projectRulesAllowed(ctx))) {
      rulesRefused = true;
      return;
    }
    try {
      userRules = parseUserRules(JSON.parse(raw));
    } catch {
      userRules = [];
    }
  }

  /** Where the suite records which projects you approved, and for what. */
  function consentFile(): string {
    return join(getAgentDir(), "pify-project-consent.json");
  }

  /** May this repository's own gate rules be loaded? */
  async function projectRulesAllowed(ctx: UiContext): Promise<boolean> {
    const path = join(ctx.cwd, ".pi", "yolo.json");
    const file = consentFile();
    let raw: string | null = null;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      raw = null;
    }
    const store = parseConsent(raw);
    const verdict = decideConsent({
      projectTrusted: (ctx as unknown as { isProjectTrusted?: () => boolean }).isProjectTrusted?.() ?? false,
      remembered: readConsent(store, ctx.cwd, "yolo"),
      hasUI: ctx.hasUI,
      envOverride: envConsent(process.env),
    });
    if (verdict !== "ask") return verdict === "allow";

    const approved = await withUiLock(() => ctx.ui.confirm(
      "Load this project's command rules?",
      consentQuestion("its own rules for the command gate, which can relax what gets confirmed", path),
    ));
    try {
      writeFileSync(file, `${JSON.stringify(writeConsent(store, ctx.cwd, "yolo", approved), null, 2)}
`);
    } catch {
      // An unwritable consent file costs us the memory of the answer, not the answer.
    }
    return approved;
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
        if (event.toolName === "read") {
          // Record what the read is about to see, so a later edit can tell
          // whether the file still looks like that.
          const seen = statOf(path);
          if (seen) reads.note(path, seen);
        } else {
          const denial = await guardBlindWrite(ctx, event.toolName, path);
          if (denial) return denial;
          // A write that creates a file means the agent authored its
          // contents, so an immediate follow-up edit is not blind.
          if (event.toolName === "write" && statOf(path) === null) reads.note(path, { size: 0, mtimeMs: 0 });
          // Trail: pre-image every file mutation, in every mode.
          if (dir) recordPreImage(dir, path, Date.now());
        }
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

    // The mode decides what the verdict means: it may relax the destructive
    // tier (auto/yolo) or tighten the allow tier (strict), but never touches
    // the catastrophic floor or the secret gate.
    const action = resolveAction({
      mode,
      verdict,
      obviouslySafe: !needsClassification(command),
    });

    // Log risky commands, with a checkpoint of the tree as it was.
    if (dir && verdict.action !== "allow") {
      const now = Date.now();
      recordBash(dir, command, ctx.cwd, gitHead(ctx.cwd), now, gitCheckpoint(ctx.cwd, now));
    }

    if (action === "allow") return undefined;

    if (action === "block") {
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
    const approved = await withUiLock(() => ctx.ui.confirm(
      askTitle(mode, verdict),
      `${command}\n\nRule: ${verdict.rule}. Run it?`,
    ));
    if (approved) return undefined;

    // Reject-with-reason: the user's why helps the agent adjust course.
    const reason = await withUiLock(() => ctx.ui.input("Why not? (optional — sent to the agent)"));
    return {
      block: true,
      reason: reason?.trim()
        ? `The user declined (${verdict.rule}): ${reason.trim()}`
        : `The user declined this command (${verdict.rule}). Choose a different approach.`,
    };
  });

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * A checkpoint per prompt. The trail's own unit is the file change, which is
   * right for the gate and wrong for a person — nobody counts writes, they
   * think "forget I asked that".
   *
   * The prompt text comes from `before_agent_start`, which carries it; the
   * session entry id comes from the leaf at `agent_start`, once the message
   * has actually been appended. Reading the branch instead looked simpler and
   * was wrong: at `before_agent_start` the user message is not in it yet.
   */
  let pendingPrompt: string | null = null;

  pi.on("before_agent_start", async (event) => {
    const prompt = (event as { prompt?: unknown }).prompt;
    pendingPrompt = typeof prompt === "string" ? clipPrompt(prompt) : null;
    return undefined;
  });

  pi.on("agent_start", async (_event, ctx) => {
    const prompt = pendingPrompt;
    pendingPrompt = null;
    if (!dir || !prompt) return;
    const leaf = ctx.sessionManager.getLeafId?.() ?? null;
    const now = Date.now();
    recordPrompt(dir, prompt, leaf, ctx.cwd, gitHead(ctx.cwd), now, gitCheckpoint(ctx.cwd, now));
  });

  pi.on("tool_result", async (event) => {
    // The agent wrote this content, so it knows what is in the file now.
    // Without this, its own write would make the next edit look stale.
    const name = (event as { toolName?: string }).toolName;
    if (name !== "write" && name !== "edit") return;
    // A tool that failed changed nothing, so it taught the agent nothing.
    if ((event as { isError?: boolean }).isError === true) return;
    const path = (event as { input?: Record<string, unknown> }).input?.path;
    if (typeof path !== "string") return;
    const now = statOf(path);
    if (now) reads.note(path, now);
  });

  pi.on("session_start", async (_event, ctx) => {
    dir = trailDir(getAgentDir(), ctx.cwd);
    await loadUserRules(ctx);
    // Retention runs once per session, not per command: the walk is cheap but
    // it is still I/O in front of a tool call otherwise.
    const pruned = pruneTrail(dir, Date.now());
    if (pruned.refs.length > 0) releaseRefs(ctx.cwd, pruned.refs);
    mode = DEFAULT_MODE;
    classifierEnabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      const e = entry as { type?: string; customType?: string; data?: unknown };
      if (e.type === "custom" && e.customType === MODE_ENTRY && isRecord(e.data)) {
        const restored = normalizeMode(e.data.mode);
        if (restored) mode = restored;
      }
      if (e.type === "custom" && e.customType === CLASSIFIER_ENTRY && isRecord(e.data)) {
        if (typeof e.data.enabled === "boolean") classifierEnabled = e.data.enabled;
      }
    }
    updateFooter(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    mode = DEFAULT_MODE;
    classifierEnabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      const e = entry as { type?: string; customType?: string; data?: unknown };
      if (e.type === "custom" && e.customType === MODE_ENTRY && isRecord(e.data)) {
        const restored = normalizeMode(e.data.mode);
        if (restored) mode = restored;
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
    description:
      "Safety gradient: /yolo [yolo|auto|approve|strict|status|trail|rewind [n]|undo [n]|classifier on|off]",
    handler: async (args, ctx) => {
      const [route, countRaw] = (args ?? "").trim().toLowerCase().split(/\s+/);
      switch (route || "toggle") {
        case "toggle":
          // The bare command still flips between the two ends people use.
          setMode(ctx, mode === "yolo" ? DEFAULT_MODE : "yolo");
          return;
        case "on":
          setMode(ctx, "yolo");
          return;
        case "off":
        case "guard":
          setMode(ctx, DEFAULT_MODE);
          return;
        case "yolo":
        case "auto":
        case "approve":
        case "strict":
          setMode(ctx, route as Mode);
          return;
        case "status": {
          if (!ctx.hasUI) return;
          const entries = readManifest(dir);
          ctx.ui.notify(
            [
              `Mode: ${MODE_LABELS[mode]}`,
              `Other modes: ${MODES.filter((m) => m !== mode).join(" · ")} (/yolo <mode>)`,
              rulesRefused
                ? "User rules: .pi/yolo.json found but NOT loaded — this project is not trusted (rules can relax the guard)"
                : `User rules: ${userRules.length} (.pi/yolo.json)`,
              `Trail: kept ${DEFAULT_RETENTION_DAYS} days`,
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
        case "rewind": {
          if (!ctx.hasUI) return;
          const parsed = parseRewindArgs((args ?? "").trim().slice("rewind".length));
          if (parsed.kind === "error") {
            ctx.ui.notify(parsed.message, "warning");
            return;
          }
          const points = rewindPoints(readManifest(dir));
          if (parsed.kind === "list") {
            ctx.ui.notify(formatRewindList(points, 15), "info");
            return;
          }
          const point = points[parsed.index - 1];
          if (!point) {
            ctx.ui.notify(`No checkpoint ${parsed.index}. /yolo rewind lists them.`, "warning");
            return;
          }
          const choices = restoreChoices(point);
          if (choices.length === 0) {
            ctx.ui.notify(
              "That prompt has nothing to restore — the tree was unchanged and the message left no session entry.",
              "warning",
            );
            return;
          }
          const labels = choices.map((c) => RESTORE_LABELS[c]);
          const picked = await withUiLock(() => ctx.ui.select("Rewind what?", labels));
          if (picked === undefined) return;
          const choice = choices[labels.indexOf(picked)] as RestoreChoice;

          if (!(await withUiLock(() => ctx.ui.confirm("Rewind", restoreSummary(point, choice))))) return;

          if (choice === "code" || choice === "both") {
            // `git checkout <stash-sha> -- .` writes that tree over the working
            // directory without moving HEAD or touching the branch, which is
            // what "put the files back" has to mean here.
            try {
              execFileSync("git", ["checkout", point.stashSha as string, "--", "."], {
                cwd: ctx.cwd,
                timeout: 30_000,
                windowsHide: true,
              });
              ctx.ui.notify(`Working tree restored to ${point.stashSha?.slice(0, 8)}.`, "info");
            } catch (err) {
              ctx.ui.notify(
                `Could not restore the tree: ${err instanceof Error ? err.message : String(err)}`,
                "error",
              );
              return;
            }
          }

          if (choice === "conversation" || choice === "both") {
            const host = ctx as unknown as {
              navigateTree?: (id: string, options?: { label?: string }) => Promise<{ cancelled: boolean }>;
            };
            if (typeof host.navigateTree !== "function") {
              ctx.ui.notify("This pi build cannot navigate the session tree.", "warning");
              return;
            }
            try {
              await host.navigateTree(point.entryId as string, { label: "before: " + point.prompt.slice(0, 40) });
            } catch (err) {
              ctx.ui.notify(
                `Could not move the conversation: ${err instanceof Error ? err.message : String(err)}`,
                "error",
              );
            }
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
          const ok = await withUiLock(() => ctx.ui.confirm(
            "Undo file changes",
            `Restore ${preview.length} file(s) to their pre-images?\n${preview.map((e) => e.target).join("\n")}`,
          ));
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
