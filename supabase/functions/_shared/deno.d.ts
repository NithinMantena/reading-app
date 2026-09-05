// Minimal Deno typings so the Edge Function code can be type-checked with tsc
// (tsconfig.functions.json). The real runtime provides the full API.
declare namespace Deno {
  const env: { get(key: string): string | undefined };
  function resolveDns(query: string, recordType: "A" | "AAAA"): Promise<string[]>;
  function serve(handler: (req: Request) => Response | Promise<Response>): void;
}
