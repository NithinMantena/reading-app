import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createApiClient, validateConfig } from './client.mjs';
import { configPath, dockerCommand, imageName, readPrivateConfig, run, serverDefinition, writePrivateConfig } from './setup-lib.mjs';

// Read directly from a terminal so the token never enters command history or console output.
async function readToken() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('Run setup in an interactive terminal; the token prompt requires a TTY.');
  process.stdout.write('Paste the Reading integration token (input is hidden), then press Enter: ');
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
      error ? reject(error) : resolve(value.trim());
    };
    const onData = chunk => {
      for (const character of chunk) {
        if (character === '\u0003') { finish(new Error('Setup cancelled.')); return; }
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  const { values } = parseArgs({ options: {
    url: { type: 'string' }, profile: { type: 'string' }, docker: { type: 'string' },
    local: { type: 'boolean' }, 'skip-token': { type: 'boolean' }, 'token-only': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Docker: node setup.mjs --profile PROFILE --url HTTPS_API_BASE [--skip-token]\nToken:  node setup.mjs --token-only\nLocal:  node setup.mjs --local --url API_BASE\nThe token is entered at a hidden terminal prompt, never as a command argument.');
    return;
  }
  if (values['skip-token'] && values['token-only']) throw new Error('Choose --skip-token or --token-only, not both.');
  if (values['token-only'] && values.url) throw new Error('Changing the URL requires a full setup so the Docker network configuration is updated.');
  if (!values.local && !values['token-only'] && !values.profile) throw new Error('Provide the existing Docker --profile ID, or use --local.');
  const previous = readPrivateConfig();
  const mode = values.local ? 'local' : values['token-only'] ? previous.mode || 'local' : 'docker';
  if (values['skip-token'] && previous.mode && previous.mode !== mode) throw new Error('Changing connection mode requires entering a token again; omit --skip-token.');
  const config = { url: values.url || previous.url, mode, profile: values.profile || previous.profile, docker: values.docker || previous.docker, authenticated: previous.authenticated };
  if (!config.url) throw new Error('Provide --url with the full API base, ending /functions/v1/api/v1.');
  // Validate the URL even when intentionally staging installation without a credential.
  config.url = validateConfig({ ...config, token: 'rap_configuration-check' }).url;
  if (mode === 'docker' && !config.profile) throw new Error('Provide --profile for Docker setup.');
  const docker = dockerCommand(config.docker);
  if (mode === 'docker') serverDefinition(config.url);
  let token = previous.token;
  if (!values['skip-token']) {
    token = await readToken();
    await createApiClient({ url: config.url, token }).request('GET', '/me');
    console.log('Token verified by the Reading API.');
    if (mode === 'docker') {
      // The Docker keychain supports stdin and native container-time injection,
      // even where the MCP CLI's secrets-engine socket lookup is unavailable.
      run(docker, ['pass', 'set', 'docker/mcp/reading-app.api_token', '--force'], { input: token, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    config.authenticated = true;
  } else if ((previous.token || previous.authenticated) && previous.url !== config.url) {
    throw new Error('Changing the API URL requires entering a token again; omit --skip-token.');
  }
  if (mode === 'local') config.token = token;
  writePrivateConfig(config);
  console.log(`Private configuration saved to ${configPath}`);
  if (mode === 'docker') {
    if (!values['token-only']) run(docker, ['build', '--tag', imageName, fileURLToPath(new URL('.', import.meta.url))]);
    const directory = join(homedir(), '.docker', 'mcp', 'catalogs');
    mkdirSync(directory, { recursive: true });
    const catalog = join(directory, 'reading-app.json');
    writeFileSync(catalog, `${JSON.stringify(serverDefinition(config.url, config.authenticated), null, 2)}\n`);
    // Docker resolves this relative to ~/.docker/mcp/catalogs. An absolute file URI
    // with a Windows drive letter is misparsed by some Docker MCP CLI versions.
    run(docker, ['mcp', 'profile', 'server', 'add', config.profile, '--server', 'file://reading-app.json']);
    console.log(`Reading App added to Docker profile ${config.profile}. Other servers are preserved.`);
  }
  console.log(config.authenticated ? 'Restart your connected clients, then ask them to check the Reading account.' : 'Installation staged. Create an integration token in the app, then run: node setup.mjs --token-only');
  if (values.local) console.log(`Local MCP command: ${process.execPath}\nArguments: ${fileURLToPath(new URL('index.mjs', import.meta.url))}\nEnvironment: READING_APP_CONFIG=${configPath}`);
}

main().catch(error => { console.error(`Setup failed: ${error.message}`); process.exitCode = 1; });
