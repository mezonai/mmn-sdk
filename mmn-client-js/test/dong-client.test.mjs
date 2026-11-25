import test from 'node:test';
import assert from 'node:assert/strict';
import { DongClient } from '../dist/index.esm.js';

function makeJsonResponse(body, status = 200, statusText = 'OK') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async json() {
      return body;
    },
  };
}

async function withMockFetch(handler, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('DongClient.claimAmountRedEnvelopeQR sends query param id and POST payload and unwraps data', async () => {
  const client = new DongClient({
    endpoint: 'http://dong.local',
    headers: { 'X-Client': 'web' },
  });
  let captured;

  await withMockFetch(
    async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return makeJsonResponse({
        data: { split_money_id: 77, amount: 50000, description: 'Happy New Year' },
      });
    },
    async () => {
      const res = await client.claimAmountRedEnvelopeQR({
        id: 'env-123',
        user_id: 'u-9',
        proof_b64: 'p-b64',
        public_b64: 'pub-b64',
        publickey: 'pk-58',
      });

      assert.deepStrictEqual(res, {
        split_money_id: 77,
        amount: 50000,
        description: 'Happy New Year',
      });
      assert.strictEqual(
        captured.url,
        'http://dong.local/api/v1/red-envelopes/qr/claim-amount?id=env-123'
      );
      assert.strictEqual(captured.init.method, 'POST');
      assert.strictEqual(captured.init.headers['Content-Type'], 'application/json');
      assert.strictEqual(captured.init.headers['X-Client'], 'web');
      assert.deepStrictEqual(captured.body, {
        user_id: 'u-9',
        proof_b64: 'p-b64',
        public_b64: 'pub-b64',
        publickey: 'pk-58',
      });
    }
  );
});

test('DongClient.claimRedEnvelopeQR posts execution payload to /api/v1/red-envelopes/qr/:id/claim', async () => {
  const client = new DongClient({ endpoint: 'http://dong.local' });
  let captured;

  await withMockFetch(
    async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return makeJsonResponse({ data: null });
    },
    async () => {
      const result = await client.claimRedEnvelopeQR('env-456', {
        split_money_id: 88,
        user_id: 'u-10',
        proof_b64: 'p2',
        public_b64: 'pub2',
        publickey: 'pk2',
      });

      assert.strictEqual(result, undefined);
      assert.strictEqual(
        captured.url,
        'http://dong.local/api/v1/red-envelopes/qr/env-456/claim'
      );
      assert.strictEqual(captured.init.method, 'POST');
      assert.deepStrictEqual(captured.body, {
        split_money_id: 88,
        user_id: 'u-10',
        proof_b64: 'p2',
        public_b64: 'pub2',
        publickey: 'pk2',
      });
    }
  );
});

test('DongClient handles HTTP error, timeout abort, generic Error, and non-Error rejection', async () => {
  const client = new DongClient({ endpoint: 'http://dong.local', timeout: 20 });
  const claimParams = {
    split_money_id: 1,
    user_id: 'u1',
    proof_b64: 'p',
    public_b64: 'u',
    publickey: 'k',
  };

  await withMockFetch(
    async () => makeJsonResponse({}, 400, 'Bad Request'),
    async () => {
      await assert.rejects(() => client.claimRedEnvelopeQR('e1', claimParams), {
        message: 'HTTP 400: Bad Request',
      });
    }
  );

  await withMockFetch(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
    async () => {
      await assert.rejects(() => client.claimRedEnvelopeQR('e1', claimParams), {
        message: 'Request timeout after 20ms',
      });
    }
  );

  await withMockFetch(
    async () => {
      throw new Error('socket hang up');
    },
    async () => {
      await assert.rejects(() => client.claimRedEnvelopeQR('e1', claimParams), {
        message: 'socket hang up',
      });
    }
  );

  await withMockFetch(
    async () => {
      throw 'unexpected';
    },
    async () => {
      await assert.rejects(() => client.claimRedEnvelopeQR('e1', claimParams), {
        message: 'Request failed',
      });
    }
  );
});
