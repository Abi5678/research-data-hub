import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.{test,spec}.{js,mjs,cjs,ts}"],
    testTimeout: 60000,
    fileParallelism: false,
  },
});
