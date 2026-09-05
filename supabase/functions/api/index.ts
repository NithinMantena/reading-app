// Reading app API — a single Edge Function serving the versioned /v1 contract.
//
// Deployed URL:  https://<project-ref>.supabase.co/functions/v1/api/v1/...
// Auth:          Bearer <Supabase session JWT>  (website)
//                Bearer rap_<integration token>  (OpenClaw bot)
import { authenticate, requireScope, type Ctx, type Scope } from "../_shared/auth.ts";
import { ApiError, CORS_HEADERS, errorResponse, json } from "../_shared/http.ts";
import { withIdempotency, type Result } from "../_shared/idempotency.ts";
import * as books from "./handlers/books.ts";
import * as readings from "./handlers/readings.ts";
import * as feedback from "./handlers/feedback.ts";
import * as preferences from "./handlers/preferences.ts";
import * as recommendations from "./handlers/recommendations.ts";
import * as jobs from "./handlers/jobs.ts";
import * as tokens from "./handlers/tokens.ts";
import * as transfer from "./handlers/transfer.ts";
import * as me from "./handlers/me.ts";
import * as config from "./handlers/config.ts";

export type Handler = (
  ctx: Ctx,
  params: Record<string, string>,
  body: Record<string, unknown>,
  url: URL,
  req: Request,
) => Promise<Result>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  scope: Scope | null;
  idempotent: boolean;
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, path: string, scope: Scope | null, handler: Handler, opts: { idempotent?: boolean } = {}) {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:([a-zA-Z_]+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "/?$",
  );
  routes.push({ method, pattern, keys, scope, idempotent: opts.idempotent ?? false, handler });
}

// --- Route table ---------------------------------------------------------------------
route("GET", "/v1/me", "read", me.getMe);
route("GET", "/v1/health", null, async () => ({ status: 200, body: { ok: true } }));

route("GET", "/v1/books", "read", books.list);
route("POST", "/v1/books", "library:write", books.create, { idempotent: true });
route("GET", "/v1/books/:id", "read", books.get);
route("PATCH", "/v1/books/:id", "library:write", books.patch);
route("DELETE", "/v1/books/:id", "admin", books.remove);
route("POST", "/v1/books/:id/sessions", "library:write", books.createSession, { idempotent: true });
route("PATCH", "/v1/reading-sessions/:id", "library:write", books.patchSession);

route("GET", "/v1/readings", "read", readings.list);
route("POST", "/v1/readings", "library:write", readings.create, { idempotent: true });
route("GET", "/v1/readings/:id", "read", readings.get);
route("PATCH", "/v1/readings/:id", "library:write", readings.patch);
route("DELETE", "/v1/readings/:id", "admin", readings.remove);

route("GET", "/v1/recommendations", "read", recommendations.get);
route("GET", "/v1/recommendations/archive", "read", recommendations.archive);
route("PATCH", "/v1/recommendation-entries/:id", "library:write", recommendations.patchEntry);

route("GET", "/v1/feedback", "read", feedback.list);
route("POST", "/v1/feedback", "feedback:write", feedback.create, { idempotent: true });
route("PATCH", "/v1/feedback/:id", "feedback:write", feedback.patch);
route("DELETE", "/v1/feedback/:id", "feedback:write", feedback.remove);

route("GET", "/v1/preferences", "read", preferences.get);
route("PATCH", "/v1/preferences", "preferences:write", preferences.patch);
route("GET", "/v1/preference-summary", "read", preferences.summary);

route("POST", "/v1/recommendation-jobs", "generation", jobs.create, { idempotent: true });
route("GET", "/v1/jobs", "read", jobs.list);
route("GET", "/v1/generation-config", "read", config.get);
route("GET", "/v1/jobs/:id", "read", jobs.get);

route("GET", "/v1/integration-tokens", "admin", tokens.list);
route("POST", "/v1/integration-tokens", "admin", tokens.create);
route("DELETE", "/v1/integration-tokens/:id", "admin", tokens.revoke);

route("GET", "/v1/export", "read", transfer.exportJson);
route("GET", "/v1/export/books.csv", "read", transfer.exportBooksCsv);
route("POST", "/v1/import", "library:write", transfer.importJson);

// --- Dispatcher ---------------------------------------------------------------------
function apiPath(url: URL): string {
  // Supabase invokes the function at /api/... ; local dev may use /functions/v1/api/...
  let p = url.pathname.replace(/^\/functions\/v1/, "");
  p = p.replace(/^\/api(?=\/|$)/, "");
  return p || "/";
}

Deno.serve(async (req: Request) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  try {
    const url = new URL(req.url);
    const path = apiPath(url);
    const candidates = routes.filter((r) => r.pattern.test(path));
    const match = candidates.find((r) => r.method === req.method);
    if (!match) {
      if (candidates.length) throw new ApiError(405, "method_not_allowed", `${req.method} not allowed for ${path}`);
      throw new ApiError(404, "not_found", `No route for ${req.method} ${path}`);
    }
    const params: Record<string, string> = {};
    const m = match.pattern.exec(path)!;
    match.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));

    let ctx: Ctx | null = null;
    if (match.scope !== null) {
      ctx = await authenticate(req, requestId);
      requireScope(ctx, match.scope);
    }

    const rawBody = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
    let body: Record<string, unknown> = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new ApiError(400, "invalid_json", "Request body must be a JSON object");
      }
    }

    const run = () => match.handler(ctx as Ctx, params, body, url, req);
    const result = match.idempotent && ctx ? await withIdempotency(ctx, req, rawBody, run) : await run();

    if (result.body instanceof Response) return result.body;
    const headers: Record<string, string> = { "x-request-id": requestId };
    if ((result as { replayed?: boolean }).replayed) headers["idempotent-replayed"] = "true";
    return json(result.body, result.status, headers);
  } catch (err) {
    return errorResponse(err, requestId);
  }
});
