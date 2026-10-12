import { useEffect } from "react";

export function useDialogFocus(open: boolean, label: string) {
 useEffect(() => {
  if (!open) return;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find(element => element.getAttribute("aria-label") === label);
  if (!dialog) return;
  const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')).filter(element => element.getClientRects().length > 0);
  const field = dialog.querySelector<HTMLElement>('input:not([type="checkbox"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)');
  (field ?? controls()[0])?.focus();
  const trap = (event: KeyboardEvent) => {
   if (event.key !== "Tab") return;
   const items = controls(); const first = items[0]; const last = items.at(-1);
   if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
   else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
  };
  document.addEventListener("keydown", trap);
  return () => { document.removeEventListener("keydown", trap); if (previous?.isConnected) previous.focus(); };
 }, [open, label]);
}
