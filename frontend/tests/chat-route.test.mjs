import test from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../src/app/backend/api/v1/chat/route.ts';

const request = () => new Request('http://localhost/backend/api/v1/chat', {
  method: 'POST', body: JSON.stringify({ message: 'Synthetic question' }),
});

test('chat forwards the complete answer/evidence and backend status', async (t) => {
  const payload = { answer: 'Synthetic answer', evidence: [{ memory_id: 'synthetic', sources: [{ evidence_text: 'Original quote' }] }] };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:8000/api/v1/chat');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { message: 'Synthetic question' });
    assert.equal(init.signal.aborted, false);
    return Response.json(payload);
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), payload);
});

test('chat retains backend validation failures', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: 'Invalid message' }, { status: 422 }));
  const response = await POST(request());
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { detail: 'Invalid message' });
});

test('unavailable backend gives an actionable error without leaking internals', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private connection details'); });
  const response = await POST(request());
  assert.equal(response.status, 503);
  assert.match((await response.json()).detail, /local answer service is unavailable/);
});

test('deadline covers reading the response body, not just headers', async (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    assert.equal(milliseconds, 120_000);
    return controller.signal;
  });
  t.mock.method(globalThis, 'fetch', async () => ({
    text: async () => { controller.abort(); throw new DOMException('Aborted', 'AbortError'); },
  }));
  const response = await POST(request());
  assert.equal(response.status, 504);
});
