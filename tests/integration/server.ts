/**
 * Spins up a real Vaultbase server in-process for integration tests.
 *
 * IMPORTANT: This file is dev-only. The SDK ships without `tests/` so the
 * sibling-dir import path here only resolves in the monorepo. When the SDK
 * is published, `tests/` is excluded; consumers never hit this code.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER_ROOT = join(__dirname, "..", "..", "..", "vaultbase");

interface Started {
  baseUrl: string;
  cleanup: () => void;
  /** Pre-seeded admin credentials. */
  adminEmail: string;
  adminPassword: string;
  adminToken: string;
  jwtSecret: string;
}

let cachedImports: {
  loadConfig: typeof import("../../../vaultbase/src/config.ts").loadConfig;
  initDb: typeof import("../../../vaultbase/src/db/client.ts").initDb;
  closeDb: typeof import("../../../vaultbase/src/db/client.ts").closeDb;
  runMigrations: typeof import("../../../vaultbase/src/db/migrate.ts").runMigrations;
  createServer: typeof import("../../../vaultbase/src/server.ts").createServer;
  setSetting: typeof import("../../../vaultbase/src/api/settings.ts").setSetting;
} | null = null;

async function loadServer(): Promise<NonNullable<typeof cachedImports>> {
  if (cachedImports) return cachedImports;
  const [config, dbClient, migrate, server, settings] = await Promise.all([
    import(`${SERVER_ROOT}/src/config.ts`),
    import(`${SERVER_ROOT}/src/db/client.ts`),
    import(`${SERVER_ROOT}/src/db/migrate.ts`),
    import(`${SERVER_ROOT}/src/server.ts`),
    import(`${SERVER_ROOT}/src/api/settings.ts`),
  ]);
  cachedImports = {
    loadConfig: config.loadConfig,
    initDb: dbClient.initDb,
    closeDb: dbClient.closeDb,
    runMigrations: migrate.runMigrations,
    createServer: server.createServer,
    setSetting: settings.setSetting,
  };
  return cachedImports;
}

export async function startTestServer(): Promise<Started> {
  const dataDir = mkdtempSync(join(tmpdir(), "vbsdk-it-"));
  process.env["VAULTBASE_DATA_DIR"] = dataDir;
  // Deterministic secret so signed JWTs survive multiple verifies in test.
  process.env["VAULTBASE_JWT_SECRET"] = "test-jwt-secret-do-not-use-in-prod";
  // Disable rate limiting so test bursts don't 429 themselves.
  process.env["VAULTBASE_RATE_ENABLED"] = "0";
  // First-admin setup needs a key (server 0.17); use a known one.
  process.env["VAULTBASE_SETUP_KEY"] = "integration-setup-key";

  const mod = await loadServer();
  const cfg = await mod.loadConfig();
  mod.initDb(`file:${cfg.dbPath}`);
  await mod.runMigrations();
  // Allow any origin for realtime — test runners do not match a fixed Origin.
  mod.setSetting("security.allowed_origins", "*");

  const elysia = mod.createServer(cfg);
  // Bun port 0 → random free port. Elysia forwards `.server.port` after listen.
  elysia.listen(0);
  // Elysia exposes the underlying Bun server at `.server`.
  const port = (elysia as unknown as { server?: { port: number } }).server?.port ?? 0;
  if (!port) throw new Error("server failed to bind a port");
  const baseUrl = `http://localhost:${port}`;

  // Seed the admin via /api/v1/admin/setup so subsequent SDK calls have a real
  // principal to log in as.
  const adminEmail = "admin@test.local";
  const adminPassword = "integration-test-password";
  const setup = await fetch(`${baseUrl}/api/v1/admin/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-key": "integration-setup-key" },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  if (!setup.ok) throw new Error(`setup failed: ${setup.status} ${await setup.text()}`);

  const login = await fetch(`${baseUrl}/api/v1/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const loginBody = await login.json() as { data: { token: string } };
  const adminToken = loginBody.data.token;

  const cleanup = () => {
    try { elysia.stop?.(); } catch { /* noop */ }
    try { mod.closeDb(); } catch { /* noop */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }
  };

  return { baseUrl, cleanup, adminEmail, adminPassword, adminToken, jwtSecret: cfg.jwtSecret };
}

/**
 * Bypass for environments where the server source is not present (e.g.,
 * standalone clone of the SDK). Tests should `it.skipIf(!serverAvailable())`.
 */
export function serverAvailable(): boolean {
  try {
    require.resolve(`${SERVER_ROOT}/src/server.ts`);
    return true;
  } catch {
    return false;
  }
}
