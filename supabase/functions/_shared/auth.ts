// Authentication for the /v1 API.
//
// Two principals are accepted:
//   1. Browser sessions: a Supabase JWT issued after GitHub sign-in. The GitHub login
//      must match app_owner.github_login; anyone else gets 403.
//   2. Integration tokens: "rap_..." bearer tokens created from the website for the
//      OpenClaw bot. Only the SHA-256 hash is stored. Tokens carry scopes.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ApiError, sha256Hex } from "./http.ts";

export type Scope = "read" | "library:write" | "feedback:write" | "preferences:write" | "generation" | "admin";
export const ALL_SCOPES: Scope[] = ["read", "library:write", "feedback:write", "preferences:write", "generation", "admin"];
export const DEFAULT_BOT_SCOPES: Scope[] = ["read", "library:write", "feedback:write", "preferences:write", "generation"];

export interface Ctx {
  ownerId: string;
  principal: "session" | "token";
  scopes: Set<Scope>;
  credentialId?: string;
  db: SupabaseClient;
  requestId: string;
  source: "website" | "openclaw";
}

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function ownerLogin(db: SupabaseClient): Promise<string> {
  const envLogin = Deno.env.get("OWNER_GITHUB_LOGIN");
  const { data } = await db.from("app_owner").select("github_login").eq("id", 1).maybeSingle();
  const login = data?.github_login ?? envLogin;
  if (!login) throw new ApiError(500, "owner_not_configured", "App owner is not configured");
  return login;
}

export async function authenticate(req: Request, requestId: string): Promise<Ctx> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) throw new ApiError(401, "unauthenticated", "Missing bearer token");
  const token = m[1].trim();
  const db = serviceClient();

  if (token.startsWith("rap_")) {
    const hash = await sha256Hex(token);
    const { data: cred } = await db
      .from("integration_credentials")
      .select("id, owner_id, scopes, expires_at, revoked_at")
      .eq("token_hash", hash)
      .maybeSingle();
    if (!cred) throw new ApiError(401, "invalid_token", "Integration token is not recognised");
    if (cred.revoked_at) throw new ApiError(401, "token_revoked", "Integration token has been revoked");
    if (cred.expires_at && new Date(cred.expires_at) < new Date()) {
      throw new ApiError(401, "token_expired", "Integration token has expired");
    }
    // Best-effort usage timestamp; never block the request on it.
    db.from("integration_credentials").update({ last_used_at: new Date().toISOString() }).eq("id", cred.id).then(() => {});
    return {
      ownerId: cred.owner_id,
      principal: "token",
      scopes: new Set(cred.scopes as Scope[]),
      credentialId: cred.id,
      db,
      requestId,
      source: "openclaw",
    };
  }

  // Supabase session JWT
  const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await anon.auth.getUser(token);
  if (error || !data.user) throw new ApiError(401, "invalid_session", "Session is invalid or expired");
  const user = data.user;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const login = String(meta.user_name ?? meta.preferred_username ?? "");
  const expected = await ownerLogin(db);
  if (!login || login.toLowerCase() !== expected.toLowerCase()) {
    throw new ApiError(403, "not_owner", "This app is private to its owner");
  }
  // Remember the owner's user id the first time they sign in.
  db.from("app_owner").update({ user_id: user.id }).eq("id", 1).is("user_id", null).then(() => {});
  return {
    ownerId: user.id,
    principal: "session",
    scopes: new Set(ALL_SCOPES),
    db,
    requestId,
    source: "website",
  };
}

export function requireScope(ctx: Ctx, scope: Scope): void {
  if (ctx.scopes.has("admin") || ctx.scopes.has(scope)) return;
  throw new ApiError(403, "insufficient_scope", `This action requires the '${scope}' scope`, { scope });
}

/** Generate a new integration token. Returns the plaintext (shown once) and its hash. */
export async function mintToken(): Promise<{ token: string; hash: string; prefix: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let body = "";
  for (const b of bytes) body += alphabet[b % alphabet.length];
  const token = `rap_${body}`;
  return { token, hash: await sha256Hex(token), prefix: token.slice(0, 10) };
}
