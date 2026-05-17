import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from "node:fs";
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

  mkdirSync(join(source, "bin"));
  writeFileSync(join(source, "index.ts"), "export const value = 1;\n");
  writeFileSync(join(source, "README.md"), "source readme\n");
  writeFileSync(join(source, "bin/cli.js"), "#!/usr/bin/env node\nconsole.log('cli');\n");
  git(source, ["add", "."]);
  git(source, ["commit", "-qm", "init source"]);

  writeFileSync(join(source, "dirty.txt"), "uncommitted\n");
  const dirty = run(consumer, ["add", "shared", "--from", source, "--to", "vendor/shared", "--include", "index.ts,README.md"]);
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /canonical source repo has uncommitted changes/);

  rmSync(join(source, "dirty.txt"));
  const added = run(consumer, ["add", "shared", "--from", source, "--to", "vendor/shared", "--include", "index.ts,README.md,bin/cli.js"]);
  assert.equal(added.status, 0, added.stderr || added.stdout);
  assert.equal(readFileSync(join(consumer, "vendor/shared/index.ts"), "utf8"), "export const value = 1;\n");
  assert.equal(readFileSync(join(consumer, "vendor/shared/bin/cli.js"), "utf8"), "#!/usr/bin/env node\nconsole.log('cli');\n");
  assert.ok(existsSync(join(consumer, ".repo-share.json")));
  assert.match(readFileSync(join(consumer, "vendor/shared/AGENTS.md"), "utf8"), /DO NOT EDIT files in this directory directly/);
  assert.match(readFileSync(join(consumer, "vendor/shared/.repo-share-copy.json"), "utf8"), /"managedBy": "repo-share"/);
  assert.equal(statSync(join(consumer, "vendor/shared/index.ts")).mode & 0o222, 0, "copied files are read-only");

  chmodSync(join(consumer, "vendor/shared/index.ts"), 0o644);
  assert.notEqual(statSync(join(consumer, "vendor/shared/index.ts")).mode & 0o222, 0, "test fixture made copy writable");

  const lockedOk = run(consumer, ["check", "--locked"]);
  assert.equal(lockedOk.status, 0, lockedOk.stderr || lockedOk.stdout);
  assert.match(lockedOk.stdout, /ok shared/);
  assert.equal(statSync(join(consumer, "vendor/shared/index.ts")).mode & 0o222, 0, "check reprotects copied files");

  chmodSync(join(consumer, "vendor/shared/index.ts"), 0o644);
  const protectedOk = run(consumer, ["protect", "shared"]);
  assert.equal(protectedOk.status, 0, protectedOk.stderr || protectedOk.stdout);
  assert.match(protectedOk.stdout, /protected shared/);
  assert.equal(statSync(join(consumer, "vendor/shared/index.ts")).mode & 0o222, 0, "protect makes copied files read-only");

  mkdirSync(join(consumer, "vendor/shared/.turbo"));
  writeFileSync(join(consumer, "vendor/shared/.turbo/turbo-typecheck.log"), "generated\n");
  writeFileSync(join(consumer, "vendor/shared/tsconfig.tsbuildinfo"), "generated\n");
  const generatedOk = run(consumer, ["check", "--locked"]);
  assert.equal(generatedOk.status, 0, generatedOk.stderr || generatedOk.stdout);

  writeFileSync(join(source, "dirty.txt"), "dirty again\n");
  const lockedStillOk = run(consumer, ["check", "--locked"]);
  assert.equal(lockedStillOk.status, 0, lockedStillOk.stderr || lockedStillOk.stdout);

  const unlockedFails = run(consumer, ["check"]);
  assert.notEqual(unlockedFails.status, 0);
  assert.match(unlockedFails.stderr, /canonical source repo has uncommitted changes/);

  rmSync(join(consumer, "vendor/shared/AGENTS.md"));
  const unguarded = run(consumer, ["check", "--locked"]);
  assert.notEqual(unguarded.status, 0);
  assert.match(unguarded.stderr, /unguarded shared/);

  chmodSync(join(consumer, "vendor/shared/index.ts"), 0o644);
  writeFileSync(join(consumer, "vendor/shared/index.ts"), "tampered\n");
  const stale = run(consumer, ["check", "--locked"]);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /stale shared/);
});
