import test from 'node:test';
import assert from 'node:assert/strict';
import { IndexerClient } from '../dist/index.esm.js';

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

test('IndexerClient.getTransactionByHash and getWalletDetail fetch expected endpoints', async () => {
  const client = new IndexerClient({
    endpoint: 'http://indexer.local',
    chainId: '1337',
    headers: { 'X-Trace': 't1' },
  });
  const urls = [];

  await withMockFetch(
    async (url, init) => {
      urls.push({ url, headers: init.headers });
      if (url.endsWith('/tx/0xabc/detail')) {
        return makeJsonResponse({ data: { transaction: { hash: '0xabc', value: '10' } } });
      }
      return makeJsonResponse({
        data: { address: 'w1', balance: '500', account_nonce: 3, last_balance_update: 99 },
      });
    },
    async () => {
      const tx = await client.getTransactionByHash('0xabc');
      const wallet = await client.getWalletDetail('w1');

      assert.deepStrictEqual(tx, { hash: '0xabc', value: '10' });
      assert.deepStrictEqual(wallet, {
        address: 'w1',
        balance: '500',
        account_nonce: 3,
        last_balance_update: 99,
      });
      assert.strictEqual(urls[0].url, 'http://indexer.local/1337/tx/0xabc/detail');
      assert.strictEqual(urls[0].headers['X-Trace'], 't1');
      assert.strictEqual(urls[1].url, 'http://indexer.local/1337/wallets/w1/detail');
    }
  );

  await assert.rejects(() => client.getWalletDetail(''), {
    message: 'wallet address cannot be empty',
  });
});

test('IndexerClient.getTransactionsByWalletBeforeTimestamp builds query params for filters and limits', async () => {
  const client = new IndexerClient({ endpoint: 'http://indexer.local', chainId: '1337' });
  const urls = [];

  await assert.rejects(() => client.getTransactionsByWalletBeforeTimestamp('', 0), {
    message: 'wallet address cannot be empty',
  });

  await withMockFetch(
    async (url) => {
      urls.push(new URL(url));
      return makeJsonResponse({ meta: { chain_id: 1337, page: 0 }, data: [] });
    },
    async () => {
      await client.getTransactionsByWalletBeforeTimestamp('w1', 0);
      await client.getTransactionsByWalletBeforeTimestamp('w1', 1, 5000, '170000', '0xh');
      await client.getTransactionsByWalletBeforeTimestamp('w1', 2, 15);
      await client.getTransactionsByWalletBeforeTimestamp('w1', 99, -5);
    }
  );

  assert.strictEqual(urls[0].pathname, '/1337/transactions/infinite');
  assert.strictEqual(urls[0].searchParams.get('limit'), '20');
  assert.strictEqual(urls[0].searchParams.get('wallet_address'), 'w1');
  assert.strictEqual(urls[0].searchParams.get('timestamp_lt'), null);

  assert.strictEqual(urls[1].searchParams.get('limit'), '1000');
  assert.strictEqual(urls[1].searchParams.get('filter_to_address'), 'w1');
  assert.strictEqual(urls[1].searchParams.get('timestamp_lt'), '170000');
  assert.strictEqual(urls[1].searchParams.get('last_hash'), '0xh');

  assert.strictEqual(urls[2].searchParams.get('limit'), '15');
  assert.strictEqual(urls[2].searchParams.get('filter_from_address'), 'w1');

  assert.strictEqual(urls[3].searchParams.get('limit'), '20');
  assert.strictEqual(urls[3].searchParams.get('wallet_address'), null);
  assert.strictEqual(urls[3].searchParams.get('filter_from_address'), null);
  assert.strictEqual(urls[3].searchParams.get('filter_to_address'), null);
});

test('IndexerClient.getTransactionByWallet clamps pagination and applies filters and sorting', async () => {
  const client = new IndexerClient({ endpoint: 'http://indexer.local', chainId: '1337' });
  const urls = [];

  await assert.rejects(() => client.getTransactionByWallet('', 1, 10, 0), {
    message: 'wallet address cannot be empty',
  });

  await withMockFetch(
    async (url) => {
      urls.push(new URL(url));
      return makeJsonResponse({ meta: { chain_id: 1337, page: 0 }, data: [] });
    },
    async () => {
      await client.getTransactionByWallet('w1', 0, 0, 0);
      await client.getTransactionByWallet('w1', 3, 2000, 1, 'block_number', 'asc');
      await client.getTransactionByWallet('w1', 2, 25, 2);
      await client.getTransactionByWallet('w1', undefined, undefined, 99);
    }
  );

  assert.strictEqual(urls[0].pathname, '/1337/transactions');
  assert.strictEqual(urls[0].searchParams.get('page'), '0');
  assert.strictEqual(urls[0].searchParams.get('limit'), '50');
  assert.strictEqual(urls[0].searchParams.get('wallet_address'), 'w1');
  assert.strictEqual(urls[0].searchParams.get('sort_by'), 'transaction_timestamp');
  assert.strictEqual(urls[0].searchParams.get('sort_order'), 'desc');

  assert.strictEqual(urls[1].searchParams.get('page'), '2');
  assert.strictEqual(urls[1].searchParams.get('limit'), '1000');
  assert.strictEqual(urls[1].searchParams.get('filter_to_address'), 'w1');
  assert.strictEqual(urls[1].searchParams.get('sort_by'), 'block_number');
  assert.strictEqual(urls[1].searchParams.get('sort_order'), 'asc');

  assert.strictEqual(urls[2].searchParams.get('page'), '1');
  assert.strictEqual(urls[2].searchParams.get('limit'), '25');
  assert.strictEqual(urls[2].searchParams.get('filter_from_address'), 'w1');

  assert.strictEqual(urls[3].searchParams.get('page'), '0');
  assert.strictEqual(urls[3].searchParams.get('limit'), '50');
  assert.strictEqual(urls[3].searchParams.get('wallet_address'), null);
});

test('IndexerClient handles HTTP error, timeout abort, Error rethrow, and non-Error rejection', async () => {
  const client = new IndexerClient({
    endpoint: 'http://indexer.local',
    chainId: '1337',
    timeout: 20,
  });

  await withMockFetch(
    async () => makeJsonResponse({}, 404, 'Not Found'),
    async () => {
      await assert.rejects(() => client.getTransactionByHash('0xmissing'), {
        message: 'HTTP 404: Not Found',
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
      await assert.rejects(() => client.getWalletDetail('w1'), {
        message: 'Request timeout after 20ms',
      });
    }
  );

  await withMockFetch(
    async () => {
      throw new Error('dns failure');
    },
    async () => {
      await assert.rejects(() => client.getWalletDetail('w1'), {
        message: 'dns failure',
      });
    }
  );

  await withMockFetch(
    async () => {
      throw null;
    },
    async () => {
      await assert.rejects(() => client.getWalletDetail('w1'), {
        message: 'Request failed',
      });
    }
  );
});
