import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export class ReadingError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

export function loadConfig(env = process.env) {
  let file = {};
  const path = env.READING_APP_CONFIG || new URL('./config.local.json', import.meta.url);
  try { file = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read Reading MCP configuration; check that it contains valid JSON.'); }
  return { url: env.READING_APP_URL || file.url, token: env.READING_APP_TOKEN || file.token };
}

export function validateConfig(config) {
  if (!config.url || !config.token) throw new ReadingError('not_configured', 'Run node setup.mjs --token-only in the Reading MCP folder to configure your integration token, or set READING_APP_URL and READING_APP_TOKEN.');
  let url;
  try { url = new URL(config.url); } catch { throw new ReadingError('invalid_config', 'READING_APP_URL must be the full API base URL.'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new ReadingError('invalid_config', 'Use an HTTPS API URL without credentials, query parameters, or a fragment (HTTP is allowed only for localhost development).');
  }
  if (!config.token.startsWith('rap_')) throw new ReadingError('invalid_config', 'Use a Reading integration token beginning rap_, not a Supabase service-role key.');
  return { url: url.href.replace(/\/$/, ''), token: config.token.trim() };
}

export function createApiClient(config, fetcher = fetch) {
  return {
    async request(method, path, { query = {}, body, idempotencyKey, signal } = {}) {
      const { url: base, token } = validateConfig(config);
      if (!/^\/[a-z]/.test(path) || path.includes('..')) throw new ReadingError('invalid_path', 'Invalid API path.');
      const url = new URL(base + path);
      for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const key = method === 'POST' ? idempotencyKey || randomUUID() : undefined;
      if (key) headers['idempotency-key'] = key;
      const timeout = AbortSignal.timeout(25000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response, json;
      try {
        response = await fetcher(url, { method, headers, redirect: 'error', signal: combined, body: body === undefined ? undefined : JSON.stringify(body) });
        json = await response.json();
      } catch {
        throw new ReadingError('request_failed', method === 'GET'
          ? 'The Reading API could not be reached or returned an invalid response.'
          : 'The write could not be confirmed. Check the record or job before retrying. For POST retries, reuse the returned idempotency_key and identical arguments.',
        { idempotency_key: key });
      }
      if (!response.ok) {
        const message = typeof json?.error?.message === 'string' ? json.error.message.split(token).join('[redacted]') : `Reading API returned HTTP ${response.status}.`;
        throw new ReadingError(json?.error?.code || 'api_error', message,
          { status: response.status, requestId: json?.requestId, idempotency_key: key });
      }
      return json;
    },
  };
}
