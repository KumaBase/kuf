export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable;
}

export function hasDialogOverlay(): boolean {
  return !!document.querySelector(".dialog-overlay");
}

export function focusApp() {
  requestAnimationFrame(() => {
    if (hasDialogOverlay()) return;
    const app = document.querySelector<HTMLElement>(".app");
    if (!app) return;
    if (document.activeElement === app) return;
    app.focus({ preventScroll: true });
  });
}

export function focusElement(el: HTMLElement | undefined | null) {
  requestAnimationFrame(() => {
    el?.focus({ preventScroll: true });
  });
}
