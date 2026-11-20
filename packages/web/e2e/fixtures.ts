import { test as base, expect } from "@playwright/test";
import { startStack, type Stack } from "./stack";

export const test = base.extend<{ baseURL: string }, { stack: Stack }>({
  stack: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const stack = await startStack();
      await use(stack);
      await stack.close();
    },
    { scope: "worker" },
  ],
  baseURL: async ({ stack }, use) => use(stack.base),
  extraHTTPHeaders: async ({ stack }, use) => use(stack.headers),
});

export { expect };
