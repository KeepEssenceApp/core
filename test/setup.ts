import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach } from "vitest";
import { setNow } from "../src/clock";
import { T0 } from "./helpers";

beforeEach(async () => {
  await reset();
  await applyD1Migrations((env as any).DB, (env as any).TEST_MIGRATIONS);
  setNow(T0);
});

afterEach(() => {
  setNow(null);
});
