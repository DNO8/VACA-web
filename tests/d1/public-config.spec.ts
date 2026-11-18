import { test, expect } from '@playwright/test';
import { StrKey } from '@stellar/stellar-sdk';
import { readD1PublicConfig } from '../../src/lib/d1/public-config';

const config = { network: 'TESTNET', pool_public_key: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2)), namespace: 'abcdef01-2345-6789-abcd-0123456789ab', donation_ttl_seconds: 300 };
const response = (body: unknown = config) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const source = (make: () => Response | Promise<Response>) => {
  const calls: { url: unknown; options?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, options) => { calls.push({ url, options }); return make(); };
  return { calls, fetcher };
};

test('one same-origin GET validates a detached immutable public configuration', async () => {
  const mock = source(() => response());
  const result = await readD1PublicConfig(new AbortController().signal, mock.fetcher);
  expect(result).toEqual({ status: 'available', config });
  expect(mock.calls).toHaveLength(1);
  expect(mock.calls[0].url).toBe('/api/d1/config');
  expect(mock.calls[0].options).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store' });
  expect(mock.calls[0].options?.body).toBeUndefined();
  expect(mock.calls[0].options?.signal).toBeInstanceOf(AbortSignal);
  if (result.status === 'available') { expect(Object.isFrozen(result.config)).toBe(true); expect(result.config).not.toBe(config); }
});

test('invalid configuration never becomes available and is not retried', async () => {
  for (const change of [{ network: 'PUBLIC' }, { donation_ttl_seconds: 301 }, { pool_public_key: 'invalid' }, { namespace: 'invalid' }, { extra: true }]) {
    const mock = source(() => response({ ...config, ...change }));
    expect(await readD1PublicConfig(new AbortController().signal, mock.fetcher)).toEqual({ status: 'unavailable' });
    expect(mock.calls).toHaveLength(1);
  }
});

test('HTTP failure, malformed JSON and oversized or invalid UTF-8 bodies stay unavailable', async () => {
  const bodies = [() => new Response('{}', { status: 404 }), () => new Response(null, { status: 302 }), () => new Response('{'), () => new Response(' '.repeat(4097)), () => new Response(new Uint8Array([0xff]))];
  for (const make of bodies) {
    const mock = source(make);
    expect(await readD1PublicConfig(new AbortController().signal, mock.fetcher)).toEqual({ status: 'unavailable' });
    expect(mock.calls).toHaveLength(1);
  }
});

test('byte boundary accepts 4096 bytes and cancels a stream exceeding it', async () => {
  const json = JSON.stringify(config);
  expect(await readD1PublicConfig(new AbortController().signal, source(() => new Response(json.padEnd(4096))).fetcher)).toEqual({ status: 'available', config });
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(' '.repeat(4097))); }, cancel() { cancelled++; } });
  expect(await readD1PublicConfig(new AbortController().signal, source(() => new Response(stream)).fetcher)).toEqual({ status: 'unavailable' });
  expect(cancelled).toBe(1);
});

test('caller cancellation prevents a request or cancels the in-flight read without retry', async () => {
  const before = new AbortController(); before.abort();
  const unused = source(() => response());
  expect(await readD1PublicConfig(before.signal, unused.fetcher)).toEqual({ status: 'cancelled' }); expect(unused.calls).toHaveLength(0);
  const active = new AbortController(); const mock = source(() => new Promise<Response>(() => {}));
  const pending = readD1PublicConfig(active.signal, mock.fetcher); active.abort();
  expect(await pending).toEqual({ status: 'cancelled' });
  expect(mock.calls).toHaveLength(1); expect(mock.calls[0].options?.signal?.aborted).toBe(true);
});

test('deadline bounds both a stalled fetch and a stalled body without retries', async () => {
  const mock = source(() => new Promise<Response>(() => {}));
  expect(await readD1PublicConfig(new AbortController().signal, mock.fetcher, 10)).toEqual({ status: 'unavailable' });
  expect(mock.calls).toHaveLength(1); expect(mock.calls[0].options?.signal?.aborted).toBe(true);
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
  const stream = source(() => new Response(body));
  expect(await readD1PublicConfig(new AbortController().signal, stream.fetcher, 10)).toEqual({ status: 'unavailable' });
  expect(stream.calls).toHaveLength(1); expect(cancelled).toBe(1);
});
