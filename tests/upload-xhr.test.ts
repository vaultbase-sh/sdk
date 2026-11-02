/**
 * Uploads with a progress callback go over XMLHttpRequest. They now share the
 * client's handling: the server's error message, credentials as configured,
 * and a 401 refreshes and retries.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { HttpClient } from "../src/client.ts";
import { MemoryAuthStore } from "../src/auth/store.ts";
import { Files } from "../src/files.ts";
import { VaultbaseError } from "../src/errors.ts";

class FakeXhr {
  static next: { status: number; body: unknown } = { status: 200, body: { data: {} } };
  static last: FakeXhr | null = null;
  withCredentials = true;
  status = 0;
  responseText = "";
  upload: { onprogress?: (e: { loaded: number; total: number }) => void } = {};
  onload?: () => void; onerror?: () => void; onabort?: () => void;
  open() {}
  setRequestHeader() {}
  getResponseHeader(n: string) { return n.toLowerCase() === "content-type" ? "application/json" : null; }
  abort() { this.onabort?.(); }
  send() {
    FakeXhr.last = this;
    setTimeout(() => { this.status = FakeXhr.next.status; this.responseText = JSON.stringify(FakeXhr.next.body); this.onload?.(); }, 1);
  }
}

const g = globalThis as unknown as { XMLHttpRequest?: unknown };
const saved = g.XMLHttpRequest;
afterEach(() => { g.XMLHttpRequest = saved; });

const files = (withCredentials = true) => new Files(new HttpClient({
  baseUrl: "http://localhost", authStore: new MemoryAuthStore(), withCredentials,
  fetch: (async () => new Response("{}", { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
}));

describe("upload with onProgress", () => {
  it("reports the server's message on a 422 and follows withCredentials", async () => {
    g.XMLHttpRequest = FakeXhr;
    FakeXhr.next = { status: 422, body: { error: "File too large", code: 422, details: { file: "max 5 MB" } } };
    const err = await files(false).upload("posts", "p1", "cover", new File(["x"], "a.png"), { onProgress: () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(VaultbaseError);
    expect((err as VaultbaseError).message).toBe("File too large");
    expect(FakeXhr.last!.withCredentials).toBe(false);
  });

  it("a 413 says so instead of a bare HTTP status", async () => {
    g.XMLHttpRequest = FakeXhr;
    FakeXhr.next = { status: 413, body: { error: "Upload over the size limit", code: 413 } };
    const err = await files().upload("posts", "p1", "cover", new File(["x"], "a.png"), { onProgress: () => {} }).catch((e) => e);
    expect((err as VaultbaseError).message).toContain("size limit");
  });
});
