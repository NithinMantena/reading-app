import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const id = '11111111-1111-4111-8111-111111111111';
let http, client, transport;
const requests = [];
before(async () => {
  http = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = raw ? JSON.parse(raw) : undefined;
    requests.push({ path: req.url, method: req.method, headers: req.headers, body: data });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/v1/jobs/')) res.end(JSON.stringify({ id, status: 'succeeded', checkpoint: { huge: 'private candidate evidence' }, batch_id: id }));
    else if (req.url === '/v1/recommendation-jobs') res.end(JSON.stringify({ jobs: [{ id, kind: data.kind, checkpoint: {} }], warnings: [] }));
    else if (req.method === 'PATCH' && data?.version === 1) { res.statusCode = 409; res.end(JSON.stringify({ error: { code: 'version_conflict', message: 'Reload the book' } })); }
    else res.end(JSON.stringify({ ok: true, id, echoed: data ?? null }));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  transport = new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../index.mjs', import.meta.url))], stderr: 'pipe',
    env: { READING_APP_URL: `http://127.0.0.1:${http.address().port}/v1`, READING_APP_TOKEN: 'rap_test-only' },
  });
  client = new Client({ name: 'reading-tests', version: '1.0.0' });
  await client.connect(transport);
});
after(async () => { await client?.close(); await new Promise(resolve => http?.close(resolve)); });
const call = (name, args = {}) => client.callTool({ name: `reading_${name}`, arguments: args });
const dataOf = result => result.structuredContent ?? JSON.parse(result.content[0].text);

test('real stdio handshake discovers all requested capabilities', async () => {
  const result = await client.listTools();
  const names = result.tools.map(t => t.name);
  for (const name of ['get_discovery', 'add_to_reading_queue', 'add_interest', 'add_book', 'edit_book', 'find_alternatives', 'give_feedback']) assert(names.includes(`reading_${name}`));
  assert.equal(result.tools.find(t => t.name === 'reading_get_discovery').annotations.readOnlyHint, true);
  assert.equal(result.tools.find(t => t.name === 'reading_find_alternatives').annotations.readOnlyHint, false);
  assert.equal(result.tools.some(t => /token|delete_book|import/.test(t.name)), false);
});
test('discovery and pagination reach the API over stdio', async () => {
  const result = await call('get_discovery', { horizon: 'weekly' }); assert.equal(result.isError, undefined);
  assert.equal(requests.at(-1).path, '/v1/recommendations?horizon=weekly');
  await call('list_books', { offset: 50, limit: 20, archived: false });
  assert(requests.at(-1).path.includes('offset=50')); assert(requests.at(-1).path.includes('archived=false'));
});
test('interest edits and recommendation saves preserve their narrow API contract', async () => {
  await call('add_interest', { topic: 'Physics', weight: 2, idempotency_key: 'interest-action' });
  assert.equal(requests.at(-1).headers['idempotency-key'], 'interest-action');
  assert.deepEqual(requests.at(-1).body, { topic: 'Physics', weight: 2 });
  await call('remove_interest', { topic: 'Art / science' });
  assert.equal(requests.at(-1).path, '/v1/preferences/interests/Art%20%2F%20science');
  await call('save_recommendation', { id });
  assert.deepEqual(requests.at(-1).body, { state: 'saved' });
});
test('book changes carry versions and preserve unknown dates and zero ratings', async () => {
  await call('edit_book', { id, version: 3, rating: 0, finished_on: null });
  assert.deepEqual(requests.at(-1).body, { version: 3, rating: 0, finished_on: null });
  const result = await call('edit_book', { id, version: 1, notes: 'New note' });
  assert.equal(result.isError, true); assert.equal(dataOf(result).error.code, 'version_conflict');
});
test('invalid arguments cannot send a write', async () => {
  const before = requests.length;
  try {
    const result = await call('edit_book', { id, title: 'Missing version' });
    assert.equal(result.isError, true);
  } catch (error) { assert.match(error.message, /version|invalid|validation/i); }
  assert.equal(requests.length, before);
  assert.equal((await call('add_to_reading_queue', {})).isError, true);
});
test('alternatives target the selected edition and jobs omit the checkpoint', async () => {
  const result = dataOf(await call('find_alternatives', { batch_id: id }));
  assert.deepEqual(requests.at(-1).body, { batch_id: id, kind: 'alternatives' });
  assert.equal('checkpoint' in result.jobs[0], false);
  const job = dataOf(await call('get_generation_job', { id }));
  assert.equal(job.status, 'succeeded'); assert.equal('checkpoint' in job, false);
});
