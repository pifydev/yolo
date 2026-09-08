/**
 * Does a prompt checkpoint actually capture both halves?
 *
 * `/yolo rewind` is only as good as what was recorded when you hit enter: a
 * stash sha that still resolves to the tree as it stood, and the id of the
 * session entry your message became. Neither is something a unit test can
 * check — the first belongs to git, the second to pi's session tree — so this
 * drives the real host and then verifies both against them.
 *
 *   bun run test/live/rewind-wire.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { trailDir } from "../../src/trail.ts";
import { rewindPoints } from "../../src/rewind.ts";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROVIDER = process.env.PI_LIVE_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_LIVE_MODEL ?? "qwen/qwen3-235b-a22b-2507";
const NL = String.fromCharCode(10);

const agentDir = mkdtempSync(join(tmpdir(), "pify-rewind-agent-"));
const repo = mkdtempSync(join(tmpdir(), "pify-rewind-repo-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? passed++ : failed++;
};

try {
  execFileSync("git", ["init", "-q", repo]);
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "keep.txt"), `committed${NL}`);
  git("add", ".");
  git("commit", "-qm", "init");
  // An uncommitted change, so `git stash create` has something to capture.
  writeFileSync(join(repo, "keep.txt"), `committed${NL}uncommitted work${NL}`);

  spawnSync(
    "pi",
    [
      "--provider", PROVIDER,
      "--model", MODEL,
      "--no-extensions",
      "-e", join(PKG, "extensions", "yolo.ts"),
      // Quoted explicitly: with shell:true on Windows the args are re-joined
      // into a command line, and an unquoted sentence arrives as one prompt
      // per word — six turns instead of one.
      "-p", '"Reply with the single word OK."',
    ],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 300_000,
      shell: true,
      windowsHide: true,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    },
  );

  const dir = trailDir(agentDir, repo);
  const manifest = join(dir, "manifest.jsonl");
  const entries = existsSync(manifest)
    ? readFileSync(manifest, "utf8").split(NL).filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const points = rewindPoints(entries);

  console.log(`trail entries: ${entries.length}, checkpoints: ${points.length}`);
  for (const p of points) console.log(`  seq=${p.seq} entryId=${p.entryId} prompt=${JSON.stringify(p.prompt)}`);
  check("a prompt was checkpointed", points.length > 0);
  // One prompt is one checkpoint. Six of them meant the harness had lost the
  // quotes and pi had been handed one prompt per word.
  check("one prompt made exactly one checkpoint", points.length === 1, `${points.length}`);

  const point = points[0];
  if (point) {
    console.log(`  ${JSON.stringify(point)}`);
    check("it recorded what was typed", point.prompt.includes("OK"), point.prompt);

    check("it captured a session entry to go back to", Boolean(point.entryId), point.entryId ?? "none");
    check("it captured a tree to go back to", Boolean(point.stashSha), point.stashSha ?? "none");

    // The two halves have to still resolve, or the menu offers dead options.
    if (point.stashSha) {
      let treeOk = false;
      let content = "";
      try {
        content = execFileSync("git", ["show", `${point.stashSha}:keep.txt`], {
          cwd: repo,
          encoding: "utf8",
          timeout: 10_000,
        });
        treeOk = true;
      } catch {
        treeOk = false;
      }
      check("the stash sha still resolves to a real tree", treeOk);
      check(
        "and that tree holds the uncommitted work, not just the commit",
        content.includes("uncommitted work"),
        JSON.stringify(content.trim()),
      );
    }
  }
} finally {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}

console.log(`${NL}${passed}/${passed + failed} passed`);
process.exitCode = failed === 0 && passed > 0 ? 0 : 1;
