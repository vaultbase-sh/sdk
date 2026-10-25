/**
 * `vb-types` CLI. Modes:
 *   - Snapshot (default):  --schema=./vaultbase-schema.json
 *   - Live (dev only):     --url=https://api.example.com --admin-token=$TOKEN
 *
 * Output is written atomically (tmp + rename) so a partial run can never
 * leave half-finished types on disk.
 */

import { generateTypes, headerFor, type SnapshotCollection, type SnapshotShape } from "./generate.ts";
import { promises as fs } from "node:fs";
import { resolve, dirname } from "node:path";

interface Args {
  schema?: string;
  url?: string;
  adminToken?: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: "./vaultbase-schema.gen.ts" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--schema=")) args.schema = a.slice("--schema=".length);
    else if (a === "--schema") { const v = argv[++i]; if (v) args.schema = v; }
    else if (a.startsWith("--url=")) args.url = a.slice("--url=".length);
    else if (a === "--url") { const v = argv[++i]; if (v) args.url = v; }
    else if (a.startsWith("--admin-token=")) args.adminToken = a.slice("--admin-token=".length);
    else if (a === "--admin-token") { const v = argv[++i]; if (v) args.adminToken = v; }
    else if (a.startsWith("--out=")) args.out = a.slice("--out=".length);
    else if (a === "--out" || a === "-o") { const next = argv[++i]; if (next) args.out = next; }
    else if (a === "--help" || a === "-h") { printUsage(); process.exit(0); }
  }
  return args;
}

function printUsage(): void {
  process.stdout.write(
    `vb-types — generate TypeScript types from a Vaultbase schema\n\n` +
    `Usage:\n` +
    `  vb-types --schema=./vaultbase-schema.json [--out=./vaultbase-schema.gen.ts]\n` +
    `  vb-types --url=https://api.example.com --admin-token=$TOKEN [--out=./types.gen.ts]\n\n` +
    `Snapshot mode is the default and recommended for CI. Snapshot the schema\n` +
    `via:\n` +
    `  curl -H "Authorization: Bearer $ADMIN" \\\n` +
    `    https://api.example.com/api/v1/admin/migrations/snapshot \\\n` +
    `    > vaultbase-schema.json\n` +
    `Then commit the JSON. Anyone can regen types from it without secrets.\n`,
  );
}

async function loadSnapshot(args: Args): Promise<SnapshotShape> {
  if (args.schema) {
    const raw = await fs.readFile(resolve(args.schema), "utf8");
    return normalize(JSON.parse(raw));
  }
  if (args.url) {
    if (!args.adminToken) throw new Error("--admin-token is required with --url");
    const url = args.url.replace(/\/+$/, "") + "/api/v1/admin/migrations/snapshot";
    const res = await fetch(url, { headers: { Authorization: `Bearer ${args.adminToken}` } });
    if (!res.ok) throw new Error(`schema fetch failed: ${res.status}`);
    return normalize(await res.json());
  }
  throw new Error("Provide --schema=<file> or --url=<host> + --admin-token");
}

/**
 * The server returns either `{ collections: [...] }` or a raw `[...]`.
 * Accept both shapes.
 */
function normalize(data: unknown): SnapshotShape {
  if (Array.isArray(data)) return { collections: data as SnapshotCollection[] };
  if (data && typeof data === "object" && "collections" in (data as object)) {
    return data as SnapshotShape;
  }
  // Server's `migrations/snapshot` may wrap in { data: [...] } via the std envelope.
  if (data && typeof data === "object" && "data" in (data as object)) {
    const inner = (data as { data: unknown }).data;
    return normalize(inner);
  }
  throw new Error("Unrecognized schema shape");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = await loadSnapshot(args);
  // The command as run, minus the token: `--admin-token=…` / `--admin-token …`.
  const argv = process.argv.slice(2).map((a, i, all) =>
    a.startsWith("--admin-token=") ? "--admin-token=$ADMIN_TOKEN"
      : all[i - 1] === "--admin-token" ? "$ADMIN_TOKEN" : a);
  const ts = generateTypes(snapshot, { header: headerFor(["vb-types", ...argv].join(" ")) });
  const outAbs = resolve(args.out);
  await fs.mkdir(dirname(outAbs), { recursive: true });
  const tmp = `${outAbs}.tmp`;
  await fs.writeFile(tmp, ts, "utf8");
  await fs.rename(tmp, outAbs);
  process.stdout.write(`vb-types: wrote ${outAbs} (${snapshot.collections.length} collections)\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`vb-types: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
