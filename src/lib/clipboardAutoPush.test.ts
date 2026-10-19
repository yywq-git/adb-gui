import { describe, expect, it, vi } from "vitest";
import {
  clipboardAutoPushTarget,
  createClipboardAutoPushBinding,
} from "@/lib/clipboardAutoPush";
import { clipboardContextKey } from "@/lib/clipboardTransfer";
import type {
  ClipboardAutoPushEvent,
  ClipboardAutoPushTarget,
  DeviceInfo,
} from "@/lib/tauri";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const device = (serial: string, state = "device", transport = "usb"): DeviceInfo => ({
  serial,
  state,
  model: serial,
  transport,
  is_network: false,
  alias_identity: null,
  device_id: serial,
});

const target = (serial: string, transport = "usb"): ClipboardAutoPushTarget => ({
  serial,
  contextKey: clipboardContextKey(device(serial, "device", transport)),
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const pending: { target: ClipboardAutoPushTarget; reply: ReturnType<typeof deferred<number>> }[] = [];
  const listeners: ((event: ClipboardAutoPushEvent) => void)[] = [];
  const unlisten = vi.fn();
  const registration = deferred<() => void>();
  const deps = {
    setTarget: vi.fn((next: ClipboardAutoPushTarget) => {
      const reply = deferred<number>();
      pending.push({ target: next, reply });
      return reply.promise;
    }),
    getSupport: vi.fn(async () => true),
    listen: vi.fn((callback: (event: ClipboardAutoPushEvent) => void) => {
      listeners.push(callback);
      return registration.promise;
    }),
    onSupported: vi.fn(),
    onSetupError: vi.fn(),
    onBindStart: vi.fn(),
    onBound: vi.fn(),
    onBindError: vi.fn(),
    onEvent: vi.fn(),
  };
  const binding = createClipboardAutoPushBinding(deps);
  return { binding, deps, pending, listeners, unlisten, registration };
}

describe("clipboard auto push target", () => {
  it("needs the runtime, platform support, the switch and an online device", () => {
    const online = device("a");
    const base = { tauri: true, supported: true, enabled: true, device: online };
    expect(clipboardAutoPushTarget(base)).toEqual({
      serial: "a",
      contextKey: clipboardContextKey(online),
    });
    for (const blocked of [
      { tauri: false },
      { supported: false },
      { supported: null },
      // Unavailable settings reach this as a disabled switch.
      { enabled: false },
      { device: null },
      { device: device("a", "offline") },
      { device: device("a", "unauthorized") },
    ]) {
      expect(clipboardAutoPushTarget({ ...base, ...blocked })).toBeNull();
    }
  });

  it("changes identity with the transport even for the same serial", () => {
    const usb = clipboardAutoPushTarget({ tauri: true, supported: true, enabled: true, device: device("a") });
    const wifi = clipboardAutoPushTarget({ tauri: true, supported: true, enabled: true, device: device("a", "device", "tcp") });
    expect(usb?.serial).toBe(wifi?.serial);
    expect(usb?.contextKey).not.toBe(wifi?.contextKey);
  });
});

describe("clipboard auto push binding", () => {
  it("sends every target change in order and skips an unchanged target", async () => {
    const { binding, deps, pending } = setup();
    binding.start();
    binding.bind(target("a"));
    binding.bind(target("a"));
    binding.bind(target("b"));
    binding.bind(target("a"));
    await flush();
    // One request at a time, so Rust sees A -> B -> A in this order.
    expect(deps.setTarget).toHaveBeenCalledTimes(1);
    for (const [index, generation] of [1, 2, 3].entries()) {
      pending[index].reply.resolve(generation);
      await flush();
    }
    expect(deps.setTarget.mock.calls.map(([next]) => next?.serial)).toEqual(["a", "b", "a"]);
    // Only the last request may bind the store.
    expect(deps.onBound).toHaveBeenCalledExactlyOnceWith(3, true);
    expect(deps.onBindStart).toHaveBeenCalledTimes(3);
  });

  it("ignores a stale failure and reports the latest one", async () => {
    const { binding, deps, pending } = setup();
    binding.start();
    binding.bind(target("a"));
    binding.bind(null);
    await flush();
    pending[0].reply.reject({ code: "clipboard.autoPushUnsupported" });
    await flush();
    expect(deps.onBindError).not.toHaveBeenCalled();
    pending[1].reply.reject(new Error("ipc"));
    await flush();
    expect(deps.onBindError).toHaveBeenCalledOnce();
    expect(deps.onBindError.mock.calls[0][0]).toMatchObject({ code: "unknown" });
    expect(deps.onBound).not.toHaveBeenCalled();
  });

  it("reports a null target as inactive", async () => {
    const { binding, deps, pending } = setup();
    binding.start();
    binding.bind(null);
    await flush();
    pending[0].reply.resolve(4);
    await flush();
    expect(deps.onBound).toHaveBeenCalledExactlyOnceWith(4, false);
  });

  it("does nothing before start", async () => {
    const { binding, deps } = setup();
    binding.bind(target("a"));
    binding.stop();
    await flush();
    expect(deps.setTarget).not.toHaveBeenCalled();
    expect(deps.listen).not.toHaveBeenCalled();
  });

  it("stops the target and releases the listener, including a late registration", async () => {
    const { binding, deps, pending, listeners, unlisten, registration } = setup();
    binding.start();
    binding.bind(target("a"));
    binding.stop();
    registration.resolve(unlisten);
    await flush();
    expect(unlisten).toHaveBeenCalledOnce();
    listeners[0]({ generation: 1, at: 0, kind: "watching" });
    expect(deps.onEvent).not.toHaveBeenCalled();
    pending[0].reply.resolve(1);
    await flush();
    pending[1].reply.resolve(2);
    await flush();
    expect(deps.setTarget.mock.calls.map(([next]) => next)).toEqual([target("a"), null]);
    expect(deps.onBound).toHaveBeenCalledExactlyOnceWith(2, false);
  });

  it("forwards events while running and unlistens on stop", async () => {
    const { binding, deps, listeners, unlisten, registration } = setup();
    binding.start();
    registration.resolve(unlisten);
    await flush();
    const event: ClipboardAutoPushEvent = { generation: 1, at: 5, kind: "pushed" };
    listeners[0](event);
    expect(deps.onEvent).toHaveBeenCalledExactlyOnceWith(event);
    binding.stop();
    expect(unlisten).toHaveBeenCalledOnce();
    listeners[0](event);
    expect(deps.onEvent).toHaveBeenCalledOnce();
  });

  it("keeps StrictMode cleanup ordered before the remounted target", async () => {
    const { binding, deps, pending } = setup();
    binding.start();
    binding.bind(target("a"));
    binding.stop();
    binding.start();
    binding.bind(target("a"));
    for (const [index, generation] of [1, 2, 3].entries()) {
      await flush();
      pending[index].reply.resolve(generation);
    }
    await flush();
    expect(deps.setTarget.mock.calls.map(([next]) => next?.serial ?? null)).toEqual(["a", null, "a"]);
    expect(deps.onBound).toHaveBeenCalledExactlyOnceWith(3, true);
    // Support is a fixed platform fact, queried once per binding.
    expect(deps.getSupport).toHaveBeenCalledOnce();
    expect(deps.listen).toHaveBeenCalledTimes(2);
  });

  it("reports support and listener failures as setup errors", async () => {
    const { binding, deps, registration } = setup();
    deps.getSupport.mockRejectedValueOnce(new Error("ipc"));
    binding.start();
    registration.reject({ code: "shell.listenDevices" });
    await flush();
    expect(deps.onSupported).not.toHaveBeenCalled();
    expect(deps.onSetupError.mock.calls.map(([error]) => error.code)).toEqual(["unknown", "shell.listenDevices"]);
  });

  it("passes the platform answer through", async () => {
    const { binding, deps } = setup();
    deps.getSupport.mockResolvedValueOnce(false);
    binding.start();
    await flush();
    expect(deps.onSupported).toHaveBeenCalledExactlyOnceWith(false);
  });
});
