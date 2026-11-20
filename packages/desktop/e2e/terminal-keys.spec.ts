import { expect, test } from "@playwright/test";

import { createRefreshGate, KEY_REFRESH_MIN_MS } from "../../ui/composables/refreshGate";
import { SHIFT_ENTER_BYTES, terminalKeyBytes, type KeyLike } from "../../ui/composables/terminalKeys";

// Pure logic of the terminal key table and the key-triggered refresh gate (no browser).

const key = (over: Partial<KeyLike>): KeyLike => ({ key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...over });

test("shift+enter is sent as ESC CR", () => {
  expect(SHIFT_ENTER_BYTES).toBe("\x1b\r");
  expect(terminalKeyBytes(key({ shiftKey: true }))).toBe("\x1b\r");
});

test("plain Enter and other keys are left to xterm", () => {
  expect(terminalKeyBytes(key({}))).toBeNull();
  expect(terminalKeyBytes(key({ key: "a", shiftKey: true }))).toBeNull();
  expect(terminalKeyBytes(key({ key: "Tab", shiftKey: true }))).toBeNull();
  expect(terminalKeyBytes(key({ key: "Escape" }))).toBeNull();
});

test("Enter with another modifier (alone or with shift) is left to xterm", () => {
  for (const m of ["ctrlKey", "altKey", "metaKey"] as const) {
    expect(terminalKeyBytes(key({ [m]: true }))).toBeNull();
    expect(terminalKeyBytes(key({ [m]: true, shiftKey: true }))).toBeNull();
  }
});

test("Enter during IME composition is never mapped", () => {
  expect(terminalKeyBytes(key({ shiftKey: true, isComposing: true }))).toBeNull();
  expect(terminalKeyBytes(key({ shiftKey: true, keyCode: 229 }))).toBeNull();
  expect(terminalKeyBytes(key({ shiftKey: true }), true)).toBeNull();
  expect(terminalKeyBytes(key({ shiftKey: true, keyCode: 13, isComposing: false }), false)).toBe("\x1b\r");
});

test("a burst of keydowns passes the refresh gate once", () => {
  let t = 1_000_000;
  const gate = createRefreshGate(KEY_REFRESH_MIN_MS, () => t);
  let reads = 0;
  for (let i = 0; i < 31; i++) {
    if (gate.pass()) reads++;
    t += 100; // 31 keys in 3.1 s
  }
  expect(reads).toBe(1);
});

test("the gate opens again after the interval (the first key after a pause refreshes)", () => {
  let t = 1_000_000;
  const gate = createRefreshGate(KEY_REFRESH_MIN_MS, () => t);
  expect(gate.pass()).toBe(true);
  t += KEY_REFRESH_MIN_MS - 1;
  expect(gate.pass()).toBe(false);
  t += 1;
  expect(gate.pass()).toBe(true);
  expect(gate.pass()).toBe(false);
});
