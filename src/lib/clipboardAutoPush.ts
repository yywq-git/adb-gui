import { toAppError, type AppErrorPayload } from "@/i18n/errors";
import { clipboardContextKey } from "@/lib/clipboardTransfer";
import type {
  ClipboardAutoPushEvent,
  ClipboardAutoPushTarget,
  DeviceInfo,
} from "@/lib/tauri";

/** Pushing needs consent, a supported platform and an online selected device. */
export function clipboardAutoPushTarget({
  tauri,
  supported,
  enabled,
  device,
}: {
  tauri: boolean;
  supported: boolean | null;
  enabled: boolean;
  device: DeviceInfo | null;
}): ClipboardAutoPushTarget {
  return tauri && supported === true && enabled && device?.state === "device"
    ? { serial: device.serial, contextKey: clipboardContextKey(device) }
    : null;
}

interface BindingDependencies {
  setTarget: (target: ClipboardAutoPushTarget) => Promise<number>;
  getSupport: () => Promise<boolean>;
  listen: (callback: (event: ClipboardAutoPushEvent) => void) => Promise<() => void>;
  onSupported: (supported: boolean) => void;
  onSetupError: (error: AppErrorPayload) => void;
  onBindStart: () => void;
  onBound: (generation: number, active: boolean) => void;
  onBindError: (error: AppErrorPayload) => void;
  onEvent: (event: ClipboardAutoPushEvent) => void;
}

export type ClipboardAutoPushBinding = ReturnType<typeof createClipboardAutoPushBinding>;

// Start and stop repeat under StrictMode, so one binding keeps its request queue
// across cycles and a cleanup's stop request stays ordered before the next target.
export function createClipboardAutoPushBinding(deps: BindingDependencies) {
  let running = false;
  let cycle = 0;
  let unlisten: (() => void) | null = null;
  let supportRequested = false;
  // `undefined` until a target is sent in the current cycle.
  let key: string | null | undefined;
  let request = 0;
  // Rust applies targets in call order, so A -> B -> A cannot settle on B.
  let queue = Promise.resolve();

  function submit(target: ClipboardAutoPushTarget) {
    const id = ++request;
    deps.onBindStart();
    queue = queue.then(() =>
      deps.setTarget(target).then(
        (generation) => {
          if (id === request) deps.onBound(generation, target !== null);
        },
        (error) => {
          if (id === request) deps.onBindError(toAppError(error));
        },
      ),
    );
  }

  return {
    start() {
      if (running) return;
      running = true;
      const current = ++cycle;
      const live = () => running && current === cycle;
      void deps
        .listen((event) => {
          if (live()) deps.onEvent(event);
        })
        .then(
          (stop) => {
            if (live()) unlisten = stop;
            else stop();
          },
          (error) => {
            if (live()) deps.onSetupError(toAppError(error));
          },
        );
      if (!supportRequested) {
        supportRequested = true;
        void deps.getSupport().then(deps.onSupported, (error) =>
          deps.onSetupError(toAppError(error)),
        );
      }
    },
    bind(target: ClipboardAutoPushTarget) {
      const nextKey = target?.contextKey ?? null;
      if (!running || nextKey === key) return;
      key = nextKey;
      submit(target);
    },
    stop() {
      if (!running) return;
      running = false;
      unlisten?.();
      unlisten = null;
      key = undefined;
      submit(null);
    },
  };
}
