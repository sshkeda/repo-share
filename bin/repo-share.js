#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const MANIFEST = ".repo-share.json";
const DEFAULT_EXCLUDES = [".git", "node_modules", "dist", "coverage", ".DS_Store"];

function die(message, code = 1) {
  console.error(`repo-share: ${message}`);
  process.exit(code);
}

function usage() {
  console.log(`repo-share

Usage:
  repo-share add <name> --from <canonical-repo> --to <target-path> [--include a,b] [--exclude a,b]
  repo-share sync [name]
  repo-share check [--locked] [name]
  repo-share list
  repo-share diff [name]

Invariants:
  - add/sync/check without --locked require the canonical source repo to be a clean git worktree.
  - check --locked does not need the canonical repo; it verifies committed target snapshots against stored hashes.
`);
}

function parseArgs(argv) {
  const [cmd, maybeName, ...rest] = argv;
  const args = { cmd, name: maybeName && !maybeName.startsWith("--") ? maybeName : undefined, flags: {} };
  const tokens = args.name ? rest : [maybeName, ...rest].filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("--")) die(`unexpected argument ${token}`);
    const key = token.slice(2);
    if (key === "locked") {
      args.flags.locked = true;
      continue;
    }
    const value = tokens[++i];
    if (!value || value.startsWith("--")) die(`missing value for --${key}`);
    args.flags[key] = value;
  }
  return args;
}

function cwd() {
  return process.cwd();
}

function manifestPath(root = cwd()) {
  return join(root, MANIFEST);
}

function readManifest(root = cwd()) {
  const path = manifestPath(root);
  if (!existsSync(path)) return { version: 1, shares: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeManifest(manifest, root = cwd()) {
  writeFileSync(manifestPath(root), JSON.stringify(manifest, null, 2) + "\n");
}

function normalizeList(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function expandHome(path) {
  if (path === "~") return process.env.HOME || path;
  if (path.startsWith("~/")) return join(process.env.HOME || "", path.slice(2));
  return path;
}

function displayPath(abs) {
  const home = process.env.HOME;
  return home && abs.startsWith(`${home}/`) ? `~/${abs.slice(home.length + 1)}` : abs;
}

function resolvePath(path, base = cwd()) {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

function git(source, args) {
  const proc = spawnSync("git", ["-C", source, ...args], { encoding: "utf8" });
  if (proc.status !== 0) die(`git -C ${source} ${args.join(" ")} failed: ${proc.stderr || proc.stdout}`);
  return proc.stdout.trim();
}

function ensureCleanGitRepo(source) {
  if (!existsSync(join(source, ".git"))) die(`canonical source is not a git repo: ${source}`);
  const status = git(source, ["status", "--porcelain"]);
  if (status) {
    die(`canonical source repo has uncommitted changes: ${source}\n${status}\nCommit/stash/clean it before sharing.`);
  }
}

function gitHead(source) {
  return git(source, ["rev-parse", "HEAD"]);
}

function matchesPattern(rel, pattern) {
  const clean = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  if (!clean) return false;
  if (clean === rel) return true;
  if (rel.startsWith(`${clean}/`)) return true;
  if (clean.includes("*")) {
    const rx = new RegExp(`^${clean.split("*").map(escapeRegex).join(".*")}$`);
    return rx.test(rel);
  }
  return false;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldInclude(rel, include, exclude) {
  const excluded = [...DEFAULT_EXCLUDES, ...exclude].some((pattern) => matchesPattern(rel, pattern) || rel.split("/").includes(pattern));
  if (excluded) return false;
  if (include.length === 0) return true;
  return include.some((pattern) => matchesPattern(rel, pattern));
}

function walkFiles(root, include = [], exclude = []) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).replaceAll("\\", "/");
      if (!shouldInclude(rel, include, exclude)) continue;
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

function hashFiles(root, files) {
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function copyShare(share, repoRoot = cwd()) {
  const source = resolvePath(share.source, repoRoot);
  ensureCleanGitRepo(source);
  const sourceRoot = resolvePath(share.sourcePath || ".", source);
  const targetRoot = resolvePath(share.targetPath, repoRoot);
  const include = share.include || [];
  const exclude = share.exclude || [];
  const files = walkFiles(sourceRoot, include, exclude);
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });
  for (const rel of files) {
    const dest = join(targetRoot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(sourceRoot, rel), dest);
  }
  return { files, hash: hashFiles(targetRoot, files), sourceHead: gitHead(source) };
}

function targetFiles(share, repoRoot = cwd()) {
  const targetRoot = resolvePath(share.targetPath, repoRoot);
  if (!existsSync(targetRoot)) return [];
  return walkFiles(targetRoot, [], []);
}

function findShare(manifest, name) {
  const shares = manifest.shares || [];
  if (!name) return shares;
  const share = shares.find((candidate) => candidate.name === name);
  if (!share) die(`unknown share ${name}`);
  return [share];
}

function cmdAdd(args) {
  const name = args.name;
  if (!name) die("add requires a name");
  const from = args.flags.from;
  const to = args.flags.to;
  if (!from || !to) die("add requires --from and --to");
  const manifest = readManifest();
  if ((manifest.shares || []).some((share) => share.name === name)) die(`share already exists: ${name}`);
  const source = resolvePath(from);
  ensureCleanGitRepo(source);
  const share = {
    name,
    source: displayPath(source),
    sourcePath: ".",
    targetPath: to,
    include: normalizeList(args.flags.include),
    exclude: normalizeList(args.flags.exclude),
  };
  const copied = copyShare(share);
  Object.assign(share, { hash: copied.hash, sourceHead: copied.sourceHead, updatedAt: new Date().toISOString() });
  manifest.shares = [...(manifest.shares || []), share];
  writeManifest(manifest);
  console.log(`added ${name}: ${copied.files.length} files -> ${to}`);
}

function cmdSync(args) {
  const manifest = readManifest();
  const shares = findShare(manifest, args.name);
  for (const share of shares) {
    const copied = copyShare(share);
    Object.assign(share, { hash: copied.hash, sourceHead: copied.sourceHead, updatedAt: new Date().toISOString() });
    console.log(`synced ${share.name}: ${copied.files.length} files, ${copied.hash.slice(0, 12)}`);
  }
  writeManifest(manifest);
}

function cmdCheck(args) {
  const manifest = readManifest();
  const shares = findShare(manifest, args.name);
  let failed = false;
  for (const share of shares) {
    if (!args.flags.locked) ensureCleanGitRepo(resolvePath(share.source));
    const targetRoot = resolvePath(share.targetPath);
    const files = targetFiles(share);
    const hash = existsSync(targetRoot) ? hashFiles(targetRoot, files) : "missing";
    if (hash !== share.hash) {
      failed = true;
      console.error(`stale ${share.name}: expected ${share.hash}, got ${hash}`);
    } else {
      console.log(`ok ${share.name}: ${hash.slice(0, 12)}`);
    }
  }
  if (failed) process.exit(1);
}

function cmdList() {
  const manifest = readManifest();
  for (const share of manifest.shares || []) {
    console.log(`${share.name}\t${share.source} -> ${share.targetPath}\t${String(share.hash || "").slice(0, 12)}`);
  }
}

function cmdDiff(args) {
  const manifest = readManifest();
  const shares = findShare(manifest, args.name);
  for (const share of shares) {
    const source = resolvePath(share.source);
    ensureCleanGitRepo(source);
    const tmp = join(process.env.TMPDIR || "/tmp", `repo-share-${process.pid}-${share.name}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const sourceRoot = resolvePath(share.sourcePath || ".", source);
    const files = walkFiles(sourceRoot, share.include || [], share.exclude || []);
    for (const rel of files) {
      const dest = join(tmp, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(sourceRoot, rel), dest);
    }
    const proc = spawnSync("diff", ["-ru", resolvePath(share.targetPath), tmp], { encoding: "utf8" });
    if (proc.stdout) console.log(proc.stdout);
    if (!proc.stdout) console.log(`no diff ${share.name}`);
    rmSync(tmp, { recursive: true, force: true });
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args.cmd || args.cmd === "help" || args.cmd === "--help" || args.cmd === "-h") usage();
else if (args.cmd === "add") cmdAdd(args);
else if (args.cmd === "sync") cmdSync(args);
else if (args.cmd === "check") cmdCheck(args);
else if (args.cmd === "list") cmdList(args);
else if (args.cmd === "diff") cmdDiff(args);
else die(`unknown command ${args.cmd}`);
