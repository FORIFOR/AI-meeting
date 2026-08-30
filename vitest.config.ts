import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "providers/**/*.test.ts",
      "avatar-providers/**/*.test.ts",
      "services/**/*.test.ts",
      "connectors/**/*.test.ts",
      "apps/**/*.test.{ts,tsx}",
      "characters/**/*.test.ts",
      "personas/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "apps/web/public/**", "reference/**"],
    environment: "node",
    passWithNoTests: true,
  },
});
