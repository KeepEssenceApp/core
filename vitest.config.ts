import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_SECRET: "test-admin-secret",
            SIGNING_KEY: "test-signing-key",
            APP_ORIGIN: "https://app.test",
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["test/setup.ts"], testTimeout: 20000 },
  };
});
