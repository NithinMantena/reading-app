// Remote MCP endpoint for connectors that only take a URL (claude.ai and
// ChatGPT on the web and mobile). It serves exactly the Docker/desktop MCP
// server's tools by running its createServer() (mcp/server.mjs) here. Each tool
// call goes through this function's own /v1 router with the connector's
// integration token, so scopes, validation, versions and idempotency are the
// same as for the desktop MCP and the OpenClaw bot.
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createApiClient } from "../../../mcp/client.mjs";
import { createServer } from "../../../mcp/server.mjs";

// Never fetched over the network: requests go straight to `api`.
const INTERNAL_BASE = "https://reading.internal/api/v1";

export function createRemoteMcp(api: (request: Request) => Promise<Response>) {
  const handler = createMcpHandler(({ authInfo }) => {
    const token = authInfo?.token ?? "";
    return createServer(
      createApiClient({ url: INTERNAL_BASE, token }, (input: URL | RequestInfo, init?: RequestInit) => api(new Request(input, init))),
    );
  });
  return (request: Request, token: string) =>
    handler.fetch(request, { authInfo: { token, clientId: "remote-mcp", scopes: [] } });
}
