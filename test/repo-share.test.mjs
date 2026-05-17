import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const CLI = new URL("../bin/repo-share.js", import.meta.url).pathname;

function run(cwd, args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    ...opts,
  });
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function initRepo(dir) {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
}

test("add/sync require a clean canonical repo and check --locked verifies committed target only", () => {
  const root = mkdtempSync(join(tmpdir(), "repo-share-test-"));
  const source = join(root, "source");
  const consumer = join(root, "consumer");
  mkdirSync(source);
  mkdirSync(consumer);
  initRepo(source);
  initRepo(consumer);

  writeFileSync(join(source, "index.ts"), "export const value = 1;\n");
  writeFileSync(join(source, "README.md"), "source readme\n");
  git(source, ["add", "."]);
  git(source, ["commit", "-qm", "init source"]);

  writeFileSync(join(source, "dirty.txt"), "uncommitted\n");
  const dirty = run(consumer, ["add", "shared", "--from", source, "--to", "vendor/shared", "--include", "index.ts,README.md"]);
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /canonical source repo has uncommitted changes/);

  rmSync(join(source, "dirty.txt"));
  const added = run(consumer, ["add", "shared", "--from", source, "--to", "vendor/shared", "--include", "index.ts,README.md"]);
  assert.equal(added.status, 0, added.stderr || added.stdout);
  assert.equal(readFileSync(join(consumer, "vendor/shared/index.ts"), "utf8"), "export const value = 1;\n");
  assert.ok(existsSync(join(consumer, ".repo-share.json")));

  const lockedOk = run(consumer, ["check", "--locked"]);
  assert.equal(lockedOk.status, 0, lockedOk.stderr || lockedOk.stdout);
  assert.match(lockedOk.stdout, /ok shared/);

  writeFileSync(join(source, "dirty.txt"), "dirty again\n");
  const lockedStillOk = run(consumer, ["check", "--locked"]);
  assert.equal(lockedStillOk.status, 0, lockedStillOk.stderr || lockedStillOk.stdout);

  const unlockedFails = run(consumer, ["check"]);
  assert.notEqual(unlockedFails.status, 0);
  assert.match(unlockedFails.stderr, /canonical source repo has uncommitted changes/);

  writeFileSync(join(consumer, "vendor/shared/index.ts"), "tampered\n");
  const stale = run(consumer, ["check", "--locked"]);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /stale shared/);
});
