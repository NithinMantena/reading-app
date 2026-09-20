import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { configPath, dockerCommand, imageName, readPrivateConfig } from './setup-lib.mjs';

const { values } = parseArgs({ options: {
  profile: { type: 'string' }, docker: { type: 'string' }, local: { type: 'boolean' }, 'allow-unconfigured': { type: 'boolean' },
} });
const client = new Client({ name: 'reading-connection-check', version: '1.0.0' });
const config = readPrivateConfig();
const command = values.local ? process.execPath : dockerCommand(values.docker);
const args = values.local ? [fileURLToPath(new URL('index.mjs', import.meta.url))]
  : values.profile ? ['mcp', 'gateway', 'run', '--profile', values.profile, '--tools', 'reading_get_account', '--log-calls=false']
    : ['run', '--rm', '-i', '-e', `READING_APP_URL=${config.url || ''}`, ...(config.authenticated ? ['-e', 'READING_APP_TOKEN=se://docker/mcp/reading-app.api_token'] : []), imageName];
const transport = new StdioClientTransport({ command, args, env: { ...process.env, READING_APP_CONFIG: configPath }, stderr: 'pipe' });
// Consume diagnostics without printing tool payloads or credentials.
let diagnostic = '';
transport.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-12000); });
try {
  await client.connect(transport, { timeout: 120000 });
  const { tools } = await client.listTools();
  const reading = tools.filter(tool => tool.name.startsWith('reading_'));
  if (!reading.some(tool => tool.name === 'reading_get_account')) throw new Error('Gateway did not expose reading_get_account. Check the profile and image installation.');
  console.log(`MCP handshake succeeded; ${reading.length} Reading tool(s) exposed${values.profile ? ' (account-only filter for this check)' : ''}.`);
  const result = await client.callTool({ name: 'reading_get_account', arguments: {} });
  if (result.isError) {
    const detail = JSON.parse(result.content.find(item => item.type === 'text').text).error;
    if (detail?.code === 'not_configured' && values['allow-unconfigured']) console.log('Tool execution verified. Authentication still needs the integration token.');
    else throw new Error(`Account check failed (${detail?.code || 'unknown'}). Run setup.mjs --token-only to configure or replace the token.`);
  } else console.log('Authenticated account check passed through MCP. No reading data was changed.');
} catch (error) {
  console.error(error.message);
  if (/secrets engine is not available/.test(diagnostic)) console.error('Docker reported an unavailable secrets-engine lookup. Reading uses native keychain injection; check Docker Desktop and the installed MCP CLI version if startup fails.');
  process.exitCode = 1;
} finally { await client.close(); }
