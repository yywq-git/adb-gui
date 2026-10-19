import { useEffect, useRef } from "react";
import {
  clipboardAutoPushTarget,
  createClipboardAutoPushBinding,
  type ClipboardAutoPushBinding,
} from "@/lib/clipboardAutoPush";
import { getDeviceBySerial } from "@/lib/device";
import {
  getClipboardAutoPushSupport,
  isTauriRuntime,
  onClipboardAutoPushStatus,
  setClipboardAutoPush,
} from "@/lib/tauri";
import { useClipboardAutoPushStore } from "@/store/clipboardAutoPush";
import { useDeviceStore } from "@/store/device";
import { useSettingsStore } from "@/store/settings";

// Mounted at the App root: the switch applies even while the Tools page or the
// clipboard module is hidden. Rust does the watching and pushing.
export function useClipboardAutoPush(): void {
  const tauri = isTauriRuntime();
  const supported = useClipboardAutoPushStore((s) => s.supported);
  const enabled = useSettingsStore(
    (s) => s.available && s.preferences.clipboard.autoPush,
  );
  const device = useDeviceStore((s) =>
    getDeviceBySerial(s.devices, s.selectedDevice),
  );
  const target = clipboardAutoPushTarget({ tauri, supported, enabled, device });
  const bindingRef = useRef<ClipboardAutoPushBinding | null>(null);
  if (bindingRef.current === null) {
    const store = useClipboardAutoPushStore.getState;
    bindingRef.current = createClipboardAutoPushBinding({
      setTarget: setClipboardAutoPush,
      getSupport: getClipboardAutoPushSupport,
      listen: onClipboardAutoPushStatus,
      onSupported: (value) => store().setSupported(value),
      onSetupError: (error) => store().setupFailed(error),
      onBindStart: () => store().beginBind(),
      onBound: (generation, active) => store().bound(generation, active),
      onBindError: (error) => store().bindFailed(error),
      onEvent: (event) => store().receive(event),
    });
  }
  const binding = bindingRef.current;

  useEffect(() => {
    if (!tauri) return;
    binding.start();
    return () => binding.stop();
  }, [binding, tauri]);

  // `key` identifies `target`: it changes with the serial, state, transport or
  // device identity, so an equal target re-rendered later is not sent again.
  const key = target?.contextKey ?? null;
  useEffect(() => {
    binding.bind(target);
  }, [binding, key]);
}
