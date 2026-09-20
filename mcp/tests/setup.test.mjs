import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serverDefinition } from '../setup-lib.mjs';

test('Docker catalog uses native scoped secrets, no host mounts or credential literals', () => {
  const url = 'https://example.supabase.co/functions/v1/api/v1';
  const definition = serverDefinition(url, true);
  assert.deepEqual(definition.secrets, [{ name: 'reading-app.api_token', env: 'READING_APP_TOKEN', example: 'rap_your_integration_token' }]);
  assert.deepEqual(definition.env, [{ name: 'READING_APP_URL', value: url }]);
  assert.deepEqual(definition.allowHosts, ['example.supabase.co:443']);
  assert.equal(definition.volumes, undefined);
  assert.equal(serverDefinition(url).secrets, undefined);
  assert.throws(() => serverDefinition('http://example.com/api'));
});

test('Docker build context includes only runtime sources and locked dependencies', () => {
  const lines = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8').trim().split(/\r?\n/);
  assert.deepEqual(lines, ['*', '!package.json', '!package-lock.json', '!client.mjs', '!server.mjs', '!index.mjs']);
});
