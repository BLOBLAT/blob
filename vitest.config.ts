import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@blob/game-core": fileURLToPath(new URL("./packages/game-core/src/index.ts", import.meta.url)),
      "@blob/protocol": fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)),
      "@blob/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      "@blob/validation": fileURLToPath(new URL("./packages/validation/src/index.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["apps/**/src/**/*.test.ts", "packages/**/src/**/*.test.ts", "services/**/src/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000
  }
});
