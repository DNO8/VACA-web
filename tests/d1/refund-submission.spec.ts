import { test, expect } from '@playwright/test';
import { Keypair, hash } from '@stellar/stellar-sdk';
import { createRefundSender } from '../../src/lib/d1/refund-submission';
import { buildRefundCommand, signRefundCommand } from '../../src/lib/d1/refund-commands';
import type { RefundJournal, RefundHold, RefundOriginalIdentity } from '../../src/lib/d1/refund-journal';

const wallet = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 71));
const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 72)).publicKey();
const namespace = 'fedcba98-7654-3210-fedc-ba9876543210';
const request_id = '01234567-89ab-cdef-0123-456789abcdef';
const config = { network: 'TESTNET' as const, pool_public_key: pool, namespace, donation_ttl_seconds: 300 as const };
const identity: RefundOriginalIdentity = { network: 'TESTNET', namespace, pool, request_id };
const clock = () => 2000;
async function body(version: 1 | 2 = 1) {
  return JSON.stringify(await signRefundCommand(config, buildRefundCommand(config, {
    ...(version === 1 ? { version, action: 'refund' as const } : { version, action: 'refund_remainder' as const }),
    request_id, timestamp: 2000, payload: {}, wallet: wallet.publicKey(),
  }, clock), async message => ({ signerAddress: wallet.publicKey(), signedMessage: wallet.sign(hash(Buffer.from('Stellar Signed Message:\n' + message))) }), clock));
}
function storage() {
  let hold: RefundHold | null = null; let claims = 0;
  const journal: RefundJournal = {
    read: async () => hold,
    claimExecution: async (scope, attempt) => {
      claims++; const claimed = hold === null;
      hold ??= Object.freeze({ identity: scope, attempt });
      return { claimed, hold };
    }, close() {},
  };
  return { journal, get hold() { return hold; }, get claims() { return claims; } };
}
for (const version of [1, 2] as const) test(`one-use winner sends exact retained v${version} bytes once`, async () => {
  const s = storage(), calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return Response.json({ report: 'accepted, not settlement' }, { status: 202 }); };
  const raw = ' \n' + await body(version) + '\t';
  const sender = createRefundSender(config, s.journal, identity, fetcher, clock);
  const capability = await sender.claim(raw);
  expect(s.hold?.attempt.signedBody).toBe(raw); expect(calls).toEqual([]);
  const results = await Promise.allSettled([capability.send(), capability.send()]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason.message)).toEqual(['d1_refund_capability_consumed']);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('/api/d1/' + (version === 1 ? 'refund' : 'refund-remainder'));
  expect(calls[0].init.body).toBe(raw);
  expect(calls[0].init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store' });
  expect(s.claims).toBe(1);
});
test('wrong context rejects before storage/network, retaining no hold', async () => {
  const s = storage(); let calls = 0;
  const sender = createRefundSender(config, s.journal, { ...identity, request_id: namespace }, async () => { calls++; return Response.json({}); }, clock);
  await expect(sender.claim(await body())).rejects.toThrow(/^d1_refund_attempt_mismatch$/);
  expect(s.hold).toBeNull(); expect(s.claims).toBe(0); expect(calls).toBe(0);
});
for (const outcome of ['404', '503', 'unknown', 'throw']) test(`${outcome} never grants resend, reload or cross-lane permission`, async () => {
  const s = storage(); let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; if (outcome === 'throw') throw new Error('private'); return Response.json({ error: 'outcome_unresolved' }, { status: outcome === 'unknown' ? 202 : Number(outcome) }); };
  const raw = await body(), raw2 = await body(2);
  const a = createRefundSender(config, s.journal, identity, fetcher, clock);
  const b = createRefundSender(config, s.journal, identity, fetcher, clock);
  const race = await Promise.allSettled([a.claim(raw), b.claim(raw2)]);
  expect(race[0].status).toBe('fulfilled'); expect(race[1].status).toBe('rejected');
  const capability = (race[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof a.claim>>>).value;
  const retained = JSON.stringify(s.hold);
  if (outcome === 'throw') await expect(capability.send()).rejects.toThrow(/^d1_admin_transport_unknown$/);
  else expect((await capability.send()).status).toBe(outcome === 'unknown' ? 202 : Number(outcome));
  await expect(capability.send()).rejects.toThrow(/^d1_refund_capability_consumed$/);
  for (const bytes of [raw, raw2]) await expect(createRefundSender(config, s.journal, identity, fetcher, clock).claim(bytes)).rejects.toThrow(/^d1_refund_execution_retained$/);
  expect(calls).toBe(1); expect(JSON.stringify(s.hold)).toBe(retained);
});
test('uncertain durable claim never sends or recreates a capability', async () => {
  const s = storage(); let calls = 0;
  const claim = s.journal.claimExecution;
  s.journal.claimExecution = async (i, a) => { await claim(i, a); throw new Error('uncertain persistence'); };
  const sender = createRefundSender(config, s.journal, identity, async () => { calls++; return Response.json({}); }, clock);
  await expect(sender.claim(await body())).rejects.toThrow('uncertain persistence');
  expect(s.hold).not.toBeNull(); const before = JSON.stringify(s.hold);
  s.journal.claimExecution = claim;
  await expect(sender.claim(await body(2))).rejects.toThrow(/^d1_refund_execution_retained$/);
  expect(calls).toBe(0); expect(JSON.stringify(s.hold)).toBe(before);
});
