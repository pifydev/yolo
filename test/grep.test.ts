import { test } from "node:test";
import assert from "node:assert/strict";
import { grepFileCandidates, grepSearchRoot, withholdSecretMatches } from "../src/grep.ts";
import { secretPathKind } from "../src/rules.ts";

const isSecret = (root: string) => (file: string) =>
  grepFileCandidates(root, file).some((candidate) => secretPathKind(candidate) !== null);

test("grep search root: default cwd, relative joins, ~ expands, absolute stays", () => {
  assert.equal(grepSearchRoot(undefined, "/repo", "/home/u"), "/repo");
  assert.equal(grepSearchRoot(".", "/repo", "/home/u"), "/repo");
  assert.equal(grepSearchRoot("src", "/repo", "/home/u"), "/repo/src");
  assert.equal(grepSearchRoot("~", "/repo", "/home/u"), "/home/u");
  assert.equal(grepSearchRoot("~/.aws", "/repo", "/home/u"), "/home/u/.aws");
  assert.equal(grepSearchRoot("/etc", "/repo", "/home/u"), "/etc");
  // Not a string: pi would search cwd, so that is what gets classified.
  assert.equal(grepSearchRoot(42, "/repo", "/home/u"), "/repo");
});

test("grep prints a file search as a bare basename, so that resolves to the search path itself", () => {
  // Directory search: `path.relative(root, file)`, forward slashes.
  assert.deepEqual(grepFileCandidates("/repo", "src/app.ts"), ["/repo/src/app.ts"]);
  // File search: pi prints basename(file); joining it under the root would
  // give `.aws/credentials/credentials`, which matches nothing.
  assert.ok(grepFileCandidates("/home/u/.aws/credentials", "credentials").includes("/home/u/.aws/credentials"));
  assert.ok(grepFileCandidates("/repo/.env", ".env").includes("/repo/.env"));
});

test("withhold: a .env block is replaced, the normal block stays byte-for-byte", () => {
  const text = [
    "src/config.ts:3: const url = process.env.DATABASE_URL;",
    "src/config.ts:9: export const port = 3000;",
    ".env:1: DATABASE_URL=postgres://user:hunter2@db/prod",
    ".env:2: AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG",
    "README.md:12: Copy .env.example to .env and fill it in.",
  ].join("\n");
  const result = withholdSecretMatches(text, isSecret("/repo"));
  const lines = result.text.split("\n");
  assert.deepEqual(lines, [
    "src/config.ts:3: const url = process.env.DATABASE_URL;",
    "src/config.ts:9: export const port = 3000;",
    "[yolo] 2 matching lines in .env withheld: secret material — use read on it to be asked",
    "README.md:12: Copy .env.example to .env and fill it in.",
  ]);
  assert.ok(!result.text.includes("hunter2"), "the secret value is gone");
  assert.ok(!result.text.includes("wJalrXUtnFEMI"), "and the other one");
  assert.deepEqual(result.withheld, [{ file: ".env", lines: 2 }]);
});

test("withhold: context lines of a secret block go too, and only match lines are counted", () => {
  const text = [
    ".env:2: TOKEN=abc",
    ".env-3- # comment",
    ".env-4- OTHER=1",
    ".env:5: SECRET=xyz",
    "a.ts:1: fine",
  ].join("\n");
  const result = withholdSecretMatches(text, isSecret("/repo"));
  assert.equal(
    result.text,
    ["[yolo] 2 matching lines in .env withheld: secret material — use read on it to be asked", "a.ts:1: fine"].join("\n"),
  );
});

test("withhold: a directory search that reaches ~/.aws/credentials is stripped", () => {
  const text = [
    ".bashrc:4: export EDITOR=vim",
    ".aws/credentials:2: aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
    ".aws/credentials:3: aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ".aws/config:2: region = eu-west-1",
    "",
    "[100 matches limit reached. Use limit=200 for more, or refine pattern]",
  ].join("\n");
  const result = withholdSecretMatches(text, isSecret("/home/u"));
  assert.ok(!result.text.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(!result.text.includes("bPxRfiCYEXAMPLEKEY"));
  assert.ok(result.text.includes(".bashrc:4: export EDITOR=vim"));
  assert.ok(result.text.includes("[yolo] 2 matching lines in .aws/credentials withheld"));
  // .aws/config is secret material too (profiles carry keys)
  assert.ok(result.text.includes("[yolo] 1 matching line in .aws/config withheld"));
  // pi's trailing notice survives untouched
  assert.ok(result.text.endsWith("\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern]"));
  assert.equal(result.withheld.length, 2);
});

test("withhold: a file search prints basenames, and the search path decides", () => {
  const text = "credentials:2: aws_secret_access_key = wJalrXUtnFEMI";
  const stripped = withholdSecretMatches(text, isSecret("/home/u/.aws/credentials"));
  assert.ok(!stripped.text.includes("wJalrXUtnFEMI"));
  assert.equal(stripped.withheld.length, 1);
});

test("withhold: nothing secret means the text comes back identical and withheld is empty", () => {
  const text = "src/a.ts:1: hello\nsrc/b.ts:2: world";
  const result = withholdSecretMatches(text, isSecret("/repo"));
  assert.equal(result.text, text);
  assert.deepEqual(result.withheld, []);
  assert.deepEqual(withholdSecretMatches("No matches found", isSecret("/repo")).withheld, []);
});

test("withhold: an unreadable-file marker still names the file, and is withheld like a match", () => {
  const text = ".env:1: (unable to read file)";
  const result = withholdSecretMatches(text, isSecret("/repo"));
  assert.ok(!result.text.startsWith(".env:1:"));
  assert.equal(result.withheld[0]?.file, ".env");
});
