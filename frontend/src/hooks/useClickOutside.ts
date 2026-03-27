import { useEffect, type RefObject } from "react";

/**
 * Hook that calls `onClose` when a mousedown event occurs outside the referenced element.
 * Commonly used for dropdown menus and popover dismissal.
 *
 * @param ref - Ref to the container element
 * @param onClose - Callback fired on outside click
 * @param active - Whether the hook is active (default: true). Pass false to disable.
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  active = true,
): void {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ref, onClose, active]);
}
