#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createApiClient, loadConfig } from './client.mjs';
import { createServer } from './server.mjs';

// stdout belongs exclusively to the MCP protocol. Credentials stay out of tool results.
try {
  const api = createApiClient(loadConfig());
  const handle = serveStdio(() => createServer(api));
  process.on('SIGINT', () => { void handle.close(); });
  process.on('SIGTERM', () => { void handle.close(); });
} catch (error) {
  console.error(`Reading MCP could not start: ${error.message}`);
  process.exitCode = 1;
}
