import test from 'node:test';
import assert from 'node:assert/strict';
import { ZkClient, EZkClientType } from '../dist/index.esm.js';

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

test('ZkClient.getZkProofs posts to /prove with default MEZON and custom OAUTH clientType', async () => {
  const client = new ZkClient({
    endpoint: 'http://zk.local',
    headers: { Authorization: 'Bearer tok' },
  });
  const calls = [];

  await withMockFetch(
    async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return makeJsonResponse({
        data: { proof: 'proof-xyz', public_input: 'pub-xyz' },
      });
    },
    async () => {
      const res1 = await client.getZkProofs({
        userId: 'u1',
        ephemeralPublicKey: 'epk1',
        jwt: 'jwt1',
        address: 'addr1',
      });
      const res2 = await client.getZkProofs({
        userId: 'u2',
        ephemeralPublicKey: 'epk2',
        jwt: 'jwt2',
        address: 'addr2',
        clientType: EZkClientType.OAUTH,
      });

      assert.deepStrictEqual(res1, { proof: 'proof-xyz', public_input: 'pub-xyz' });
      assert.deepStrictEqual(res2, { proof: 'proof-xyz', public_input: 'pub-xyz' });
      assert.strictEqual(calls[0].url, 'http://zk.local/prove');
      assert.strictEqual(calls[0].init.method, 'POST');
      assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer tok');
      assert.deepStrictEqual(calls[0].body, {
        user_id: 'u1',
        ephemeral_pk: 'epk1',
        jwt: 'jwt1',
        address: 'addr1',
        client_type: 'mezon',
      });
      assert.strictEqual(calls[1].body.client_type, 'oauth');
    }
  );
});

test('ZkClient handles HTTP error, timeout abort, generic Error, and non-Error rejection', async () => {
  const client = new ZkClient({ endpoint: 'http://zk.local', timeout: 20 });
  const req = {
    userId: 'u1',
    ephemeralPublicKey: 'epk1',
    jwt: 'jwt1',
    address: 'addr1',
  };

  await withMockFetch(
    async () => makeJsonResponse({}, 502, 'Bad Gateway'),
    async () => {
      await assert.rejects(() => client.getZkProofs(req), {
        message: 'HTTP 502: Bad Gateway',
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
      await assert.rejects(() => client.getZkProofs(req), {
        message: 'Request timeout after 20ms',
      });
    }
  );

  await withMockFetch(
    async () => {
      throw new Error('network down');
    },
    async () => {
      await assert.rejects(() => client.getZkProofs(req), {
        message: 'network down',
      });
    }
  );

  await withMockFetch(
    async () => {
      throw 42;
    },
    async () => {
      await assert.rejects(() => client.getZkProofs(req), {
        message: 'Request failed',
      });
    }
  );
});
