/// <reference path="../supabase/functions/_shared/deno.d.ts" />
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as auth from "../supabase/functions/_shared/auth";

let dispatch: (req: Request) => Response | Promise<Response>;
const ctx: auth.Ctx = {
  ownerId: "11111111-1111-1111-1111-111111111111", principal: "token", source: "openclaw",
  requestId: "test", scopes: new Set(), db: {} as auth.Ctx["db"],
};

beforeAll(async () => {
  vi.stubGlobal("Deno", { env: { get: () => undefined }, serve: (fn: typeof dispatch) => { dispatch = fn; } });
  vi.spyOn(auth, "authenticate").mockImplementation(async () => ctx);
  await import("../supabase/functions/api/index");
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("MCP-facing route permissions", () => {
  it.each([
    ["GET", "/recommendation-entries/33333333-3333-3333-3333-333333333333", "read"],
    ["POST", "/preferences/interests", "preferences:write"],
    ["DELETE", "/preferences/interests/History%20of%20science", "preferences:write"],
  ])("%s %s requires %s before querying the database", async (method, path, scope) => {
    ctx.scopes = new Set();
    const res = await dispatch(new Request(`https://app.example/functions/v1/api/v1${path}`, { method }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "insufficient_scope", details: { scope } } });
  });

  it("requires an idempotency key for a bot interest upsert", async () => {
    ctx.scopes = new Set(["preferences:write"]);
    const res = await dispatch(new Request("https://app.example/functions/v1/api/v1/preferences/interests", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "History" }),
    }));
    expect(res.status).toBe(428);
    expect(await res.json()).toMatchObject({ error: { code: "idempotency_key_required" } });
  });
});
