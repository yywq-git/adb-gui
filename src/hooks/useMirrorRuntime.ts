import { useEffect } from "react";
import { AppError, toAppError } from "@/i18n/errors";
import { isTauriRuntime, onMirrorExit } from "@/lib/tauri";
import { useFeedbackStore } from "@/store/feedback";
import { useMirrorStore } from "@/store/mirror";

/**
 * Keeps every device's mirroring state current. Mounted at the application
 * root because the tool module may be hidden while sessions end.
 */
export function useMirrorRuntime(): void {
  const showToast = useFeedbackStore((state) => state.showToast);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    // Listen before listing: the store buffers an exit that overtakes the list.
    void onMirrorExit((exit) => useMirrorStore.getState().acceptExit(exit))
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
        // A reloaded page reattaches to scrcpy windows that are still open.
        return useMirrorStore
          .getState()
          .restore()
          .catch((error) => {
            if (!disposed) {
              showToast("error", new AppError("shell.mirrorSessions", {}, { causes: [toAppError(error)] }).payload);
            }
          });
      })
      .catch((error) => {
        if (!disposed) {
          showToast("error", new AppError("shell.listenMirror", {}, { causes: [toAppError(error)] }).payload);
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
      unlisten = null;
    };
  }, [showToast]);
}
