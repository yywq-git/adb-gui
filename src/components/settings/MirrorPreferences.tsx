import { useT } from "@/i18n";
import { toAppError } from "@/i18n/errors";
import { SegmentedControl } from "@/components/settings/controls/SegmentedControl";
import { SCRCPY_INSTALL_COMMANDS, SCRCPY_INSTALL_URL } from "@/lib/mirror";
import { MIRROR_PRESETS, type MirrorPreset } from "@/lib/settings";
import { openUrlExternal } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useFeedbackStore } from "@/store/feedback";
import { useSettingsStore } from "@/store/settings";

// The tool module and the settings row render this one control, so both
// write the preset through the same settings action.
export function MirrorPresetControl({
  disabled = false,
  className,
}: {
  disabled?: boolean;
  className?: string;
}) {
  const t = useT();
  const mirror = useSettingsStore((state) => state.preferences.mirror);
  const update = useSettingsStore((state) => state.update);
  return (
    <SegmentedControl<MirrorPreset>
      value={mirror.preset}
      options={MIRROR_PRESETS.map(({ value, label }) => ({ value, label: label(t) }))}
      disabled={disabled}
      ariaLabel={t.settings.rows.mirrorPreset.label}
      className={className}
      onChange={(preset) => update("mirror", { ...mirror, preset })}
    />
  );
}

export function ScrcpyInstallHints({ className }: { className?: string }) {
  const t = useT();
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <button
        type="button"
        className="self-start text-note underline-offset-2 hover:underline"
        onClick={() =>
          void openUrlExternal(SCRCPY_INSTALL_URL).catch((error) =>
            useFeedbackStore.getState().showToast("error", toAppError(error)),
          )
        }
      >
        {t.settings.mirror.installGuide}
      </button>
      <ul className="flex flex-col gap-0.5 break-words font-data text-ink2">
        {SCRCPY_INSTALL_COMMANDS.map(({ platform, command }) => (
          <li key={platform} className="select-text">
            {platform}: {command}
          </li>
        ))}
        <li>Linux: {t.settings.mirror.linuxInstall}</li>
      </ul>
    </div>
  );
}
