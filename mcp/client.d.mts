// Types for client.mjs, used when the Edge Function (supabase/functions/api/mcp.ts)
// imports the MCP server to serve it remotely.
export declare class ReadingError extends Error {
  constructor(code: string, message: string, extra?: Record<string, unknown>);
  code: string;
}
export interface ApiClient {
  request(method: string, path: string, options?: {
    query?: Record<string, unknown>;
    body?: unknown;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }): Promise<any>;
}
export declare function loadConfig(env?: Record<string, string | undefined>): { url?: string; token?: string };
export declare function validateConfig(config: { url?: string; token?: string }): { url: string; token: string };
export declare function createApiClient(
  config: { url?: string; token?: string },
  fetcher?: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): ApiClient;
