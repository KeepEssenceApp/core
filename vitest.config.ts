import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.test.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_SECRET: "test-admin-secret",
            SIGNING_KEY: "test-signing-key",
            APP_ORIGIN: "https://app.test",
            // Never a real model or mail provider in tests, whatever .dev.vars holds.
            LLM_API_KEY: "",
            LLM_BASE_URL: "https://model.test",
            RESEND_API_KEY: "",
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["test/setup.ts"], testTimeout: 20000 },
  };
});
