/**
 * Where focus goes when a Base UI popup (menu, select, dialog) closes.
 *
 * A pointer close keeps focus off the trigger, so a click away or a mouse
 * "Batal" leaves no focus ring behind. Every other close returns focus to the
 * trigger, so a keyboard or screen-reader user never lands on <body>.
 *
 * Base UI only knows the close type when its own handler closed the popup. A
 * popup closed in code (a Batal or Simpan button that sets `open` to false)
 * reports closeType "", so that case falls back to the last real input.
 */

type CloseType = "mouse" | "touch" | "pen" | "keyboard" | "";
type PointerFields = Pick<PointerEvent, "type" | "pointerType" | "width" | "height" | "pressure" | "detail" | "buttons">;

let lastInputWasPointer = false;

/**
 * A screen reader's activation arrives as a synthetic pointer and counts as
 * keyboard. The same rule as Base UI's `isVirtualPointerEvent`
 * (floating-ui-react/utils/event.js, @base-ui/react 1.9.0), Android branches
 * included: there a real touch can report 0×0, and TalkBack can report a
 * pressed button.
 */
export function isVirtualPointer(event: PointerFields, android = isAndroid()): boolean {
  if (event.pointerType === "") return true;
  if (!android && event.width === 0 && event.height === 0) return true;
  // Chrome: TalkBack, VoiceOver and NVDA press as a 1x1 mouse point with no pressure.
  if (
    event.type === "pointerdown" && event.pointerType === "mouse" && event.width === 1 && event.height === 1 &&
    event.pressure === 0 && event.detail === 0 && (android || event.buttons === 0)
  ) return true;
  // iOS VoiceOver: a sub-pixel touch point with no pressure.
  return event.pointerType === "touch" && event.width < 1 && event.height < 1 && event.pressure === 0 && event.detail === 0;
}

function isAndroid(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? "";
  return platform.toLowerCase() === "android" || navigator.userAgent.toLowerCase().includes("android");
}

if (typeof document !== "undefined") {
  // Capture phase: recorded before any handler can close the popup.
  document.addEventListener("pointerdown", (event) => {
    lastInputWasPointer = !isVirtualPointer(event);
  }, true);
  document.addEventListener("keydown", () => {
    lastInputWasPointer = false;
  }, true);
}

export function returnFocusUnlessPointer(closeType: CloseType): boolean {
  if (closeType === "mouse" || closeType === "touch" || closeType === "pen") return false;
  if (closeType === "") return !lastInputWasPointer;
  return true;
}
