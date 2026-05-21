#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const MANIFEST = ".repo-share.json";
const META_FILE = ".repo-share-copy.json";
const RESERVED_TARGET_FILES = new Set([META_FILE]);
const DEFAULT_EXCLUDES = [
  ".git",
  "AGENTS.md",
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
  ".DS_Store",
  "*.tsbuildinfo",
];

interface ParsedFlags {
  locked?: boolean;
  allowDirty?: boolean;
  from?: string;
  to?: string;
  include?: string;
  exclude?: string;
}

interface ParsedArgs {
  cmd: string | undefined;
  name: string | undefined;
  flags: ParsedFlags;
}

interface Share {
  name: string;
  source: string;
  sourcePath: string;
  targetPath: string;
  include: string[];
  exclude: string[];
  hash?: string;
  sourceHead?: string;
  updatedAt?: string;
}

interface Manifest {
  version: number;
  shares: Share[];
}

interface CopyResult {
  files: string[];
  hash: string;
  sourceHead: string;
  updatedAt: string;
}

function die(message: string, code: number = 1): never {
  console.error(`repo-share: ${message}`);
  process.exit(code);
}

function usage(): void {
  console.log(`repo-share

Usage:
  repo-share add <name> --from <canonical-repo> --to <target-path> [--include a,b] [--exclude a,b] [--allow-dirty]
  repo-share sync [name] [--allow-dirty]
  repo-share check [--locked] [--allow-dirty] [name]
  repo-share protect [name]
  repo-share list
  repo-share diff [name] [--allow-dirty]

Invariants:
  - add/sync/check without --locked require the canonical source repo to be a clean git worktree, unless --allow-dirty is set.
  - check --locked does not need the canonical repo; it verifies committed target snapshots against stored hashes.
  - copied target files are marked read-only.
  - check reapplies read-only protection after successful verification, useful after a fresh git checkout.
  - --allow-dirty skips the clean-worktree check and snapshots the working tree as-is; useful when sharing README.md or other informational files from repos that have unrelated wip in other files.
`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const [cmd, maybeName, ...rest] = argv;
  const flags: ParsedFlags = {};
  const args: ParsedArgs = {
    cmd,
    name: maybeName && !maybeName.startsWith("--") ? maybeName : undefined,
    flags,
  };
  const tokens = args.name ? rest : [maybeName, ...rest].flatMap((token) => (token ? [token] : []));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (!token.startsWith("--")) die(`unexpected argument ${token}`);
    const key = token.slice(2);
    if (key === "locked") {
      flags.locked = true;
      continue;
    }
    if (key === "allow-dirty") {
      flags.allowDirty = true;
      continue;
    }
    const value = tokens[++i];
    if (value === undefined || value.startsWith("--")) die(`missing value for --${key}`);
    if (key === "from") flags.from = value;
    else if (key === "to") flags.to = value;
    else if (key === "include") flags.include = value;
    else if (key === "exclude") flags.exclude = value;
    else die(`unknown flag --${key}`);
  }
  return args;
}

function cwd(): string {
  return process.cwd();
}

function manifestPath(root: string = cwd()): string {
  return join(root, MANIFEST);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" ? [item] : []));
}

function readManifest(root: string = cwd()): Manifest {
  const path = manifestPath(root);
  if (!existsSync(path)) return { version: 1, shares: [] };
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    die(`invalid manifest at ${path}: expected an object`);
  }
  const versionVal: unknown = "version" in parsed ? parsed.version : undefined;
  const version = typeof versionVal === "number" ? versionVal : 1;
  const sharesVal: unknown = "shares" in parsed ? parsed.shares : undefined;
  if (sharesVal !== undefined && !Array.isArray(sharesVal)) {
    die(`invalid manifest at ${path}: shares must be an array`);
  }
  const sharesRaw: readonly unknown[] = Array.isArray(sharesVal) ? sharesVal : [];
  const shares: Share[] = sharesRaw.map((entry, index): Share => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      die(`invalid manifest at ${path}: share #${index} is not an object`);
    }
    const nameVal: unknown = "name" in entry ? entry.name : undefined;
    if (typeof nameVal !== "string") die(`invalid manifest at ${path}: share #${index} missing name`);
    const sourceVal: unknown = "source" in entry ? entry.source : undefined;
    if (typeof sourceVal !== "string") die(`invalid manifest at ${path}: share ${nameVal} missing source`);
    const targetPathVal: unknown = "targetPath" in entry ? entry.targetPath : undefined;
    if (typeof targetPathVal !== "string") die(`invalid manifest at ${path}: share ${nameVal} missing targetPath`);
    const sourcePathVal: unknown = "sourcePath" in entry ? entry.sourcePath : undefined;
    const hashVal: unknown = "hash" in entry ? entry.hash : undefined;
    const sourceHeadVal: unknown = "sourceHead" in entry ? entry.sourceHead : undefined;
    const updatedAtVal: unknown = "updatedAt" in entry ? entry.updatedAt : undefined;
    return {
      name: nameVal,
      source: sourceVal,
      sourcePath: typeof sourcePathVal === "string" ? sourcePathVal : ".",
      targetPath: targetPathVal,
      include: stringArray("include" in entry ? entry.include : undefined),
      exclude: stringArray("exclude" in entry ? entry.exclude : undefined),
      hash: typeof hashVal === "string" ? hashVal : undefined,
      sourceHead: typeof sourceHeadVal === "string" ? sourceHeadVal : undefined,
      updatedAt: typeof updatedAtVal === "string" ? updatedAtVal : undefined,
    };
  });
  return { version, shares };
}

function writeManifest(manifest: Manifest, root: string = cwd()): void {
  writeFileSync(manifestPath(root), JSON.stringify(manifest, null, 2) + "\n");
}

function normalizeList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function expandHome(path: string): string {
  if (path === "~") return process.env.HOME || path;
  if (path.startsWith("~/")) return join(process.env.HOME || "", path.slice(2));
  return path;
}

function displayPath(abs: string): string {
  const home = process.env.HOME;
  return home && abs.startsWith(`${home}/`) ? `~/${abs.slice(home.length + 1)}` : abs;
}

function resolvePath(path: string, base: string = cwd()): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

function git(source: string, args: string[]): string {
  const proc = spawnSync("git", ["-C", source, ...args], { encoding: "utf8" });
  if (proc.status !== 0) die(`git -C ${source} ${args.join(" ")} failed: ${proc.stderr || proc.stdout}`);
  return proc.stdout.trim();
}

function ensureGitRepo(source: string): void {
  if (!existsSync(join(source, ".git"))) die(`canonical source is not a git repo: ${source}`);
}

function ensureCleanGitRepo(source: string, allowDirty: boolean = false): void {
  ensureGitRepo(source);
  if (allowDirty) return;
  const status = git(source, ["status", "--porcelain"]);
  if (status) {
    die(
      `canonical source repo has uncommitted changes: ${source}\n${status}\nCommit/stash/clean it before sharing, or pass --allow-dirty to snapshot the working tree as-is.`,
    );
  }
}

function gitHead(source: string): string {
  const proc = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (proc.status !== 0) return "unborn";
  return proc.stdout.trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesPattern(rel: string, pattern: string): boolean {
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

function matchesAny(rel: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(rel, pattern) || rel.split("/").includes(pattern));
}

function isExcluded(rel: string, exclude: string[]): boolean {
  return matchesAny(rel, [...DEFAULT_EXCLUDES, ...exclude]);
}

// Explicit include patterns override the hardcoded DEFAULT_EXCLUDES so a share
// can opt into vendoring a normally-excluded directory like `dist`. User-
// provided `exclude` patterns still win. With no explicit include the share
// behaves as before: walk the whole tree minus the defaults.
function descendsInto(rel: string, include: string[]): boolean {
  return include.some((pattern) => {
    const clean = pattern.replace(/^\.\//, "").replace(/\/$/, "");
    return matchesPattern(rel, clean) || clean.startsWith(`${rel}/`) || clean.includes("*");
  });
}

function shouldInclude(rel: string, include: string[], exclude: string[]): boolean {
  if (matchesAny(rel, exclude)) return false;
  if (include.length > 0) {
    return include.some((pattern) => matchesPattern(rel, pattern));
  }
  return !isExcluded(rel, exclude);
}

function shouldDescend(rel: string, include: string[], exclude: string[]): boolean {
  if (matchesAny(rel, exclude)) return false;
  if (include.length > 0) {
    return descendsInto(rel, include);
  }
  return !isExcluded(rel, exclude);
}

function walkFiles(root: string, include: string[] = [], exclude: string[] = []): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (shouldDescend(rel, include, exclude)) walk(abs);
      } else if (entry.isFile() && shouldInclude(rel, include, exclude)) {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

function hashFiles(root: string, files: string[]): string {
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function ensureNoReservedManagedFiles(files: string[], share: Share): void {
  const reserved = files.filter((file) => RESERVED_TARGET_FILES.has(file));
  if (reserved.length > 0) {
    die(`${share.name} source includes repo-share reserved target file(s): ${reserved.join(", ")}`);
  }
}

function writeTargetMetadata(targetRoot: string, share: Share, copied: CopyResult): void {
  writeFileSync(
    join(targetRoot, META_FILE),
    JSON.stringify(
      {
        version: 1,
        managedBy: "repo-share",
        name: share.name,
        source: share.source,
        sourcePath: share.sourcePath || ".",
        targetPath: share.targetPath,
        sourceHead: copied.sourceHead,
        hash: copied.hash,
        updatedAt: copied.updatedAt,
        managedFiles: copied.files,
      },
      null,
      2,
    ) + "\n",
  );
}

function makeReadOnly(abs: string): void {
  try {
    chmodSync(abs, 0o444);
  } catch {
    // Best-effort guard. Hash checks still catch edits on filesystems that reject chmod.
  }
}

function protectTargetFiles(targetRoot: string, files: string[]): void {
  for (const rel of [...files, META_FILE]) {
    makeReadOnly(join(targetRoot, rel));
  }
}

function copyShare(share: Share, repoRoot: string = cwd(), allowDirty: boolean = false): CopyResult {
  const source = resolvePath(share.source, repoRoot);
  ensureCleanGitRepo(source, allowDirty);
  const sourceRoot = resolvePath(share.sourcePath || ".", source);
  const targetRoot = resolvePath(share.targetPath, repoRoot);
  const include = share.include || [];
  const exclude = share.exclude || [];
  const files = walkFiles(sourceRoot, include, exclude);
  ensureNoReservedManagedFiles(files, share);
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });
  for (const rel of files) {
    const dest = join(targetRoot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(sourceRoot, rel), dest);
  }
  const copied: CopyResult = {
    files,
    hash: hashFiles(targetRoot, files),
    sourceHead: gitHead(source),
    updatedAt: new Date().toISOString(),
  };
  writeTargetMetadata(targetRoot, share, copied);
  protectTargetFiles(targetRoot, files);
  return copied;
}

function targetFiles(share: Share, repoRoot: string = cwd()): string[] {
  const targetRoot = resolvePath(share.targetPath, repoRoot);
  if (!existsSync(targetRoot)) return [];
  return walkFiles(targetRoot, [], []).filter((file) => !RESERVED_TARGET_FILES.has(file));
}

function hasTargetMetadata(share: Share, repoRoot: string = cwd()): boolean {
  const targetRoot = resolvePath(share.targetPath, repoRoot);
  return existsSync(join(targetRoot, META_FILE));
}

function protectShareTarget(share: Share, repoRoot: string = cwd()): number {
  const targetRoot = resolvePath(share.targetPath, repoRoot);
  if (!existsSync(targetRoot)) die(`missing target for ${share.name}: ${share.targetPath}`);
  const files = targetFiles(share, repoRoot);
  protectTargetFiles(targetRoot, files);
  return files.length;
}

function findShare(manifest: Manifest, name: string | undefined): Share[] {
  const shares = manifest.shares;
  if (!name) return shares;
  const share = shares.find((candidate) => candidate.name === name);
  if (!share) die(`unknown share ${name}`);
  return [share];
}

function cmdAdd(args: ParsedArgs): void {
  const name = args.name;
  if (!name) die("add requires a name");
  const from = args.flags.from;
  const to = args.flags.to;
  if (!from || !to) die("add requires --from and --to");
  const manifest = readManifest();
  if (manifest.shares.some((share) => share.name === name)) die(`share already exists: ${name}`);
  const source = resolvePath(from);
  const allowDirty = Boolean(args.flags.allowDirty);
  ensureCleanGitRepo(source, allowDirty);
  const share: Share = {
    name,
    source: displayPath(source),
    sourcePath: ".",
    targetPath: to,
    include: normalizeList(args.flags.include),
    exclude: normalizeList(args.flags.exclude),
  };
  const copied = copyShare(share, cwd(), allowDirty);
  share.hash = copied.hash;
  share.sourceHead = copied.sourceHead;
  share.updatedAt = copied.updatedAt;
  manifest.shares = [...manifest.shares, share];
  writeManifest(manifest);
  console.log(`added ${name}: ${copied.files.length} files -> ${to}`);
}

function cmdSync(args: ParsedArgs): void {
  const manifest = readManifest();
  const shares = findShare(manifest, args.name);
  const allowDirty = Boolean(args.flags.allowDirty);
  for (const share of shares) {
    const copied = copyShare(share, cwd(), allowDirty);
    share.hash = copied.hash;
    share.sourceHead = copied.sourceHead;
    share.updatedAt = copied.updatedAt;
    console.log(`synced ${share.name}: ${copied.files.length} files, ${copied.hash.slice(0, 12)}`);
  }
  writeManifest(manifest);
}

function cmdCheck(args: ParsedArgs): void {
  const manifest = readManifest();
  const shares = findShare(manifest, args.name);
  let failed = false;
  for (const share of shares) {
    if (!args.flags.locked) ensureCleanGitRepo(resolvePath(share.source), Boolean(args.flags.allowDirty));
    const targetRoot = resolvePath(share.targetPath);
    const files = targetFiles(share);
    const hash = existsSync(targetRoot) ? hashFiles(targetRoot, files) : "missing";
    if (hash !== share.hash) {
      failed = true;
      console.error(`stale ${share.name}: expected ${share.hash ?? "<unset>"}, got ${hash}`);
    } else if (!hasTargetMetadata(share)) {
      failed = true;
      console.error(`missing metadata ${share.name}: missing ${META_FILE} in ${share.targetPath}`);
    } else {
      protectShareTarget(share);
      console.log(`ok ${share.name}: ${hash.slice(0, 12)}`);
    }
  }
  if (failed) process.exit(1);
}

function cmdProtect(args: ParsedArgs): void {
  const manifest = readManifest();
  const shares = findShare(manifest, args.name);
  for (const share of shares) {
    const count = protectShareTarget(share);
    console.log(`protected ${share.name}: ${count} files -> ${share.targetPath}`);
  }
}

function cmdList(): void {
  const manifest = readManifest();
  for (const share of manifest.shares) {
    console.log(`${share.name}\t${share.source} -> ${share.targetPath}\t${(share.hash ?? "").slice(0, 12)}`);
  }
}

function cmdDiff(args: ParsedArgs): void {
  const manifest = readManifest();
  const shares = findShare(manifest, args.name);
  for (const share of shares) {
    const source = resolvePath(share.source);
    ensureCleanGitRepo(source, Boolean(args.flags.allowDirty));
    const tmp = join(process.env.TMPDIR || "/tmp", `repo-share-${process.pid}-${share.name}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const sourceRoot = resolvePath(share.sourcePath || ".", source);
    const files = walkFiles(sourceRoot, share.include, share.exclude);
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

const parsedArgs = parseArgs(process.argv.slice(2));
if (!parsedArgs.cmd || parsedArgs.cmd === "help" || parsedArgs.cmd === "--help" || parsedArgs.cmd === "-h") usage();
else if (parsedArgs.cmd === "add") cmdAdd(parsedArgs);
else if (parsedArgs.cmd === "sync") cmdSync(parsedArgs);
else if (parsedArgs.cmd === "check") cmdCheck(parsedArgs);
else if (parsedArgs.cmd === "protect") cmdProtect(parsedArgs);
else if (parsedArgs.cmd === "list") cmdList();
else if (parsedArgs.cmd === "diff") cmdDiff(parsedArgs);
else die(`unknown command ${parsedArgs.cmd}`);
