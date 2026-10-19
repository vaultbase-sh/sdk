/**
 * `vb-migrate` CLI — diff / apply schema snapshots against a remote
 * Vaultbase server.
 *
 * Usage:
 *   vb-migrate pull  --url=<host> --admin-token=$T [--out=./schema.json]
 *   vb-migrate diff  --url=<host> --admin-token=$T --schema=./schema.json
 *   vb-migrate apply --url=<host> --admin-token=$T --schema=./schema.json
 *                    [--mode=additive|sync] [--yes] [--dry-run]
 *
 * `apply` always runs a diff first and prints the plan. Without `--yes` it
 * exits before writing if any `update`/`create` actions are pending — so
 * CI scripts that want non-interactive behaviour must pass `--yes`.
 */

import { promises as fs } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  pullSnapshot,
  diffSnapshot,
  applySnapshot,
  type SnapshotEnvelope,
  type DiffEntry,
  type ApplyMode,
} from "./index.ts";

interface Args {
  cmd: "pull" | "diff" | "apply" | "help";
  url?: string;
  adminToken?: string;
  schema?: string;
  out?: string;
  mode?: ApplyMode;
  yes: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { cmd: "help", yes: false, dryRun: false };
  const cmd = argv[0];
  if (cmd === "pull" || cmd === "diff" || cmd === "apply" || cmd === "help") {
    out.cmd = cmd;
  } else if (cmd === "--help" || cmd === "-h" || cmd === undefined) {
    out.cmd = "help";
  } else {
    throw new Error(`Unknown command: ${cmd}`);
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--url=")) out.url = a.slice("--url=".length);
    else if (a === "--url") { const v = argv[++i]; if (v) out.url = v; }
    else if (a.startsWith("--admin-token=")) out.adminToken = a.slice("--admin-token=".length);
    else if (a === "--admin-token") { const v = argv[++i]; if (v) out.adminToken = v; }
    else if (a.startsWith("--schema=")) out.schema = a.slice("--schema=".length);
    else if (a === "--schema") { const v = argv[++i]; if (v) out.schema = v; }
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length);
    else if (a === "--out" || a === "-o") { const v = argv[++i]; if (v) out.out = v; }
    else if (a.startsWith("--mode=")) out.mode = a.slice("--mode=".length) as ApplyMode;
    else if (a === "--mode") { const v = argv[++i]; if (v) out.mode = v as ApplyMode; }
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.cmd = "help";
    else throw new Error(`Unknown flag: ${a}`);
  }
  return out;
}

function printUsage(): void {
  process.stdout.write(
    `vb-migrate — diff / apply Vaultbase schema snapshots\n\n` +
    `Commands:\n` +
    `  pull   Download current schema from a server.\n` +
    `         vb-migrate pull --url=<host> --admin-token=$T --out=./schema.json\n\n` +
    `  diff   Compare a local snapshot with a server's current schema.\n` +
    `         vb-migrate diff --url=<host> --admin-token=$T --schema=./schema.json\n\n` +
    `  apply  Apply a snapshot to a server. Always diffs first.\n` +
    `         vb-migrate apply --url=<host> --admin-token=$T --schema=./schema.json\n` +
    `                          [--mode=additive|sync] [--yes] [--dry-run]\n\n` +
    `Modes:\n` +
    `  additive (default) — only creates missing collections/fields. Never updates.\n` +
    `  sync               — also updates existing collections to match the snapshot.\n\n` +
    `Flags:\n` +
    `  --yes / -y       skip the confirmation prompt (required in non-TTY contexts).\n` +
    `  --dry-run        run diff but do not call apply.\n`,
  );
}

async function loadSchema(p: string): Promise<SnapshotEnvelope> {
  const raw = await fs.readFile(resolve(p), "utf8");
  const parsed = JSON.parse(raw);
  // Accept either {generated_at,version,collections} or a wrapper {data: ...}.
  const inner = parsed && typeof parsed === "object" && "data" in parsed
    ? (parsed as { data: SnapshotEnvelope }).data
    : (parsed as SnapshotEnvelope);
  if (!inner || typeof inner !== "object" || !Array.isArray((inner as SnapshotEnvelope).collections)) {
    throw new Error("Schema file does not look like a valid snapshot");
  }
  return inner as SnapshotEnvelope;
}

function summarizeDiff(entries: DiffEntry[]): { creates: DiffEntry[]; updates: DiffEntry[]; unchanged: DiffEntry[]; removes: DiffEntry[] } {
  return {
    creates: entries.filter((e) => e.kind === "create"),
    updates: entries.filter((e) => e.kind === "update"),
    unchanged: entries.filter((e) => e.kind === "unchanged"),
    removes: entries.filter((e) => e.kind === "remove"),
  };
}

function printDiff(entries: DiffEntry[]): void {
  const { creates, updates, unchanged, removes } = summarizeDiff(entries);
  process.stdout.write(`Diff:\n`);
  process.stdout.write(`  creates:   ${creates.length}\n`);
  process.stdout.write(`  updates:   ${updates.length}\n`);
  process.stdout.write(`  unchanged: ${unchanged.length}\n\n`);
  for (const c of creates) process.stdout.write(`  + ${c.collection}\n`);
  for (const u of updates) {
    process.stdout.write(`  ~ ${u.collection}\n`);
    for (const ch of u.changes ?? []) process.stdout.write(`      ${ch}\n`);
  }
  for (const r of removes) process.stdout.write(`  - ${r.collection}  (only on the server; not deleted)\n`);
}

function requireFlag<T>(name: string, v: T | undefined): T {
  if (v === undefined || v === null || v === "") {
    throw new Error(`Missing required flag: --${name}`);
  }
  return v;
}

async function cmdPull(args: Args): Promise<void> {
  const url = requireFlag("url", args.url);
  const adminToken = requireFlag("admin-token", args.adminToken);
  const snap = await pullSnapshot({ url, adminToken });
  const outPath = resolve(args.out ?? "./vaultbase-schema.json");
  await fs.mkdir(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(snap, null, 2), "utf8");
  await fs.rename(tmp, outPath);
  process.stdout.write(`vb-migrate: wrote ${outPath} (${snap.collections.length} collections)\n`);
}

async function cmdDiff(args: Args): Promise<void> {
  const url = requireFlag("url", args.url);
  const adminToken = requireFlag("admin-token", args.adminToken);
  const schemaPath = requireFlag("schema", args.schema);
  const snap = await loadSchema(schemaPath);
  const entries = await diffSnapshot(snap, { url, adminToken });
  printDiff(entries);
}

async function cmdApply(args: Args): Promise<void> {
  const url = requireFlag("url", args.url);
  const adminToken = requireFlag("admin-token", args.adminToken);
  const schemaPath = requireFlag("schema", args.schema);
  const snap = await loadSchema(schemaPath);
  const entries = await diffSnapshot(snap, { url, adminToken });
  printDiff(entries);

  const { creates, updates } = summarizeDiff(entries);
  const hasChanges = creates.length > 0 || updates.length > 0;
  if (!hasChanges) {
    process.stdout.write(`vb-migrate: nothing to apply.\n`);
    return;
  }

  if (args.dryRun) {
    process.stdout.write(`vb-migrate: --dry-run — exiting before apply.\n`);
    return;
  }
  if (!args.yes) {
    process.stdout.write(`\nRefusing to apply without --yes (or run with --dry-run to inspect only).\n`);
    process.exit(2);
  }
  const result = await applySnapshot(snap, { url, adminToken, mode: args.mode ?? "additive" });
  process.stdout.write(`\nApplied (mode=${args.mode ?? "additive"}):\n`);
  process.stdout.write(`  created: ${result.created.length}  ${result.created.join(", ")}\n`);
  process.stdout.write(`  updated: ${result.updated.length}  ${result.updated.join(", ")}\n`);
  process.stdout.write(`  skipped: ${result.skipped.length}\n`);
  if (result.errors.length) {
    process.stdout.write(`  errors:  ${result.errors.length}\n`);
    for (const e of result.errors) process.stdout.write(`    - ${e.collection}: ${e.message}\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === "help") { printUsage(); return; }
  if (args.cmd === "pull") return cmdPull(args);
  if (args.cmd === "diff") return cmdDiff(args);
  if (args.cmd === "apply") return cmdApply(args);
}

main().catch((e: unknown) => {
  process.stderr.write(`vb-migrate: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
