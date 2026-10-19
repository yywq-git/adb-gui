import { useLocale, useT, type Messages } from "@/i18n";
import { errorText } from "@/i18n/errors";
import { timeOfDay } from "@/i18n/format";
import type { Locale } from "@/i18n/locale";
import { useEffect, useId, useRef, useState } from "react";
import { ClipboardCopy, RefreshCw, Send } from "lucide-react";
import { Switch } from "@/components/settings/controls/Switch";
import { useClipboardAutoPushControl } from "@/hooks/useClipboardAutoPush";
import {
  createClipboardTransfer,
  type ClipboardDirection,
} from "@/lib/clipboardTransfer";
import {
  getDeviceBySerial,
  getDeviceDisplayLabel,
  isOnlineDevice,
} from "@/lib/device";
import {
  getDeviceClipboard,
  isTauriRuntime,
  readHostClipboardText,
  setDeviceClipboard,
  writeHostClipboardText,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  clipboardAutoPushStatus,
  useClipboardAutoPushStore,
  type ClipboardAutoPushStatus,
} from "@/store/clipboardAutoPush";
import { useDeviceStore } from "@/store/device";
import { useFeedbackStore } from "@/store/feedback";
import { useSettingsStore } from "@/store/settings";

function statusTone(status: ClipboardAutoPushStatus): string {
  switch (status.kind) {
    case "off":
      return "";
    case "unsupported":
    case "waitingDevice":
      return "text-ink3";
    case "settingsUnavailable":
      return "text-warn";
    case "watching":
    case "pushing":
      return "text-ink2";
    case "pushed":
      return "text-ok";
    case "skipped":
      return status.reason === "too_large" ? "text-warn" : "text-ink3";
    case "failed":
      return "text-err";
  }
}

function statusText(status: ClipboardAutoPushStatus, t: Messages, locale: Locale): string {
  const text = t.tools.clipboardTool.autoPush;
  switch (status.kind) {
    case "off":
      return "";
    case "unsupported":
      return text.unsupported;
    case "settingsUnavailable":
      return text.settingsUnavailable;
    case "waitingDevice":
      return text.waitingDevice;
    case "watching":
      return text.watching;
    case "pushing":
      return text.pushing;
    case "pushed":
      return text.pushed({ time: timeOfDay(locale).format(status.at) });
    case "skipped":
      return status.reason === "too_large" ? text.skippedTooLarge : text.skippedNoText;
    case "failed":
      return text.failed({ detail: errorText(status.error, t) });
  }
}

// Automatic pushes report only here, never through a toast.
function AutoPushControl({ deviceOnline }: { deviceOnline: boolean }) {
  const t = useT();
  const locale = useLocale();
  const labelId = useId();
  const control = useClipboardAutoPushControl();
  const supported = useClipboardAutoPushStore((s) => s.supported);
  const setupError = useClipboardAutoPushStore((s) => s.setupError);
  const runtime = useClipboardAutoPushStore((s) => s.runtime);
  const settingsAvailable = useSettingsStore((s) => s.available);
  const status = clipboardAutoPushStatus({
    tauri: isTauriRuntime(),
    supported,
    settingsAvailable,
    enabled: control.checked,
    deviceOnline,
    setupError,
    runtime,
  });
  return (
    <div className="flex min-w-0 flex-col">
      <div
        onClick={(event) => {
          if (control.disabled) return;
          if (event.target instanceof Element && event.target.closest("button") !== null) return;
          control.setChecked(!control.checked);
        }}
        className={cn(
          "flex h-8 min-w-0 items-center justify-between gap-3 text-xs",
          control.disabled ? "cursor-not-allowed text-ink3" : "cursor-pointer",
        )}
      >
        <span id={labelId} className="min-w-0 truncate">
          {t.tools.clipboardTool.autoPush.label}
        </span>
        <Switch
          checked={control.checked}
          onCheckedChange={control.setChecked}
          disabled={control.disabled}
          ariaLabelledBy={labelId}
        />
      </div>
      {/* No line while off; an empty line keeps its height while a target is being bound. */}
      {status?.kind !== "off" && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "flex min-h-5 min-w-0 items-start gap-1.5 text-[11px] leading-5",
            status && statusTone(status),
          )}
        >
          {status && (
            <>
              <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 bg-current" />
              <span className="min-w-0 break-words">{statusText(status, t, locale)}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ClipboardTool() {
  const t = useT();
  const devices = useDeviceStore((s) => s.devices);
  const selected = useDeviceStore((s) => s.selectedDevice);
  const device = getDeviceBySerial(devices, selected);
  const showToast = useFeedbackStore((s) => s.showToast);
  const [busy, setBusy] = useState<ClipboardDirection | null>(null);
  const controllerRef = useRef<ReturnType<
    typeof createClipboardTransfer
  > | null>(null);

  useEffect(() => {
    const controller = createClipboardTransfer({
      readHost: readHostClipboardText,
      writeHost: writeHostClipboardText,
      getDevice: getDeviceClipboard,
      setDevice: setDeviceClipboard,
      onBusy: setBusy,
      onSuccess: (direction) =>
        showToast(
          "success",
          (t) => (direction === "to-device"
            ? t.tools.clipboardTool.textSentToTheDeviceClipboard
            : t.tools.clipboardTool.deviceTextCopiedToTheComputerClipboard),
        ),
      onError: (message) => showToast("error", message),
    });
    const bind = () => {
      const state = useDeviceStore.getState();
      controller.bind(getDeviceBySerial(state.devices, state.selectedDevice));
    };
    bind();
    // Synchronous subscription also catches A -> B -> A before React renders again.
    const unsubscribe = useDeviceStore.subscribe(bind);
    controllerRef.current = controller;
    return () => {
      unsubscribe();
      controller.dispose();
      controllerRef.current = null;
    };
  }, [showToast]);

  const disabled =
    !isTauriRuntime() || !isOnlineDevice(device) || busy !== null;
  return (
    <div className="flex h-full min-w-0 flex-col gap-3">
      <div className="grid h-9 grid-cols-2 gap-2">
        {(
          [
            { direction: "to-device", label: t.tools.clipboardTool.sendToDevice, icon: Send },
            { direction: "to-host", label: t.tools.clipboardTool.copyToComputer, icon: ClipboardCopy },
          ] as const
        ).map(({ direction, label, icon: Icon }) => (
          <button
            key={direction}
            type="button"
            disabled={disabled}
            onClick={() => void controllerRef.current?.transfer(direction)}
            className="flex min-w-0 items-center justify-center gap-1.5 border border-ink bg-ink px-2 text-xs text-onink hover:bg-ink2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === direction ? (
              <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <Icon className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="whitespace-nowrap">{label}</span>
          </button>
        ))}
      </div>
      <AutoPushControl deviceOnline={isOnlineDevice(device)} />
      <div
        className="min-h-8 break-words border-y border-dashed border-rule2 py-2 text-[11px] text-ink2"
        title={device ? getDeviceDisplayLabel(device) : undefined}
      >
        {device ? getDeviceDisplayLabel(device) : t.tools.clipboardTool.noDeviceConnected}
      </div>
    </div>
  );
}
