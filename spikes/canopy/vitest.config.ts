import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["**/*.spike.ts"], testTimeout: 120_000 } });
