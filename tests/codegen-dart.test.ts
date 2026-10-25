import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateDart } from "../src/codegen/dart.ts";

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dir, "fixtures/schema-all-types.json"), "utf8"),
);

describe("generateDart", () => {
  const out = generateDart(fixture);

  it("emits a record class per collection, typed getters per field", () => {
    expect(out).toContain("class PostsRecord extends RecordModel {");
    expect(out).toContain("String get title => getString('title');");
    expect(out).toContain("String? get body => data['body'] as String?;");
    expect(out).toContain("num get rating => data['rating'] as num? ?? 0;");
    expect(out).toContain("List<String> get tags => getList<String>('tags');");
    expect(out).toContain("DateTime? get publishAt => getDate('publish_at');");
    expect(out).toContain("({double lat, double lng})? get place => _geoPoint(data['place']);");
    expect(out).toContain("for (final v in getList<num>('embedding')) v.toDouble()");
  });

  it("renames fields that clash with keywords or RecordModel members", () => {
    expect(out).toContain("get classField => data['class']");
    expect(out).toContain("get dataField => data['data']");
    expect(out).toContain("get toJsonField => data['to_json']");
    expect(out).not.toMatch(/get data =>/);
  });

  it("never emits password fields", () => {
    expect(out).not.toContain("secret");
  });

  it("auth records carry the account flags; their create points at register", () => {
    expect(out).toContain("bool get emailVerified => getBool('email_verified');");
    expect(out).toContain("bool get isAnonymous => getBool('is_anonymous');");
    expect(out).toContain("required this.email, required this.password");
    expect(out).toContain("auth.collection('users').register(u.email, u.password, data: u.toJson())");
    expect(out).not.toMatch(/get verified\b/);
  });

  it("views and singletons have no create class; singletons use singletonOf", () => {
    expect(out).toContain("class PostStatsRecord");
    expect(out).not.toContain("PostStatsCreate");
    expect(out).not.toContain("SiteSettingsCreate");
    expect(out).toContain("Singleton<SiteSettingsRecord> get siteSettings =>");
    expect(out).toContain("vb.singletonOf('site_settings', SiteSettingsRecord.fromJson)");
    // A singleton's fields start empty, required or not.
    expect(out).toContain("String? get headline");
  });

  it("create classes omit unset fields and encode dates and geo points", () => {
    expect(out).toContain("if (body != null) 'body': body!");
    expect(out).toContain("'publish_at': publishAt!.toUtc().toIso8601String()");
    expect(out).toContain("'place': {'lat': place!.lat, 'lng': place!.lng}");
    // Autodate fields are the server's to set.
    expect(out).not.toMatch(/this\.edited/);
  });

  it("dedupes colliding class and accessor names", () => {
    const dup = generateDart({
      collections: [
        { name: "my_posts", type: "base", fields: [] },
        { name: "myPosts", type: "base", fields: [] },
        { name: "hashCode", type: "base", fields: [] },
      ],
    });
    expect(dup).toContain("class MyPostsRecord ");
    expect(dup).toContain("class MyPosts2Record ");
    expect(dup).toContain("get myPosts =>");
    expect(dup).toContain("get myPosts2 =>");
    expect(dup).toContain("get hashCode2 =>");
  });
});

describe("vb-types --lang dart", () => {
  it("writes Dart to the given path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-types-dart-"));
    try {
      const outFile = join(dir, "schema.g.dart");
      const proc = Bun.spawnSync([
        "bun", resolve(import.meta.dir, "../src/codegen/bin.ts"),
        "--lang", "dart",
        `--schema=${resolve(import.meta.dir, "fixtures/schema-all-types.json")}`,
        `--out=${outFile}`,
      ]);
      expect(proc.exitCode).toBe(0);
      const written = readFileSync(outFile, "utf8");
      expect(written).toContain("// Regenerate via:  vb-types --lang dart");
      expect(written).toContain("extension VaultbaseSchema on Vaultbase");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an unknown language", () => {
    const proc = Bun.spawnSync([
      "bun", resolve(import.meta.dir, "../src/codegen/bin.ts"), "--lang=kotlin", "--schema=x.json",
    ]);
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("--lang must be ts or dart");
  });
});
