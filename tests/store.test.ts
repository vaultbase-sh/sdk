import { describe, expect, it } from "bun:test";
import { MemoryAuthStore } from "../src/auth/store.ts";

describe("MemoryAuthStore", () => {
  it("round-trips set + get", () => {
    const s = new MemoryAuthStore();
    s.set({ token: "t", record: { id: "u1" } });
    expect(s.get()?.token).toBe("t");
    s.set(null);
    expect(s.get()).toBeNull();
  });

  it("notifies onChange listeners", () => {
    const s = new MemoryAuthStore();
    let calls = 0;
    const off = s.onChange(() => calls++);
    s.set({ token: "x" });
    s.set(null);
    off();
    s.set({ token: "y" });
    expect(calls).toBe(2);
  });
});

describe("web storage stores", () => {
  // A stand-in for window: storage maps plus an event target for `storage`.
  function fakeWindow() {
    const mk = () => {
      const m = new Map<string, string>();
      return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
    };
    const handlers = new Set<(e: { key?: string }) => void>();
    const g = globalThis as Record<string, unknown>;
    const saved = { localStorage: g.localStorage, sessionStorage: g.sessionStorage, addEventListener: g.addEventListener, removeEventListener: g.removeEventListener };
    g.localStorage = mk();
    g.sessionStorage = mk();
    g.addEventListener = (t: string, h: (e: { key?: string }) => void) => { if (t === "storage") handlers.add(h); };
    g.removeEventListener = (t: string, h: (e: { key?: string }) => void) => { if (t === "storage") handlers.delete(h); };
    return {
      otherTabWrote: (key: string) => { for (const h of handlers) h({ key }); },
      restore: () => { Object.assign(g, saved); },
    };
  }

  it("LocalStorageAuthStore notifies on a same-tab set (sign-in) and on other tabs", async () => {
    const w = fakeWindow();
    try {
      const { LocalStorageAuthStore } = await import("../src/auth/store.ts");
      const s = new LocalStorageAuthStore();
      let calls = 0;
      const off = s.onChange(() => calls++);
      s.set({ token: "t", record: { id: "u1" } });
      expect(calls).toBe(1);
      expect(s.get()?.token).toBe("t");
      w.otherTabWrote("vaultbase_auth");
      w.otherTabWrote("something_else");
      expect(calls).toBe(2);
      off();
      s.set(null);
      w.otherTabWrote("vaultbase_auth");
      expect(calls).toBe(2);
    } finally { w.restore(); }
  });

  it("SessionStorageAuthStore notifies on set", async () => {
    const w = fakeWindow();
    try {
      const { SessionStorageAuthStore } = await import("../src/auth/store.ts");
      const s = new SessionStorageAuthStore();
      let calls = 0;
      s.onChange(() => calls++);
      s.set({ token: "t" });
      s.set(null);
      expect(calls).toBe(2);
    } finally { w.restore(); }
  });
});
