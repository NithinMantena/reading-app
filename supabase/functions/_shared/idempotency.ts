// Idempotent creates: the same Idempotency-Key with the same request body replays the
// stored response; the same key with a different body is rejected. Required for
// integration-token requests so a retried bot action never duplicates a record.
import type { Ctx } from "./auth.ts";
import { ApiError, sha256Hex } from "./http.ts";

export interface Result {
  status: number;
  body: unknown;
}

export async function withIdempotency(
  ctx: Ctx,
  req: Request,
  rawBody: string,
  handler: () => Promise<Result>,
): Promise<Result & { replayed?: boolean }> {
  const key = req.headers.get("idempotency-key")?.trim();
  if (!key) {
    if (ctx.principal === "token") {
      throw new ApiError(428, "idempotency_key_required", "Integration requests must send an Idempotency-Key header");
    }
    return handler();
  }
  if (key.length > 200) throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key is too long");

  const requestHash = await sha256Hex(`${req.method} ${new URL(req.url).pathname}\n${rawBody}`);
  const { data: existing } = await ctx.db
    .from("idempotency_keys")
    .select("request_hash, status, response")
    .eq("owner_id", ctx.ownerId)
    .eq("key", key)
    .maybeSingle();
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new ApiError(422, "idempotency_key_reused", "Idempotency-Key was already used with a different request");
    }
    return { status: existing.status, body: existing.response, replayed: true };
  }

  const result = await handler();
  if (result.status < 500) {
    const { error } = await ctx.db.from("idempotency_keys").insert({
      owner_id: ctx.ownerId,
      key,
      request_hash: requestHash,
      status: result.status,
      response: result.body,
    });
    // A concurrent duplicate may have raced us; the stored response wins either way.
    if (error && error.code === "23505") {
      const { data: raced } = await ctx.db
        .from("idempotency_keys")
        .select("status, response")
        .eq("owner_id", ctx.ownerId)
        .eq("key", key)
        .maybeSingle();
      if (raced) return { status: raced.status, body: raced.response, replayed: true };
    }
  }
  return result;
}
