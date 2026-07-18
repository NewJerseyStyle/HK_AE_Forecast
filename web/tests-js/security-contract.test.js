// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const migration = readFileSync(resolve(root, "supabase/migrations/202607150001_wait_research.sql"), "utf8");
const edge = readFileSync(resolve(root, "supabase/functions/_shared/core.ts"), "utf8");
const config = readFileSync(resolve(root, "supabase/config.toml"), "utf8");

describe("research security contract", () => {
  it("enables RLS and revokes direct anonymous table access", () => {
    for (const table of ["official_context_snapshots", "model_releases", "wait_sessions", "wait_events", "prediction_logs", "recovery_attempts", "wait_aggregates"]) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
    }
    expect(migration).toContain("revoke all on all tables in schema public from anon, authenticated");
    expect(migration).not.toMatch(/create\s+policy[\s\S]+to\s+authenticated/i);
  });

  it("keeps privileged credentials outside browser source", () => {
    const browser = readFileSync(resolve(root, "web/research-core.js"), "utf8") + readFileSync(resolve(root, "web/research-ui.js"), "utf8");
    expect(browser).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(browser).not.toMatch(/sb_secret_[a-z0-9]/i);
  });

  it("requires JWTs, owner checks, HMAC recovery and origin checks", () => {
    expect(config.match(/verify_jwt = true/g)).toHaveLength(5);
    expect(edge).toContain("eq(\"owner_user_id\", userId)");
    expect(edge).toContain("name: \"HMAC\"");
    expect(edge).toContain("origin_not_allowed");
    expect(edge).toContain("recovery_rate_limited");
  });
});
