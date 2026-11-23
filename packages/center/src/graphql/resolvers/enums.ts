/**
 * GraphQL の enum の名前と内部の値が違う物の写し（GraphQL の名前に `-` は使えない）。
 * `needs_input` ⇄ center の activity `needs-input`。
 */
export const enumValues = {
  SessionActivityState: { working: "working", needs_input: "needs-input", idle: "idle", unknown: "unknown" },
} as const;
