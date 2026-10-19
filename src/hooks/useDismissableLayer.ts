import { useEffect, type RefObject } from "react";

/**
 * Closes an open floating surface on pointer input outside `rootRef` and on
 * Escape. Escape also returns focus to the trigger so keyboard users keep their
 * place, as the Blueprint floating-surface contract requires.
 */
export function useDismissableLayer(
  open: boolean,
  rootRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  // WebKit (the macOS webview) does not focus a clicked button, so a
  // mouse-opened surface would leave focus on <body> where its arrow keys and
  // Tab order never reach it. Anchor focus on the trigger, as Chromium does.
  useEffect(() => {
    if (open && !rootRef.current?.contains(document.activeElement)) {
      triggerRef.current?.focus();
    }
  }, [open, rootRef, triggerRef]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent): void {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        onClose();
      }
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      onClose();
      triggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open, rootRef, triggerRef]);
}
