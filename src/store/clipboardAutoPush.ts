import type { AppErrorPayload } from "@/i18n/errors";
import { create } from "zustand";
import type { ClipboardAutoPushEvent } from "@/lib/tauri";

export type ClipboardAutoPushRuntime =
  | { kind: "watching" }
  | { kind: "pushing" }
  | { kind: "pushed"; at: number }
  | { kind: "skipped"; reason: "no_text" | "too_large" }
  | { kind: "failed"; error: AppErrorPayload };

export type ClipboardAutoPushStatus =
  | { kind: "off" }
  | { kind: "unsupported" }
  | { kind: "settingsUnavailable" }
  | { kind: "waitingDevice" }
  | ClipboardAutoPushRuntime;

interface ClipboardAutoPushState {
  supported: boolean | null;
  // A failed support query or status listener: no progress can be reported.
  setupError: AppErrorPayload | null;
  generation: number | null;
  runtime: ClipboardAutoPushRuntime | null;
  // The newest event of a generation whose command has not returned yet.
  early: ClipboardAutoPushEvent | null;
  setSupported: (supported: boolean) => void;
  setupFailed: (error: AppErrorPayload) => void;
  beginBind: () => void;
  bound: (generation: number, active: boolean) => void;
  bindFailed: (error: AppErrorPayload) => void;
  receive: (event: ClipboardAutoPushEvent) => void;
}

function runtimeOf(event: ClipboardAutoPushEvent): ClipboardAutoPushRuntime {
  switch (event.kind) {
    case "watching":
    case "pushing":
      return { kind: event.kind };
    case "pushed":
      return { kind: "pushed", at: event.at };
    case "skipped":
      return { kind: "skipped", reason: event.reason };
    case "failed":
      return { kind: "failed", error: event.error };
  }
}

// Runtime only: generations and results describe this launch and are never persisted.
export function createClipboardAutoPushStore() {
  return create<ClipboardAutoPushState>((set) => ({
    supported: null,
    setupError: null,
    generation: null,
    runtime: null,
    early: null,
    setSupported: (supported) => set({ supported }),
    setupFailed: (setupError) => set({ setupError }),
    // A new target never shows the previous target's result.
    beginBind: () => set({ generation: null, runtime: null, early: null }),
    bound: (generation, active) =>
      set((state) => {
        const early = state.early?.generation === generation ? state.early : null;
        return {
          generation,
          // The command returns only after Rust recorded the baseline and started watching.
          runtime: active ? (early ? runtimeOf(early) : { kind: "watching" }) : null,
          early: null,
        };
      }),
    bindFailed: (error) =>
      set({ generation: null, runtime: { kind: "failed", error }, early: null }),
    receive: (event) =>
      set((state) => {
        if (event.generation === state.generation) return { runtime: runtimeOf(event) };
        const pending = state.generation === null || event.generation > state.generation;
        if (pending && (state.early === null || event.generation >= state.early.generation)) {
          return { early: event };
        }
        return state;
      }),
  }));
}

export const useClipboardAutoPushStore = createClipboardAutoPushStore();

export interface ClipboardAutoPushInputs {
  tauri: boolean;
  supported: boolean | null;
  settingsAvailable: boolean;
  enabled: boolean;
  deviceOnline: boolean;
  setupError: AppErrorPayload | null;
  runtime: ClipboardAutoPushRuntime | null;
}

/** The status line, or `null` while a target is being bound. */
export function clipboardAutoPushStatus(
  inputs: ClipboardAutoPushInputs,
): ClipboardAutoPushStatus | null {
  if (!inputs.tauri) return { kind: "off" };
  if (inputs.supported === false) return { kind: "unsupported" };
  if (!inputs.settingsAvailable) return { kind: "settingsUnavailable" };
  if (!inputs.enabled) return { kind: "off" };
  if (inputs.setupError) return { kind: "failed", error: inputs.setupError };
  if (inputs.supported === null) return null;
  if (!inputs.deviceOnline) return { kind: "waitingDevice" };
  return inputs.runtime;
}
