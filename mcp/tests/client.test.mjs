import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, validateConfig } from '../client.mjs';

const config = { url: 'https://example.supabase.co/functions/v1/api/v1', token: 'rap_test-secret' };
test('POST sends scoped auth and the supplied idempotency key without including it in the body', async () => {
  let request;
  const api = createApiClient(config, async (url, options) => { request = { url, ...options }; return Response.json({ id: 'book' }); });
  await api.request('POST', '/books', { body: { title: 'Book' }, idempotencyKey: 'same-action' });
  assert.equal(request.headers.authorization, `Bearer ${config.token}`);
  assert.equal(request.headers['idempotency-key'], 'same-action');
  assert.equal(request.redirect, 'error');
  assert.deepEqual(JSON.parse(request.body), { title: 'Book' });
});
test('unconfirmed writes return a reusable key without retrying or exposing the token', async () => {
  let calls = 0;
  const api = createApiClient(config, async () => { calls++; throw Error(config.token); });
  await assert.rejects(api.request('POST', '/books', { body: { title: 'Book' }, idempotencyKey: 'retry-key' }), (e) => {
    assert.equal(e.idempotency_key, 'retry-key');
    assert.equal(e.code, 'request_failed');
    assert.equal(e.message.includes(config.token), false);
    return true;
  });
  assert.equal(calls, 1);
});
test('API conflicts preserve actionable status without leaking credentials', async () => {
  const api = createApiClient(config, async () => Response.json({ error: { code: 'version_conflict', message: `Stale ${config.token}` }, requestId: 'req-1' }, { status: 409 }));
  await assert.rejects(api.request('PATCH', '/books/id', { body: { version: 1 } }), (e) => {
    assert.equal(e.status, 409); assert.equal(e.requestId, 'req-1'); assert.equal(e.message, 'Stale [redacted]'); return true;
  });
});
test('pagination preserves false and zero while omitting absent values', async () => {
  const api = createApiClient(config, async (url) => {
    assert.equal(url.searchParams.get('archived'), 'false'); assert.equal(url.searchParams.get('offset'), '0'); assert.equal(url.searchParams.has('q'), false);
    return Response.json({ items: [] });
  });
  await api.request('GET', '/books', { query: { archived: false, offset: 0, q: undefined } });
});
test('configuration rejects nonlocal cleartext URLs and nonintegration keys', () => {
  for (const url of ['http://example.org/api', 'https://user:password@example.org/api', 'https://example.org/api?token=x']) {
    assert.throws(() => validateConfig({ ...config, url }));
  }
  assert.throws(() => validateConfig({ ...config, token: 'service-role-key' }));
  assert.throws(() => validateConfig({}));
  assert.equal(validateConfig({ ...config, url: 'http://127.0.0.1:3456/v1/' }).url, 'http://127.0.0.1:3456/v1');
});
