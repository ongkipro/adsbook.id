// The shared rule for where focus goes when a Base UI popup closes (src/components/ui/final-focus.ts).
import assert from "node:assert/strict";
import test from "node:test";

const listeners = new Map<string, (event: object) => void>();
(globalThis as { document?: unknown }).document = {
  addEventListener: (type: string, handler: (event: object) => void) => listeners.set(type, handler),
};
const { isVirtualPointer, returnFocusUnlessPointer } = await import("../components/ui/final-focus.ts");

const mouse = { type: "pointerdown", pointerType: "mouse", width: 1, height: 1, pressure: 0.5, detail: 1, buttons: 1 };
const screenReader = { type: "pointerdown", pointerType: "mouse", width: 1, height: 1, pressure: 0, detail: 0, buttons: 0 };

test("a pointer close keeps focus off the trigger; a keyboard close returns it", () => {
  for (const type of ["mouse", "touch", "pen"] as const) assert.equal(returnFocusUnlessPointer(type), false, type);
  assert.equal(returnFocusUnlessPointer("keyboard"), true);
});

test("a close made in code (closeType \"\") follows the last real input, never <body> for a keyboard user", () => {
  listeners.get("keydown")!({});
  assert.equal(returnFocusUnlessPointer(""), true, "Enter on Batal: focus returns to the trigger");
  listeners.get("pointerdown")!(mouse);
  assert.equal(returnFocusUnlessPointer(""), false, "a mouse click on Batal: no focus ring on the trigger");
  listeners.get("pointerdown")!(screenReader);
  assert.equal(returnFocusUnlessPointer(""), true, "a screen-reader press counts as keyboard");
});

test("only synthetic pointers count as virtual", () => {
  assert.equal(isVirtualPointer(mouse), false);
  assert.equal(isVirtualPointer({ ...mouse, pointerType: "touch", width: 24, height: 24 }), false);
  assert.equal(isVirtualPointer(screenReader), true, "NVDA/VoiceOver/TalkBack in Chrome");
  assert.equal(isVirtualPointer({ ...mouse, pointerType: "" }), true);
  assert.equal(isVirtualPointer({ type: "pointerdown", pointerType: "touch", width: 0.333, height: 0.333, pressure: 0, detail: 0, buttons: 0 }), true, "iOS VoiceOver");
  assert.equal(isVirtualPointer({ ...mouse, pressure: 0 }), false, "a real desktop click may report no pressure");
});

test("Android: TalkBack may report a pressed button, and a real touch may report 0x0", () => {
  const talkBack = { ...screenReader, buttons: 1 };
  assert.equal(isVirtualPointer(talkBack, true), true, "TalkBack on Android counts as keyboard");
  assert.equal(isVirtualPointer(talkBack, false), false, "the same event off Android is a real press");
  const zeroTouch = { type: "pointerdown", pointerType: "touch", width: 0, height: 0, pressure: 0.4, detail: 1, buttons: 1 };
  assert.equal(isVirtualPointer(zeroTouch, true), false, "a real Android touch reporting 0x0 is a pointer");
  assert.equal(isVirtualPointer(zeroTouch, false), true, "off Android, 0x0 is synthetic");
});
