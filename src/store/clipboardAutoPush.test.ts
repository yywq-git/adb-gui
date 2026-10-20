import { describe, expect, it } from "vitest";
import {
  clipboardAutoPushStatus,
  createClipboardAutoPushStore,
  type ClipboardAutoPushInputs,
} from "@/store/clipboardAutoPush";

const locked = { code: "clipboard.locked" };

describe("clipboard auto push runtime store", () => {
  it("applies events of the bound generation and ignores older generations", () => {
    const store = createClipboardAutoPushStore();
    store.getState().beginBind();
    store.getState().bound(2, true);
    expect(store.getState().runtime).toEqual({ kind: "watching" });
    store.getState().receive({ generation: 1, at: 10, kind: "pushed" });
    expect(store.getState().runtime).toEqual({ kind: "watching" });
    store.getState().receive({ generation: 2, at: 11, kind: "pushing" });
    expect(store.getState().runtime).toEqual({ kind: "pushing" });
    store.getState().receive({ generation: 2, at: 12, kind: "pushed" });
    expect(store.getState().runtime).toEqual({ kind: "pushed", at: 12 });
    store.getState().receive({ generation: 2, at: 13, kind: "skipped", reason: "too_large" });
    expect(store.getState().runtime).toEqual({ kind: "skipped", reason: "too_large" });
    store.getState().receive({ generation: 2, at: 14, kind: "failed", error: locked });
    expect(store.getState().runtime).toEqual({ kind: "failed", error: locked });
  });

  it("keeps an event that arrives before its command returns", () => {
    const store = createClipboardAutoPushStore();
    store.getState().beginBind();
    store.getState().receive({ generation: 5, at: 1, kind: "watching" });
    store.getState().receive({ generation: 5, at: 2, kind: "pushed" });
    store.getState().bound(5, true);
    expect(store.getState().runtime).toEqual({ kind: "pushed", at: 2 });
    expect(store.getState().early).toBeNull();
  });

  it("drops an early event from a generation that was never bound", () => {
    const store = createClipboardAutoPushStore();
    store.getState().beginBind();
    store.getState().receive({ generation: 5, at: 1, kind: "failed", error: locked });
    store.getState().bound(6, true);
    expect(store.getState().runtime).toEqual({ kind: "watching" });
    store.getState().receive({ generation: 5, at: 2, kind: "pushed" });
    expect(store.getState().runtime).toEqual({ kind: "watching" });
  });

  it("does not carry the previous target's result into a new binding", () => {
    const store = createClipboardAutoPushStore();
    store.getState().bound(1, true);
    store.getState().receive({ generation: 1, at: 1, kind: "pushed" });
    store.getState().beginBind();
    expect(store.getState().runtime).toBeNull();
    store.getState().receive({ generation: 1, at: 2, kind: "failed", error: locked });
    store.getState().bound(2, false);
    expect(store.getState().runtime).toBeNull();
  });

  it("records a failed binding and a setup failure", () => {
    const store = createClipboardAutoPushStore();
    store.getState().bindFailed(locked);
    expect(store.getState()).toMatchObject({ generation: null, runtime: { kind: "failed", error: locked } });
    store.getState().setupFailed(locked);
    store.getState().setSupported(false);
    expect(store.getState()).toMatchObject({ supported: false, setupError: locked });
  });

  it("does not notify subscribers for an ignored event", () => {
    const store = createClipboardAutoPushStore();
    store.getState().bound(3, true);
    const before = store.getState();
    store.getState().receive({ generation: 2, at: 1, kind: "pushed" });
    expect(store.getState()).toBe(before);
  });
});

describe("clipboard auto push status", () => {
  const base: ClipboardAutoPushInputs = {
    tauri: true,
    supported: true,
    settingsAvailable: true,
    enabled: true,
    deviceOnline: true,
    setupError: null,
    runtime: { kind: "pushed", at: 1 },
  };

  it("explains why pushing is not active before showing runtime results", () => {
    expect(clipboardAutoPushStatus(base)).toEqual({ kind: "pushed", at: 1 });
    expect(clipboardAutoPushStatus({ ...base, tauri: false })).toEqual({ kind: "off" });
    expect(clipboardAutoPushStatus({ ...base, supported: false, enabled: false })).toEqual({ kind: "unsupported" });
    expect(clipboardAutoPushStatus({ ...base, settingsAvailable: false, enabled: false })).toEqual({ kind: "settingsUnavailable" });
    expect(clipboardAutoPushStatus({ ...base, enabled: false })).toEqual({ kind: "off" });
    expect(clipboardAutoPushStatus({ ...base, setupError: locked })).toEqual({ kind: "failed", error: locked });
    expect(clipboardAutoPushStatus({ ...base, supported: null })).toBeNull();
    expect(clipboardAutoPushStatus({ ...base, deviceOnline: false })).toEqual({ kind: "waitingDevice" });
    expect(clipboardAutoPushStatus({ ...base, runtime: null })).toBeNull();
  });
});
