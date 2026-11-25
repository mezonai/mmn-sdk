import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  MmnClient,
  createMmnClient,
  ETransferType,
} from '../dist/index.esm.js';

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

function serializeExpected(tx) {
  const data = `${tx.type}|${tx.sender}|${tx.recipient}|${tx.amount}|${tx.text_data}|${tx.nonce}|${tx.extra_info}`;
  return Buffer.from(data, 'utf8');
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

test('createMmnClient constructs MmnClient', () => {
  const client = createMmnClient({ baseUrl: 'http://rpc.local' });
  assert.ok(client instanceof MmnClient);
});

test('getAddressFromUserId matches canonical SHA-256 base58 vector', () => {
  const client = new MmnClient({ baseUrl: 'http://rpc.local' });
  const addr = client.getAddressFromUserId('3767478432163172990');
  assert.strictEqual(addr, 'DqrAfFo3yDQJhKuUo948RG4XfygHJPEe4UhcXxHF8hS2');
  assert.strictEqual(client.validateAddress(addr), true);
  assert.strictEqual(client.getAddressFromUserId('3767478432163172990'), addr);
});

test('generateEphemeralKeyPair creates valid Ed25519 PKCS#8 private key and matching base58 public key', () => {
  const client = new MmnClient({ baseUrl: 'http://rpc.local' });
  const kp1 = client.generateEphemeralKeyPair();
  const kp2 = client.generateEphemeralKeyPair();

  assert.notStrictEqual(kp1.privateKey, kp2.privateKey);
  assert.notStrictEqual(kp1.publicKey, kp2.publicKey);
  assert.strictEqual(client.validateAddress(kp1.publicKey), true);

  const der = Buffer.from(kp1.privateKey, 'hex');
  assert.ok(der.length >= 32);
  const seed = der.subarray(-32);
  const derived = nacl.sign.keyPair.fromSeed(seed);
  assert.strictEqual(bs58.encode(derived.publicKey), kp1.publicKey);
});

test('validateAddress handles valid, wrong-length, empty, non-base58, and non-string inputs', () => {
  const client = new MmnClient({ baseUrl: 'http://rpc.local' });
  const validAddr = bs58.encode(new Uint8Array(32).fill(7));
  const shortAddr = bs58.encode(new Uint8Array(31).fill(7));
  const longAddr = bs58.encode(new Uint8Array(33).fill(7));

  assert.strictEqual(client.validateAddress(validAddr), true);
  assert.strictEqual(client.validateAddress(shortAddr), false);
  assert.strictEqual(client.validateAddress(longAddr), false);
  assert.strictEqual(client.validateAddress(''), false);
  assert.strictEqual(client.validateAddress('0OIl!@#invalid'), false);
  assert.strictEqual(client.validateAddress(null), false);
  assert.strictEqual(client.validateAddress(undefined), false);
});

test('scaleAmountToDecimals scales numeric and string amounts', () => {
  const client = new MmnClient({ baseUrl: 'http://rpc.local' });
  assert.strictEqual(client.scaleAmountToDecimals(1), '1000000');
  assert.strictEqual(client.scaleAmountToDecimals('25'), '25000000');
  assert.strictEqual(client.scaleAmountToDecimals(0), '0');
  assert.strictEqual(client.scaleAmountToDecimals('12', 9), '12000000000');
  assert.strictEqual(client.scaleAmountToDecimals(5, 0), '5');
});

test('validateAmount compares balances against string and number amounts', () => {
  const client = new MmnClient({ baseUrl: 'http://rpc.local' });
  assert.strictEqual(client.validateAmount('1000000', '1000000'), true);
  assert.strictEqual(client.validateAmount('1000000', '999999'), true);
  assert.strictEqual(client.validateAmount('1000000', '1000001'), false);
  assert.strictEqual(client.validateAmount('2000000', 2), true);
  assert.strictEqual(client.validateAmount('1999999', 2), false);
});

test('sendTransaction signs TRANSFER_BY_ZK transaction with verifiable wrapped Ed25519 signature', async () => {
  const client = new MmnClient({
    baseUrl: 'http://rpc.local',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'k1' },
  });
  const kp = client.generateEphemeralKeyPair();
  const captured = [];

  await withMockFetch(
    async (url, init) => {
      captured.push({ url, init, body: JSON.parse(init.body) });
      return makeJsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { ok: true, tx_hash: '0xzkhash', error: '' },
      });
    },
    async () => {
      const res = await client.sendTransaction({
        sender: 'user-alice',
        recipient: 'user-bob',
        amount: '5000000',
        nonce: 7,
        timestamp: 1700000000,
        textData: 'hello zk',
        privateKey: kp.privateKey,
        publicKey: kp.publicKey,
        zkProof: 'proof-b64',
        zkPub: 'pub-b64',
        extraInfo: { type: ETransferType.TransferToken, ClanId: 'c1' },
      });

      assert.deepStrictEqual(res, { ok: true, tx_hash: '0xzkhash', error: '' });
      assert.strictEqual(captured.length, 1);
      assert.strictEqual(captured[0].url, 'http://rpc.local');
      assert.strictEqual(captured[0].init.method, 'POST');
      assert.strictEqual(captured[0].init.headers['X-Api-Key'], 'k1');

      const rpc = captured[0].body;
      assert.strictEqual(rpc.jsonrpc, '2.0');
      assert.strictEqual(rpc.method, 'tx.addtx');
      assert.strictEqual(rpc.id, 1);

      const { tx_msg: tx, signature } = rpc.params;
      assert.strictEqual(tx.type, 0);
      assert.strictEqual(tx.sender, client.getAddressFromUserId('user-alice'));
      assert.strictEqual(tx.recipient, client.getAddressFromUserId('user-bob'));
      assert.strictEqual(tx.amount, '5000000');
      assert.strictEqual(tx.nonce, 7);
      assert.strictEqual(tx.timestamp, 1700000000);
      assert.strictEqual(tx.text_data, 'hello zk');
      assert.strictEqual(tx.zk_proof, 'proof-b64');
      assert.strictEqual(tx.zk_pub, 'pub-b64');
      assert.deepStrictEqual(JSON.parse(tx.extra_info), {
        type: ETransferType.TransferToken,
        ClanId: 'c1',
      });

      const userSig = JSON.parse(Buffer.from(bs58.decode(signature)).toString('utf8'));
      const pubKeyBytes = Buffer.from(userSig.PubKey, 'base64');
      const sigBytes = Buffer.from(userSig.Sig, 'base64');
      assert.strictEqual(bs58.encode(pubKeyBytes), kp.publicKey);
      assert.strictEqual(
        nacl.sign.detached.verify(serializeExpected(tx), sigBytes, pubKeyBytes),
        true
      );
    }
  );
});

test('sendTransactionByAddress uses raw addresses and default optional fields', async () => {
  const client = new MmnClient({ baseUrl: 'http://rpc.local' });
  const kp = client.generateEphemeralKeyPair();
  const sender = client.getAddressFromUserId('sender-1');
  const recipient = client.getAddressFromUserId('recipient-1');
  let rpc;

  await withMockFetch(
    async (_url, init) => {
      rpc = JSON.parse(init.body);
      return makeJsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { ok: true, tx_hash: '0xaddrhash', error: '' },
      });
    },
    async () => {
      const res = await client.sendTransactionByAddress({
        sender,
        recipient,
        amount: '100',
        nonce: 1,
        privateKey: kp.privateKey,
        publicKey: kp.publicKey,
        zkProof: 'p',
        zkPub: 'u',
      });
      assert.strictEqual(res.tx_hash, '0xaddrhash');
      assert.strictEqual(rpc.params.tx_msg.type, 0);
      assert.strictEqual(rpc.params.tx_msg.sender, sender);
      assert.strictEqual(rpc.params.tx_msg.recipient, recipient);
      assert.strictEqual(rpc.params.tx_msg.text_data, '');
      assert.strictEqual(rpc.params.tx_msg.extra_info, '');
      assert.ok(rpc.params.tx_msg.timestamp > 0);
    }
  );
});

test('sendTransactionByPrivateKey signs TRANSFER_BY_KEY with raw base58 Ed25519 signature', async () => {
  const client = new MmnClient({ baseUrl: 'http://rpc.local' });
  const kp = client.generateEphemeralKeyPair();
  const recipient = client.getAddressFromUserId('recipient-2');
  let rpc;

  await withMockFetch(
    async (_url, init) => {
      rpc = JSON.parse(init.body);
      return makeJsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { ok: true, tx_hash: '0xkeyhash', error: '' },
      });
    },
    async () => {
      const res = await client.sendTransactionByPrivateKey({
        sender: kp.publicKey,
        recipient,
        amount: '999',
        nonce: 2,
        timestamp: 1700000100,
        textData: 'by key',
        privateKey: kp.privateKey,
        extraInfo: { type: ETransferType.GiveCoffee },
      });

      assert.strictEqual(res.tx_hash, '0xkeyhash');
      const { tx_msg: tx, signature } = rpc.params;
      assert.strictEqual(tx.type, 1);
      assert.strictEqual(tx.zk_proof, '');
      assert.strictEqual(tx.zk_pub, '');

      const sigBytes = bs58.decode(signature);
      assert.strictEqual(sigBytes.length, 64);
      assert.strictEqual(
        nacl.sign.detached.verify(
          serializeExpected(tx),
          sigBytes,
          bs58.decode(kp.publicKey)
        ),
        true
      );
    }
  );
});

test('postDonationCampaignFeed signs USER_CONTENT transaction with wrapped Ed25519 signature', async () => {
  const client = new MmnClient({ baseUrl: 'http://rpc.local' });
  const kp = client.generateEphemeralKeyPair();
  const sender = client.getAddressFromUserId('creator-1');
  const recipient = client.getAddressFromUserId('campaign-1');
  let rpc;

  await withMockFetch(
    async (_url, init) => {
      rpc = JSON.parse(init.body);
      return makeJsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { ok: true, tx_hash: '0xfeedhash', error: '' },
      });
    },
    async () => {
      const res = await client.postDonationCampaignFeed({
        sender,
        recipient,
        amount: '0',
        nonce: 3,
        timestamp: 1700000200,
        textData: 'campaign post',
        privateKey: kp.privateKey,
        publicKey: kp.publicKey,
        zkProof: 'zkp',
        zkPub: 'zku',
        extraInfo: { type: ETransferType.UnlockItem, ItemId: 'item-9' },
      });

      assert.strictEqual(res.tx_hash, '0xfeedhash');
      const { tx_msg: tx, signature } = rpc.params;
      assert.strictEqual(tx.type, 2);
      const userSig = JSON.parse(Buffer.from(bs58.decode(signature)).toString('utf8'));
      assert.strictEqual(
        nacl.sign.detached.verify(
          serializeExpected(tx),
          Buffer.from(userSig.Sig, 'base64'),
          Buffer.from(userSig.PubKey, 'base64')
        ),
        true
      );
    }
  );
});

test('createAndSignTx validation errors cover invalid non-base58 addresses, same address, and invalid private keys', async () => {
  const client = new MmnClient({ baseUrl: 'http://rpc.local' });
  const kp = client.generateEphemeralKeyPair();
  const validA = client.getAddressFromUserId('valid-a');
  const validB = client.getAddressFromUserId('valid-b');

  await assert.rejects(
    () =>
      client.sendTransactionByPrivateKey({
        sender: '0OIl-not-base58',
        recipient: validB,
        amount: '1',
        nonce: 1,
        privateKey: kp.privateKey,
      }),
    { message: 'Invalid sender address' }
  );

  await assert.rejects(
    () =>
      client.sendTransactionByPrivateKey({
        sender: validA,
        recipient: '0OIl-not-base58',
        amount: '1',
        nonce: 1,
        privateKey: kp.privateKey,
      }),
    { message: 'Invalid recipient address' }
  );

  await assert.rejects(
    () =>
      client.sendTransactionByPrivateKey({
        sender: validA,
        recipient: '1111',
        amount: '1',
        nonce: 1,
        privateKey: kp.privateKey,
      }),
    { message: 'Invalid recipient address' }
  );

  await assert.rejects(
    () =>
      client.sendTransactionByPrivateKey({
        sender: validA,
        recipient: validA,
        amount: '1',
        nonce: 1,
        privateKey: kp.privateKey,
      }),
    { message: 'Sender and recipient addresses cannot be the same' }
  );

  await assert.rejects(
    () =>
      client.sendTransactionByPrivateKey({
        sender: validA,
        recipient: validB,
        amount: '1',
        nonce: 1,
        privateKey: '',
      }),
    /Transaction signing failed: Invalid private key format/
  );

  await assert.rejects(
    () =>
      client.sendTransactionByPrivateKey({
        sender: validA,
        recipient: validB,
        amount: '1',
        nonce: 1,
        privateKey: 'abcd',
      }),
    /Transaction signing failed: Invalid private key length/
  );
});

test('getCurrentNonce, getCurrentNonceByAddress, and getAccountByUserId invoke expected JSON-RPC methods', async () => {
  const client = new MmnClient({ baseUrl: 'http://rpc.local' });
  const calls = [];

  await withMockFetch(
    async (_url, init) => {
      const rpc = JSON.parse(init.body);
      calls.push(rpc);
      if (rpc.method === 'account.getcurrentnonce') {
        return makeJsonResponse({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { address: rpc.params.address, nonce: 42, tag: rpc.params.tag, error: '' },
        });
      }
      return makeJsonResponse({
        jsonrpc: '2.0',
        id: rpc.id,
        result: { address: rpc.params.address, balance: '1000000', nonce: 42, decimals: 6 },
      });
    },
    async () => {
      const expectedAddr = client.getAddressFromUserId('u-123');
      const n1 = await client.getCurrentNonce('u-123');
      const n2 = await client.getCurrentNonce('u-123', 'pending');
      const n3 = await client.getCurrentNonceByAddress(expectedAddr);
      const n4 = await client.getCurrentNonceByAddress(expectedAddr, 'pending');
      const acc = await client.getAccountByUserId('u-123');

      assert.strictEqual(n1.nonce, 42);
      assert.strictEqual(n2.tag, 'pending');
      assert.strictEqual(n3.tag, 'latest');
      assert.strictEqual(n4.tag, 'pending');
      assert.strictEqual(acc.balance, '1000000');

      assert.deepStrictEqual(
        calls.map((c) => [c.id, c.method, c.params]),
        [
          [1, 'account.getcurrentnonce', { address: expectedAddr, tag: 'latest' }],
          [2, 'account.getcurrentnonce', { address: expectedAddr, tag: 'pending' }],
          [3, 'account.getcurrentnonce', { address: expectedAddr, tag: 'latest' }],
          [4, 'account.getcurrentnonce', { address: expectedAddr, tag: 'pending' }],
          [5, 'account.getaccount', { address: expectedAddr }],
        ]
      );
    }
  );
});

test('makeRequest handles HTTP error, JSON-RPC error, timeout abort, and non-Error throw', async () => {
  const client = new MmnClient({ baseUrl: 'http://rpc.local', timeout: 20 });

  await withMockFetch(
    async () => makeJsonResponse({}, 503, 'Service Unavailable'),
    async () => {
      await assert.rejects(() => client.getAccountByUserId('u1'), {
        message: 'HTTP 503: Service Unavailable',
      });
    }
  );

  await withMockFetch(
    async () =>
      makeJsonResponse({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32602, message: 'Invalid params' },
      }),
    async () => {
      await assert.rejects(() => client.getAccountByUserId('u1'), {
        message: 'JSON-RPC Error -32602: Invalid params',
      });
    }
  );

  await withMockFetch(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
    async () => {
      await assert.rejects(() => client.getAccountByUserId('u1'), {
        message: 'Request timeout after 20ms',
      });
    }
  );

  await withMockFetch(
    async () => {
      throw 'raw-string-error';
    },
    async () => {
      await assert.rejects(() => client.getAccountByUserId('u1'), {
        message: 'Unknown error occurred',
      });
    }
  );
});
