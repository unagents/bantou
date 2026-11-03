import { expect, test } from "@playwright/test";

import { BUFFER_LIMIT, decodeBase64, encodeBase64, SessionBuffer } from "../src/composables/terminalBuffer";

// Pure logic of the per-session buffer (no browser).

const bytes = (n: number) => new Uint8Array(n).fill(65);

test("the buffer keeps the last received chunk id and ignores repeats", () => {
  const b = new SessionBuffer();
  expect(b.lastId).toBeNull();
  expect(b.push(1, bytes(3))).toBe(true);
  expect(b.push(2, bytes(3))).toBe(true);
  expect(b.lastId).toBe(2);
  expect(b.push(2, bytes(3))).toBe(false);
  expect(b.push(1, bytes(3))).toBe(false);
  expect(b.chunks).toHaveLength(2);
  expect(b.bytes).toBe(6);
});

test("past 2 MiB the oldest chunks are dropped", () => {
  expect(BUFFER_LIMIT).toBe(2 * 1024 * 1024);
  const b = new SessionBuffer();
  const mib = 1024 * 1024;
  for (let id = 1; id <= 3; id++) b.push(id, bytes(mib));
  expect(b.bytes).toBe(2 * mib);
  expect(b.chunks).toHaveLength(2);
  expect(b.lastId).toBe(3);
  b.push(4, bytes(mib));
  expect(b.bytes).toBe(2 * mib);
});

test("a single chunk larger than the limit is kept (the newest is never dropped)", () => {
  const b = new SessionBuffer();
  b.push(1, bytes(BUFFER_LIMIT + 10));
  expect(b.chunks).toHaveLength(1);
});

test("clear (reset) forgets the chunks and the id, so the stream restarts from any id", () => {
  const b = new SessionBuffer();
  b.push(7, bytes(5));
  b.clear();
  expect([b.chunks.length, b.bytes, b.lastId]).toEqual([0, 0, null]);
  expect(b.push(1, bytes(1))).toBe(true);
});

test("base64 round-trips arbitrary bytes", () => {
  const raw = new Uint8Array([0, 27, 91, 200, 255, 10]);
  expect(Array.from(decodeBase64(encodeBase64(raw)))).toEqual(Array.from(raw));
  const big = bytes(100_000);
  expect(decodeBase64(encodeBase64(big)).length).toBe(100_000);
});
