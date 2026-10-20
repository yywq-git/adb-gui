import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipboardTool } from "@/components/ClipboardTool";
import { GeneralSection } from "@/components/settings/sections/GeneralSection";
import { useClipboardAutoPushControl } from "@/hooks/useClipboardAutoPush";
import { timeOfDay } from "@/i18n/format";
import { en } from "@/i18n/messages/en";
import { zhCN } from "@/i18n/messages/zh-CN";
import { defaultSettings, type SettingsPreferences } from "@/lib/settings";
import type { DeviceInfo } from "@/lib/tauri";
import { useClipboardAutoPushStore } from "@/store/clipboardAutoPush";
import { useLocaleStore } from "@/store/locale";

const runtime = vi.hoisted(() => ({ tauri: true }));
const settingsState = vi.hoisted(() => ({
  preferences: {} as SettingsPreferences,
  available: true,
  update: (() => {}) as (key: string, value: unknown) => void,
}));
const deviceState = vi.hoisted(() => ({
  devices: [] as DeviceInfo[],
  selectedDevice: null as string | null,
}));
const feedbackState = vi.hoisted(() => ({
  showToast: (() => {}) as (...args: unknown[]) => void,
}));

// Server rendering does not subscribe, so each store hook reads the current snapshot.
vi.mock("@/i18n", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/i18n")>(),
  useT: () => useLocaleStore.getState().messages,
  useLocale: () => useLocaleStore.getState().locale,
}));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/tauri")>(),
  isTauriRuntime: () => runtime.tauri,
}));
vi.mock("@/store/settings", () => ({
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
}));
vi.mock("@/store/device", () => ({
  useDeviceStore: Object.assign(
    (selector: (state: typeof deviceState) => unknown) => selector(deviceState),
    { getState: () => deviceState, subscribe: () => () => {} },
  ),
}));
vi.mock("@/store/feedback", () => ({
  useFeedbackStore: (selector: (state: typeof feedbackState) => unknown) => selector(feedbackState),
}));
vi.mock("@/store/clipboardAutoPush", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/clipboardAutoPush")>();
  const store = actual.useClipboardAutoPushStore;
  return {
    ...actual,
    useClipboardAutoPushStore: Object.assign(
      <T,>(selector: (state: ReturnType<typeof store.getState>) => T) => selector(store.getState()),
      store,
    ),
  };
});

const online: DeviceInfo = {
  serial: "a",
  state: "device",
  model: "Pixel 7",
  transport: "usb",
  is_network: false,
  alias_identity: null,
  device_id: "a",
};

function settings(autoPush: boolean) {
  const defaults = defaultSettings();
  return { ...defaults, clipboard: { autoPush } };
}

function statusLine(markup: string): string {
  const match = markup.match(/<div role="status" aria-live="polite" class="([^"]*)">(.*?)<\/div>/);
  if (match === null) return "";
  const text = match![2].replace(/<[^>]+>/g, "").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'");
  return `${match![1].match(/text-(ink2|ink3|ok|warn|err)/)?.[0] ?? ""} ${text}`.trim();
}

function switchFor(markup: string): string {
  const match = markup.match(/<button[^>]*role="switch"[^>]*>/g);
  expect(match).not.toBeNull();
  return match![match!.length - 1];
}

beforeEach(() => {
  runtime.tauri = true;
  settingsState.preferences = settings(true);
  settingsState.available = true;
  settingsState.update = vi.fn();
  deviceState.devices = [online];
  deviceState.selectedDevice = "a";
  feedbackState.showToast = vi.fn();
  useClipboardAutoPushStore.setState({
    supported: true,
    setupError: null,
    generation: 1,
    runtime: { kind: "watching" },
    early: null,
  });
});

afterEach(() => {
  useLocaleStore.getState().setPreference("zh-CN");
});

describe("clipboard module auto push", () => {
  const at = Date.UTC(2026, 9, 19, 6, 3, 21);
  const cases = [
    ["watching", { runtime: { kind: "watching" } }, (m: typeof zhCN) => `text-ink2 ${m.tools.clipboardTool.autoPush.watching}`],
    ["pushing", { runtime: { kind: "pushing" } }, (m: typeof zhCN) => `text-ink2 ${m.tools.clipboardTool.autoPush.pushing}`],
    ["pushed", { runtime: { kind: "pushed", at } }, (m: typeof zhCN, locale: "zh-CN" | "en") =>
      `text-ok ${m.tools.clipboardTool.autoPush.pushed({ time: timeOfDay(locale).format(at) })}`],
    ["not text", { runtime: { kind: "skipped", reason: "no_text" } }, (m: typeof zhCN) => `text-ink3 ${m.tools.clipboardTool.autoPush.skippedNoText}`],
    ["too large", { runtime: { kind: "skipped", reason: "too_large" } }, (m: typeof zhCN) => `text-warn ${m.tools.clipboardTool.autoPush.skippedTooLarge}`],
    ["locked", { runtime: { kind: "failed", error: { code: "clipboard.locked" } } }, (m: typeof zhCN) =>
      `text-err ${m.tools.clipboardTool.autoPush.failed({ detail: m.errors["clipboard.locked"]() })}`],
    ["setup failure", { setupError: { code: "clipboard.autoPushUnsupported" } }, (m: typeof zhCN) =>
      `text-err ${m.tools.clipboardTool.autoPush.failed({ detail: m.errors["clipboard.autoPushUnsupported"]() })}`],
    ["unsupported", { supported: false }, (m: typeof zhCN) => `text-ink3 ${m.tools.clipboardTool.autoPush.unsupported}`],
  ] as const;

  it.each(cases)("renders the %s status line in both languages", (_name, state, expected) => {
    useClipboardAutoPushStore.setState(state as Partial<ReturnType<typeof useClipboardAutoPushStore.getState>>);
    for (const [locale, messages] of [["zh-CN", zhCN], ["en", en]] as const) {
      useLocaleStore.getState().setPreference(locale);
      const markup = renderToStaticMarkup(<ClipboardTool />);
      expect(statusLine(markup)).toBe(expected(messages as typeof zhCN, locale));
      expect(markup).toContain(messages.tools.clipboardTool.autoPush.label);
    }
  });

  it("explains a missing device and unavailable settings without disabling for the device", () => {
    deviceState.devices = [{ ...online, state: "offline" }];
    let markup = renderToStaticMarkup(<ClipboardTool />);
    expect(statusLine(markup)).toBe(`text-ink3 ${zhCN.tools.clipboardTool.autoPush.waitingDevice}`);
    expect(switchFor(markup)).not.toContain('disabled=""');

    settingsState.available = false;
    settingsState.preferences = settings(false);
    markup = renderToStaticMarkup(<ClipboardTool />);
    expect(statusLine(markup)).toBe(`text-warn ${zhCN.tools.clipboardTool.autoPush.settingsUnavailable}`);
    expect(switchFor(markup)).toContain('disabled=""');
  });

  it("hides the status line while the switch is off", () => {
    settingsState.preferences = settings(false);
    const markup = renderToStaticMarkup(<ClipboardTool />);
    expect(markup).not.toContain('role="status"');
    expect(switchFor(markup)).toContain('aria-checked="false"');
  });

  it("disables the switch outside the desktop runtime and on unsupported platforms", () => {
    runtime.tauri = false;
    expect(switchFor(renderToStaticMarkup(<ClipboardTool />))).toContain('disabled=""');
    runtime.tauri = true;
    useClipboardAutoPushStore.setState({ supported: false });
    expect(switchFor(renderToStaticMarkup(<ClipboardTool />))).toContain('disabled=""');
  });

  it("never reports an automatic push failure through a toast", () => {
    useClipboardAutoPushStore.setState({ runtime: { kind: "failed", error: { code: "clipboard.writeUnconfirmed" } } });
    renderToStaticMarkup(<ClipboardTool />);
    expect(feedbackState.showToast).not.toHaveBeenCalled();
  });
});

describe("clipboard auto push settings row", () => {
  it("reads and writes the same preference as the module switch", () => {
    settingsState.preferences = settings(true);
    const general = renderToStaticMarkup(<GeneralSection />);
    expect(general).toContain(zhCN.settings.rows.clipboardAutoPush.label);
    expect(general).toContain(zhCN.settings.rows.clipboardAutoPush.description);
    expect(switchFor(general)).toContain('aria-checked="true"');
    expect(switchFor(renderToStaticMarkup(<ClipboardTool />))).toContain('aria-checked="true"');
    // Both surfaces render this control, so both write through one settings action.
    useClipboardAutoPushControl().setChecked(false);
    expect(settingsState.update).toHaveBeenCalledExactlyOnceWith("clipboard", { autoPush: false });
  });

  it("disables the row and says why on an unsupported platform", () => {
    useClipboardAutoPushStore.setState({ supported: false });
    for (const [locale, messages] of [["zh-CN", zhCN], ["en", en]] as const) {
      useLocaleStore.getState().setPreference(locale);
      const general = renderToStaticMarkup(<GeneralSection />);
      expect(general).toContain(messages.settings.rows.clipboardAutoPush.unsupported);
      expect(general).not.toContain(messages.settings.rows.clipboardAutoPush.description);
      expect(switchFor(general)).toContain('disabled=""');
    }
  });
});
