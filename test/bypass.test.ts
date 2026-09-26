import { test } from "node:test";
import assert from "node:assert/strict";
import { bypassAdvice, detectBypass, isDirLike } from "../src/bypass.ts";

test("a recursive grep over a tree is a sweep; a grep on one file or a piped grep is not", () => {
  assert.equal(detectBypass("grep -rn password .")?.kind, "grep-sweep");
  assert.equal(detectBypass("grep -R 'AWS_SECRET' src")?.kind, "grep-sweep");
  assert.equal(detectBypass("grep -rni token")?.kind, "grep-sweep", "no target means the directory");
  assert.equal(detectBypass("rg SECRET")?.kind, "grep-sweep", "rg is recursive by default");
  assert.equal(detectBypass("rg -n foo src/")?.kind, "grep-sweep");
  assert.equal(detectBypass("grep -n password src/config.ts"), null, "one named file");
  assert.equal(detectBypass("grep -rn foo src/config.ts"), null, "recursive flag but a single file target");
  assert.equal(detectBypass("cat log.txt | grep -i error"), null, "reads stdin");
  assert.equal(detectBypass("git status"), null);
  // Inside a wrapper it is still found.
  assert.equal(detectBypass("bash -c 'grep -rn password .'")?.kind, "grep-sweep");
});

test("in-place editors are recognised with their file operands", () => {
  const sed = detectBypass("sed -i 's/a/b/' src/a.ts src/b.ts");
  assert.equal(sed?.kind, "inplace-edit");
  assert.deepEqual(sed && sed.kind === "inplace-edit" ? sed.paths : [], ["src/a.ts", "src/b.ts"]);
  const bak = detectBypass("sed -i.bak -e 's/a/b/' -e 's/c/d/' x.txt");
  assert.deepEqual(bak && bak.kind === "inplace-edit" ? bak.paths : [], ["x.txt"]);
  const longOpt = detectBypass("sed --in-place=.orig 's/a/b/' y.txt");
  assert.deepEqual(longOpt && longOpt.kind === "inplace-edit" ? longOpt.paths : [], ["y.txt"]);
  const perl = detectBypass("perl -pi -e 's/a/b/' lib/z.pm");
  assert.deepEqual(perl && perl.kind === "inplace-edit" ? perl.paths : [], ["lib/z.pm"]);
  const awk = detectBypass("gawk -i inplace '{print}' data.csv");
  assert.deepEqual(awk && awk.kind === "inplace-edit" ? awk.paths : [], ["data.csv"]);
  assert.equal(detectBypass("sed 's/a/b/' src/a.ts"), null, "not in place: prints to stdout");
  assert.equal(detectBypass("sed -n '1,5p' src/a.ts"), null, "-n is not -i");
  assert.equal(detectBypass("awk '{print $1}' data.csv"), null);
});

test("isDirLike and the advice text", () => {
  for (const t of [".", "..", "~", "/", "src", "src/", "*.ts", "lib/**"]) assert.equal(isDirLike(t), true, t);
  for (const t of ["src/a.ts", ".env", "README.md"]) assert.equal(isDirLike(t), false, t);
  assert.match(bypassAdvice("bypass:grep-sweep"), /grep tool/);
  assert.match(bypassAdvice("bypass:inplace-edit"), /edit tool/);
  assert.equal(bypassAdvice("secret:env-file"), "");
});
