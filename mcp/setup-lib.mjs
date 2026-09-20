import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const configDirectory = join(homedir(), '.config', 'reading-app', 'mcp');
export const configPath = join(configDirectory, 'config.json');
export const imageName = 'reading-app-mcp:local';

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}.`);
  return result.stdout?.toString().trim();
}

export function dockerCommand(override) {
  if (override) return override;
  if (process.platform === 'win32') {
    const candidates = [
      join(process.env.LOCALAPPDATA || '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'),
      join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
    ];
    const found = candidates.find(existsSync);
    if (found) return found;
  }
  return 'docker';
}

export function readPrivateConfig() {
  try { return JSON.parse(readFileSync(configPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error(`Cannot read ${configPath}. Fix the JSON before continuing.`); }
}

export function writePrivateConfig(config) {
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const sid = run('powershell.exe', ['-NoProfile', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { stdio: 'pipe', encoding: 'utf8' });
    if (!/^S-1-[\d-]+$/.test(sid)) throw new Error('Cannot determine the Windows user for private file permissions.');
    run('icacls.exe', [configDirectory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { stdio: 'pipe' });
  } else chmodSync(configDirectory, 0o700);
  // Create with private permissions before writing any token, then replace atomically.
  const temp = join(configDirectory, `${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, configPath);
}

export function serverDefinition(url, authenticated = false) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:') throw new Error('Docker setup requires an HTTPS API URL. Use local mode for localhost development.');
  return {
    name: 'reading-app', title: 'Reading App', type: 'server', image: imageName,
    description: 'Manage discovery articles, reading queue, interests, books, reading sessions, feedback and alternative recommendations.',
    env: [{ name: 'READING_APP_URL', value: url }],
    ...(authenticated ? { secrets: [{ name: 'reading-app.api_token', env: 'READING_APP_TOKEN', example: 'rap_your_integration_token' }] } : {}),
    allowHosts: [endpoint.host.includes(':') ? endpoint.host : `${endpoint.host}:443`],
  };
}
