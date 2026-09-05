// Integration tokens for the OpenClaw bot. Session-only (admin scope): a bot token
// can never mint another token. Only the hash is stored; the plaintext is shown once.
import type { Handler } from "../index.ts";
import { ALL_SCOPES, DEFAULT_BOT_SCOPES, mintToken, type Scope } from "../../_shared/auth.ts";
import { ApiError } from "../../_shared/http.ts";
import { fromPgError, must } from "../../_shared/db.ts";
import { bad, isUuid, optInt, optString, optStringArray } from "../../_shared/validate.ts";

export const list: Handler = async (ctx) => {
  const res = await ctx.db
    .from("integration_credentials")
    .select("id, name, token_prefix, scopes, expires_at, revoked_at, last_used_at, created_at")
    .eq("owner_id", ctx.ownerId)
    .order("created_at", { ascending: false });
  if (res.error) throw fromPgError(res.error);
  return { status: 200, body: { items: res.data ?? [] } };
};

export const create: Handler = async (ctx, _p, body) => {
  if (ctx.principal !== "session") throw new ApiError(403, "session_required", "Tokens can only be created from the website");
  const name = optString(body.name, "name", 100) ?? "OpenClaw";
  const scopes = (optStringArray(body.scopes, "scopes") ?? DEFAULT_BOT_SCOPES) as Scope[];
  for (const s of scopes) {
    if (!ALL_SCOPES.includes(s)) bad("scopes", `unknown scope '${s}'`);
    if (s === "admin") bad("scopes", "the admin scope cannot be delegated to a token");
  }
  const days = optInt(body.expires_in_days, "expires_in_days", 1, 3650);
  const expiresAt = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
  const { token, hash, prefix } = await mintToken();
  const row = { owner_id: ctx.ownerId, name, token_hash: hash, token_prefix: prefix, scopes, expires_at: expiresAt };
  const inserted = must(
    await ctx.db.from("integration_credentials").insert(row).select("id, name, token_prefix, scopes, expires_at, created_at").single(),
    "Token",
  );
  return { status: 201, body: { ...inserted, token, note: "Store this token now; it will not be shown again." } };
};

export const revoke: Handler = async (ctx, p) => {
  if (!isUuid(p.id)) throw new ApiError(404, "not_found", "Token not found");
  const res = await ctx.db
    .from("integration_credentials")
    .update({ revoked_at: new Date().toISOString() })
    .eq("owner_id", ctx.ownerId).eq("id", p.id).is("revoked_at", null)
    .select("id").maybeSingle();
  if (res.error) throw fromPgError(res.error);
  if (!res.data) throw new ApiError(404, "not_found", "Token not found or already revoked");
  return { status: 200, body: { revoked: true, id: p.id } };
};
