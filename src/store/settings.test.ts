import { describe, expect, it, vi } from "vitest";
import { decodeSettings, defaultSettings, logcatPreset } from "@/lib/settings";
import { columnsMatch, COMPACT_COLUMNS } from "@/lib/logcatView";
import { createSettingsStore } from "@/store/settings";
import { useLogcatStore } from "@/store/logcat";
import { useDeviceMetricsStore } from "@/store/deviceMetrics";

function storage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
    }),
  };
}

describe("settings persistence", () => {
  it("keeps a common capture directory across restart with independent directory and group resets", () => {
    const disk = storage('{"version":1,"settings":{"recording":{"openAfterSave":false}}}');
    const store = createSettingsStore(() => disk);
    expect(store.getState().preferences.capture.directory).toBeNull();
    store.getState().update("capture", { directory: "/Volumes/中文 空格" });
    expect(createSettingsStore(() => disk).getState().preferences.capture.directory).toBe("/Volumes/中文 空格");
    store.getState().update("capture", { directory: null });
    expect(store.getState().preferences.recording.openAfterSave).toBe(false);
    store.getState().update("capture", { directory: "/Volumes/test" });
    disk.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
    store.getState().update("capture", { directory: "/Volumes/other" });
    expect(store.getState().preferences.capture.directory).toBe("/Volumes/test");
    store.getState().resetSection("capture");
    expect(store.getState().preferences.capture.directory).toBeNull();
    expect(store.getState().preferences.recording.openAfterSave).toBe(true);
    expect(store.getState().preferences.screenshot).toEqual(defaultSettings().screenshot);
  });
  it("persists browsing and generator options and resets one group without affecting the others", () => {
    const disk = storage('{"version":1,"settings":{"recording":{"openAfterSave":false}}}');
    const store = createSettingsStore(() => disk);
    const initial = store.getState().preferences;
    store.getState().update("files", { ...initial.files, sortBy: "size", showHidden: false, startDirectory: "/sdcard/中文 空格" });
    store.getState().update("apps", { sortBy: "apkSize", sortDirection: "desc" });
    store.getState().update("codegen", { codeType: "code128", separatorMode: "custom", customSeparator: "" });
    const saved = createSettingsStore(() => disk).getState().preferences;
    expect(saved.files.startDirectory).toBe("/sdcard/中文 空格");
    expect(saved.apps).toEqual({ sortBy: "apkSize", sortDirection: "desc" });
    expect(saved.codegen.customSeparator).toBe("");
    expect(saved.recording.openAfterSave).toBe(false);
    store.getState().resetSection("files");
    expect(store.getState().preferences).toEqual({ ...saved, files: defaultSettings().files });
    disk.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
    store.getState().update("codegen", defaultSettings().codegen);
    expect(store.getState().preferences.codegen).toEqual(saved.codegen);
    expect(store.getState().error).toMatchObject({ code: "settings.save" });
  });

  it.each([
    { files: { sortBy: "unknown" } }, { files: { sortDirection: "up" } },
    { files: { startDirectory: "relative/path" } }, { files: { startDirectory: "/bad\0path" } },
    { files: { showHidden: "false" } }, { files: { directoriesFirst: 1 } },
    { apps: { sortBy: "size" } }, { apps: { sortDirection: null } },
    { codegen: { codeType: "barcode" } }, { codegen: { separatorMode: "auto" } },
    { codegen: { customSeparator: null } },
  ])("rejects malformed new preferences: %j", (settings) => {
    expect(() => decodeSettings(JSON.stringify({ version: 1, settings }))).toThrow();
  });
  it("defaults mirroring to automatic lookup and keeps it across restart and resets", () => {
    expect(defaultSettings().mirror).toEqual({
      preset: "standard",
      options: {
        turnScreenOff: false,
        stayAwake: false,
        showTouches: false,
        alwaysOnTop: false,
        noAudio: false,
        viewOnly: false,
      },
      extraArgs: "",
      scrcpyPath: null,
    });
    // A file written before the mirror group existed reads with its defaults.
    const disk = storage('{"version":1,"settings":{"recording":{"openAfterSave":false}}}');
    const store = createSettingsStore(() => disk);
    expect(store.getState().preferences.mirror).toEqual(defaultSettings().mirror);
    const mirror = {
      preset: "high" as const,
      options: { ...defaultSettings().mirror.options, viewOnly: true, turnScreenOff: true },
      extraArgs: '--window-title="ADB GUI" --record=C:\\clips\\a.mp4',
      scrcpyPath: "C:\\Users\\me\\scoop\\shims\\scrcpy.exe",
    };
    store.getState().update("mirror", mirror);
    const restarted = createSettingsStore(() => disk);
    expect(restarted.getState().preferences.mirror).toEqual(mirror);
    expect(JSON.parse(disk.getItem() ?? "null").version).toBe(1);
    restarted.getState().resetSection("mirror");
    expect(restarted.getState().preferences.mirror).toEqual(defaultSettings().mirror);
    expect(restarted.getState().preferences.recording.openAfterSave).toBe(false);
    restarted.getState().update("mirror", mirror);
    restarted.getState().restoreDefaults();
    expect(createSettingsStore(() => disk).getState().preferences.mirror).toEqual(defaultSettings().mirror);
  });

  it.each([
    [{ mirror: { preset: "ultra" } }, "settings.invalidField"],
    [{ mirror: { options: { viewOnly: "yes" } } }, "settings.invalidField"],
    [{ mirror: { options: [] } }, "settings.invalidFormat"],
    [{ mirror: { extraArgs: 7 } }, "settings.invalidField"],
    [{ mirror: { extraArgs: "--a\n--b" } }, "settings.invalidField"],
    [{ mirror: { extraArgs: "--a\0" } }, "settings.invalidField"],
    [{ mirror: { scrcpyPath: "" } }, "settings.invalidScrcpyPath"],
    [{ mirror: { scrcpyPath: "scrcpy" } }, "settings.invalidScrcpyPath"],
    [{ mirror: { scrcpyPath: "/usr/bin/scr\0cpy" } }, "settings.invalidScrcpyPath"],
    [{ mirror: { scrcpyPath: 12 } }, "settings.invalidScrcpyPath"],
  ])("rejects malformed mirror preferences: %j", (settings, code) => {
    expect(() => decodeSettings(JSON.stringify({ version: 1, settings }))).toThrow(code);
  });

  it("accepts absolute scrcpy paths for every desktop platform", () => {
    for (const scrcpyPath of ["/opt/homebrew/bin/scrcpy", "C:\\tools\\scrcpy.exe", "D:/scrcpy/scrcpy.exe", "\\\\server\\share\\scrcpy.exe"]) {
      expect(decodeSettings(JSON.stringify({ version: 1, settings: { mirror: { scrcpyPath } } })).mirror.scrcpyPath).toBe(scrcpyPath);
    }
  });

  it("loads defaults and restores only persisted preferences after restart", () => {
    const disk = storage();
    const store = createSettingsStore(() => disk);
    expect(store.getState().preferences).toEqual(defaultSettings());
    store
      .getState()
      .update("logcat", {
        ...store.getState().preferences.logcat,
        columns: logcatPreset("compact"),
        softWrap: true,
      });
    store.getState().update("performance", { backgroundEnabled: true });
    expect(createSettingsStore(() => disk).getState().preferences).toEqual(
      store.getState().preferences,
    );
    expect(JSON.parse(disk.getItem()!).settings).not.toHaveProperty("paused");
    expect(JSON.parse(disk.getItem()!).settings.logcat).not.toHaveProperty(
      "buffer",
    );
    expect(
      columnsMatch(
        store.getState().preferences.logcat.columns,
        COMPACT_COLUMNS,
      ),
    ).toBe(true);
  });

  it("adds missing fields but rejects malformed values and unknown versions", () => {
    expect(
      decodeSettings(
        '{"version":1,"settings":{"recording":{"openAfterSave":false}}}',
      ),
    ).toEqual({ ...defaultSettings(), recording: { openAfterSave: false } });
    for (const raw of [
      "{",
      '{"version":2,"settings":{}}',
      '{"version":1,"settings":{"general":{"startupPane":null}}}',
      '{"version":1,"settings":{"logcat":{"softWrap":"false"}}}',
    ]) {
      const disk = storage(raw);
      const store = createSettingsStore(() => disk);
      expect(store.getState().available).toBe(false);
      expect(store.getState().error).toMatchObject({ code: "settings.load" });
      store.getState().update("performance", { backgroundEnabled: true });
      expect(disk.getItem()).toBe(raw);
      store.getState().restoreDefaults();
      expect(store.getState().available).toBe(true);
      expect(decodeSettings(disk.getItem())).toEqual(defaultSettings());
    }
  });

  it("keeps clipboard auto push off by default and restores it from storage", () => {
    expect(defaultSettings().clipboard).toEqual({ autoPush: false });
    expect(
      decodeSettings('{"version":1,"settings":{"performance":{"backgroundEnabled":true}}}').clipboard,
    ).toEqual({ autoPush: false });
    for (const value of ["true", 1, null]) {
      expect(() =>
        decodeSettings(JSON.stringify({ version: 1, settings: { clipboard: { autoPush: value } } })),
      ).toThrow(expect.objectContaining({ payload: { code: "settings.invalidField", params: { key: "autoPush" } } }));
    }
    const disk = storage();
    const store = createSettingsStore(() => disk);
    store.getState().update("clipboard", { autoPush: true });
    expect(JSON.parse(disk.getItem()!)).toMatchObject({ version: 1, settings: { clipboard: { autoPush: true } } });
    const restarted = createSettingsStore(() => disk);
    expect(restarted.getState().preferences.clipboard.autoPush).toBe(true);
    restarted.getState().resetSection("logcat");
    expect(restarted.getState().preferences.clipboard.autoPush).toBe(true);
    restarted.getState().resetSection("general");
    expect(restarted.getState().preferences.clipboard.autoPush).toBe(false);
    restarted.getState().update("clipboard", { autoPush: true });
    restarted.getState().restoreDefaults();
    expect(decodeSettings(disk.getItem()).clipboard.autoPush).toBe(false);
  });

  it("keeps the previous effective value on write failure and permits retry", () => {
    const disk = storage();
    const store = createSettingsStore(() => disk);
    disk.setItem.mockImplementationOnce(() => {
      throw new Error("quota");
    });
    store.getState().update("recording", { openAfterSave: false });
    expect(store.getState().preferences.recording.openAfterSave).toBe(true);
    expect(store.getState().error).toMatchObject({ code: "settings.save" });
    store.getState().update("recording", { openAfterSave: false });
    expect(store.getState().error).toBeNull();
    expect(decodeSettings(disk.getItem()).recording.openAfterSave).toBe(false);
  });

  it("resets one group and never resets or persists live runtime state", () => {
    const disk = storage();
    const store = createSettingsStore(() => disk);
    const logs = useLogcatStore.getState();
    logs.beginSession("test", 9);
    logs.appendBatch(
      [
        {
          time: "now",
          level: "E",
          tag: "AndroidRuntime",
          pid: "1",
          tid: "1",
          message: "FATAL EXCEPTION: main",
          raw: "test",
        },
      ],
      9,
    );
    const seq = useLogcatStore.getState().buffer.at(0)!.seq;
    logs.setSelectedSeq(seq);
    logs.pause();
    useDeviceMetricsStore.getState().setPaused(true);
    const runtime = useLogcatStore.getState();
    store
      .getState()
      .update("logcat", {
        ...store.getState().preferences.logcat,
        softWrap: true,
        autoFold: false,
      });
    store.getState().update("recording", { openAfterSave: false });
    store.getState().resetSection("logcat");
    expect(store.getState().preferences.logcat).toEqual(
      defaultSettings().logcat,
    );
    expect(store.getState().preferences.recording.openAfterSave).toBe(false);
    expect(useLogcatStore.getState()).toBe(runtime);
    const writes = disk.setItem.mock.calls.length;
    logs.restart();
    useDeviceMetricsStore.getState().restart();
    expect(disk.setItem).toHaveBeenCalledTimes(writes);
    expect(store.getState().preferences.recording.openAfterSave).toBe(false);
  });
});
