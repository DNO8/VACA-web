import { test, expect } from '@playwright/test';
import { Keypair, Networks, Transaction, hash, xdr } from '@stellar/stellar-sdk';
import { observeAdminOriginal, createAdminFlow, browserAdminActionHistory, type AdminActionHistory } from '../../src/lib/d1/admin-flow';
import { postAdminCommand } from '../../src/lib/d1/admin-command-transport';
import { D1_B } from '../../src/lib/d1/profile';
import type { RefundJournal, RefundHold } from '../../src/lib/d1/refund-journal';

const id = 'abcdef01-2345-6789-abcd-0123456789ab';
const issuanceId = '01234567-89ab-cdef-0123-456789abcdef';
const admin = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
const donor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const beneficiary = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();
const config = { network: 'TESTNET' as const, pool_public_key: pool, namespace: id, donation_ttl_seconds: 300 as const };
import { buildDonationTransaction, validateSignedDonation } from '../../src/lib/d1/donation-transaction';
function fixture(settings = config) {
  const config = settings, pool = config.pool_public_key, id = config.namespace;
  const unsigned = buildDonationTransaction({ config, request_id: id, donor: donor.publicKey(), incident_id: 'original incident', asset: { type: 'native' }, amount: '10.0000000' }, { sequence: '9', fee: '100', timebounds: { minTime: 1700000000, maxTime: 1700000060 } });
  const tx = new Transaction(unsigned.unsignedXdr, Networks.TESTNET); tx.sign(donor);
  const snapshot = validateSignedDonation(unsigned, { signedTxXdr: tx.toXDR(), signerAddress: donor.publicKey() });
  const closed_at = '2023-11-14T22:13:20Z';
  const transaction = { hash: snapshot.transactionHash, successful: true, operation_count: 1, ledger: 42, source_account: donor.publicKey(), source_account_sequence: tx.sequence, envelope_xdr: tx.toXDR(), created_at: closed_at,
    result_xdr: new xdr.TransactionResult({ feeCharged: xdr.Int64.fromString('100'), result: xdr.TransactionResultResult.txSuccess([xdr.OperationResult.opInner(xdr.OperationResultTr.payment(xdr.PaymentResult.paymentSuccess()))]), ext: xdr.TransactionResultExt.fromXDR('00000000', 'hex') }).toXDR('base64') };
  const operations = { _embedded: { records: [{ type: 'payment', type_i: 1, transaction_successful: true, transaction_hash: snapshot.transactionHash, id: '99', source_account: donor.publicKey(), from: donor.publicKey(), to: pool, amount: '10.0000000', asset_type: 'native', created_at: closed_at }] } };
  let observations = 0;
  const observer: typeof fetch = async () => Response.json([transaction, operations, { sequence: 42, hash: 'ab'.repeat(32), closed_at }][observations++]);
  const context = { config, request_id: issuanceId, admin: admin.publicKey(), incident_id: snapshot.intent.incident_id, beneficiary, amount: '1.0000000', payment: { transaction_hash: snapshot.transactionHash, operation_id: '99', donor: donor.publicKey(), pool, asset: { type: 'native' }, amount: '10.0000000', confirmedAt: 1700000000 } };
  const preparation = { revision: 1, state: 'allocated', request_id: issuanceId, allocation: { reservation: { request_id: issuanceId, authorized_by: admin.publicKey(), request: { version: 1, incident_id: context.incident_id, donor: donor.publicKey(), beneficiary, asset: { type: 'native' }, amount: '1.0000000', deadline: '2023-11-14T22:18:20Z' }, state: 'reserved', reserved_at: '2023-11-14T22:13:21.000Z' }, payment: { ...context.payment }, allocated_amount: '1.0000000', state: 'allocated', allocated_at: '2023-11-14T22:13:21.000Z' } };
  Reflect.deleteProperty(preparation.allocation.payment, 'confirmedAt');
  let hold: RefundHold | null = null, signatures = 0;
  const journal: RefundJournal = { read: async () => hold, claimExecution: async (identity, attempt) => { const claimed = hold === null; hold ??= { identity, attempt }; return { claimed, hold }; }, close() {} };
  const records = new Map<string, string>();
  const history: AdminActionHistory = { claim: async (key, body) => { if (records.has(key)) return false; records.set(key, body); return true; } };
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let reply: () => Response = () => Response.json(preparation);
  const dependencies = { journal, history, clock: () => 2000,
    signMessage: async (message: string) => { signatures++; return { signerAddress: admin.publicKey(), signedMessage: admin.sign(hash(Buffer.from('Stellar Signed Message:\n' + message))) }; },
    fetcher: (async (url, init) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return reply(); }) as typeof fetch };
  return { snapshot, observer, context, preparation, dependencies, records, calls, get observations() { return observations; }, get signatures() { return signatures; }, get hold() { return hold; }, set reply(value: () => Response) { reply = value; } };
}

test('invalid original rejects before network; parsed JSON is not an observed original', async () => {
  const f = fixture();
  await expect(observeAdminOriginal(config, { ...f.snapshot, transactionHash: 'ab'.repeat(32) }, f.observer)).rejects.toThrow(/^d1_invalid_donation_snapshot$/);
  expect(f.observations).toBe(0);
  expect(() => createAdminFlow(config, JSON.parse(JSON.stringify(f.context)), f.context, f.dependencies)).toThrow(/^d1_admin_original_unverified$/);
  expect(f.calls).toEqual([]); expect(f.signatures).toBe(0); expect(f.records.size).toBe(0); expect(f.hold).toBeNull();
});
test('binds observed original before wallet/network and rejects every changed original fact', async () => {
  const f = fixture(), original = await observeAdminOriginal(config, f.snapshot, f.observer);
  expect(f.observations).toBe(3);
  for (const changes of [{ incident_id: 'other' }, { payment: { ...f.context.payment, amount: '11.0000000' } }, { payment: { ...f.context.payment, donor: beneficiary } }, { payment: { ...f.context.payment, confirmedAt: 1700000001 } }, { payment: { ...f.context.payment, operation_id: '100' } }, { payment: { ...f.context.payment, transaction_hash: 'ab'.repeat(32) } }, { payment: { ...f.context.payment, asset: { type: 'issued', code: 'USD', issuer: pool } } }]) {
    expect(() => createAdminFlow(config, original, { ...f.context, ...changes }, f.dependencies)).toThrow(/^d1_admin_original_mismatch$/);
  }
  expect(() => createAdminFlow({ ...config, namespace: issuanceId }, original, f.context, f.dependencies)).toThrow(/^d1_admin_original_mismatch$/);
  expect(f.calls).toEqual([]); expect(f.signatures).toBe(0); expect(f.records.size).toBe(0); expect(f.hold).toBeNull();
});
test('prepare and issue are separate explicit actions; retained receipt binds claim1 not gross10', async () => {
  const f = fixture(), original = await observeAdminOriginal(config, f.snapshot, f.observer);
  const flow = createAdminFlow(config, original, f.context, f.dependencies);
  await expect(flow.initial('issue')).rejects.toThrow(/^d1_admin_preparation_required$/);
  expect(f.calls).toEqual([]); expect(f.signatures).toBe(0);
  expect(await flow.initial('prepare')).toEqual(f.preparation);
  expect(f.calls.map(c => c.url)).toEqual(['/api/d1/prepare']);
  expect(f.calls[0].body.payload).toEqual({ incident_id: 'original incident', transaction_hash: f.snapshot.transactionHash, operation_id: '99', beneficiary, amount: '1.0000000' });
  expect(flow.context.payment.amount).toBe('10.0000000'); expect(flow.context.amount).toBe('1.0000000');
  f.context.payment.amount = '99.0000000'; expect(flow.context.payment.amount).toBe('10.0000000');
  f.reply = () => Response.json({ state: 'pending', verification: 'unverified', requestId: issuanceId, transactionHash: 'cd'.repeat(32) }, { status: 202 });
  const issued = await flow.initial('issue');
  expect(issued).toMatchObject({ receipt: { state: 'pending', verification: 'unverified' } });
  expect(f.calls.map(c => c.url)).toEqual(['/api/d1/prepare', '/api/d1/issue']);
  await expect(flow.initial('issue')).rejects.toThrow(/^d1_admin_action_retained$/);
  expect(f.calls).toHaveLength(2); expect(f.signatures).toBe(2);
});
for (const status of [404, 503]) test(`initial ${status} leaves hold; reload cannot retry or chain`, async () => {
  const f = fixture(), original = await observeAdminOriginal(config, f.snapshot, f.observer);
  f.reply = () => Response.json({ error: 'financial_precondition_unavailable' }, { status });
  const flow = createAdminFlow(config, original, f.context, f.dependencies);
  await expect(flow.initial('prepare')).rejects.toThrow(new RegExp(`^d1_admin_http_${status}:financial_precondition_unavailable$`));
  const records = [...f.records];
  await expect(flow.initial('prepare')).rejects.toThrow(/^d1_admin_action_retained$/);
  await expect(createAdminFlow(config, original, f.context, f.dependencies).initial('prepare')).rejects.toThrow(/^d1_admin_action_retained$/);
  await expect(flow.initial('issue')).rejects.toThrow(/^d1_admin_preparation_required$/);
  expect(f.calls).toHaveLength(1); expect([...f.records]).toEqual(records);
});
for (const lane of ['full_gross_v1', 'verified_remainder_v2'] as const) test(`manual ${lane} exact routes; status/reconcile never clear execution history`, async () => {
  const f = fixture(), original = await observeAdminOriginal(config, f.snapshot, f.observer);
  const version = lane === 'full_gross_v1' ? 1 : 2;
  const names = version === 1 ? ['refund_status', 'refund_reconcile', 'refund'] : ['refund_remainder_status', 'refund_remainder_reconcile', 'refund_remainder'];
  f.reply = () => {
    const action = String(f.calls.at(-1)?.body.action);
    return Response.json({ version, network: 'TESTNET', namespace: id, pool, requestId: issuanceId, state: 'not_started', verification: 'unverified', deadline: '2023-11-14T22:18:20Z', donation: { paymentOperationId: '99', paymentTransactionHash: f.snapshot.transactionHash, donor: donor.publicKey(), asset: { type: 'native' }, grossAmount: '10.0000000' }, refund: null, settlement: { beneficiaryClaimedAmount: null, donorRefundedAmount: null, remainingPrincipalAmount: null }, safeActions: [names[2], names[0]], reason: null }, { status: action === names[2] ? 200 : 200 });
  };
  const flow = createAdminFlow(config, original, f.context, f.dependencies);
  for (const action of ['status', 'reconcile', 'execute'] as const) expect(await flow.refund(lane, action)).toMatchObject({ version, state: 'not_started', donation: { grossAmount: '10.0000000' } });
  expect(f.calls.map(c => c.url)).toEqual(names.map(n => '/api/d1/' + n.replaceAll('_', '-')));
  for (const c of f.calls) expect(c.body).toMatchObject({ version, request_id: issuanceId, payload: {}, wallet: admin.publicKey() });
  const hold = JSON.stringify(f.hold), count = f.signatures;
  await flow.refund(lane, 'status'); await flow.refund(lane, 'reconcile');
  await expect(flow.refund(lane, 'execute')).rejects.toThrow(/^d1_refund_execution_retained$/);
  await expect(flow.refund(version === 1 ? 'verified_remainder_v2' : 'full_gross_v1', 'execute')).rejects.toThrow(/^d1_refund_execution_retained$/);
  expect(f.signatures).toBe(count + 2); expect(f.calls).toHaveLength(5); expect(JSON.stringify(f.hold)).toBe(hold);
});
test('refund economic mismatch is rejected and hold retained, not settlement', async () => {
  const f = fixture(), original = await observeAdminOriginal(config, f.snapshot, f.observer);
  f.reply = () => Response.json({ error: 'outcome_unresolved' }, { status: 503 });
  const flow = createAdminFlow(config, original, f.context, f.dependencies);
  await expect(flow.refund('full_gross_v1', 'execute')).rejects.toThrow(/^d1_admin_http_503:outcome_unresolved$/);
  const hold = JSON.stringify(f.hold);
  await expect(flow.refund('verified_remainder_v2', 'execute')).rejects.toThrow(/^d1_refund_execution_retained$/);
  expect(f.calls).toHaveLength(1); expect(f.signatures).toBe(1); expect(JSON.stringify(f.hold)).toBe(hold);
});
test('double invoke and disposal during wallet wait cannot send stale work', async () => {
  const f = fixture(), original = await observeAdminOriginal(config, f.snapshot, f.observer);
  const signer = f.dependencies.signMessage; let release!: () => void;
  f.dependencies.signMessage = async message => { await new Promise<void>(r => { release = r; }); return signer(message); };
  const flow = createAdminFlow(config, original, f.context, f.dependencies);
  const pending = flow.refund('full_gross_v1', 'execute');
  await expect(flow.refund('full_gross_v1', 'execute')).rejects.toThrow(/^d1_admin_busy$/);
  while (!release) await Promise.resolve();
  flow.dispose(); release();
  await expect(pending).rejects.toThrow(/^d1_admin_stale$/);
  expect(f.calls).toEqual([]); expect(f.hold).toBeNull(); expect(f.records.size).toBe(0);
});

test('disposal during durable hold re-read consumes permission without sending', async () => {
  const f = fixture(), original = await observeAdminOriginal(config, f.snapshot, f.observer);
  const read = f.dependencies.journal.read;
  let reads = 0, release!: () => void;
  f.dependencies.journal.read = async identity => {
    if (++reads === 2) await new Promise<void>(resolve => { release = resolve; });
    return read(identity);
  };
  const flow = createAdminFlow(config, original, f.context, f.dependencies);
  const pending = flow.refund('full_gross_v1', 'execute');
  while (!release) await Promise.resolve();
  flow.dispose(); release();
  await expect(pending).rejects.toThrow(/^d1_admin_stale$/);
  expect(f.calls).toEqual([]); expect(f.hold).not.toBeNull();
});

test('allocated preparation accepts Created without chaining issue', async () => {
  const f = fixture(), original = await observeAdminOriginal(config, f.snapshot, f.observer);
  f.reply = () => Response.json(f.preparation, { status: 201 });
  const flow = createAdminFlow(config, original, f.context, f.dependencies);
  expect(await flow.initial('prepare')).toEqual(f.preparation);
  expect(f.calls.map(c => c.url)).toEqual(['/api/d1/prepare']); expect(f.signatures).toBe(1);
});

test('initial reconciliation requires an explicit retained hash and never issues', async () => {
  const f = fixture(), original = await observeAdminOriginal(config, f.snapshot, f.observer);
  const flow = createAdminFlow(config, original, f.context, f.dependencies);
  await expect(flow.initial('reconcile')).rejects.toThrow(/^d1_admin_issuance_reference_required$/);
  expect(f.signatures).toBe(0); expect(f.calls).toEqual([]); expect(f.records.size).toBe(0);
  const knownIssuanceHash = 'cd'.repeat(32);
  const recovered = createAdminFlow(config, original, f.context, { ...f.dependencies, knownIssuanceHash });
  f.reply = () => Response.json({ state: 'reconciliation_progress', requestId: issuanceId, transactionHash: knownIssuanceHash, stage: 'discovery' }, { status: 202 });
  expect(await recovered.initial('reconcile')).toMatchObject({ receipt: { state: 'reconciliation_progress', stage: 'discovery' }, transactionHashBinding: 'retained_match' });
  expect(f.calls.map(c => c.url)).toEqual(['/api/d1/reconcile']); expect(f.records.size).toBe(0); expect(f.hold).toBeNull();
  f.reply = () => Response.json({ state: 'issuance_outcome_recorded', requestId: issuanceId, transactionHash: 'ab'.repeat(32), outcome: 'success' });
  await expect(recovered.initial('reconcile')).rejects.toThrow(/^d1_receipt_binding_mismatch$/);
  expect(f.calls).toHaveLength(2); expect(f.hold).toBeNull();
});

test('malformed preparation cannot enable issue, and invalid lane cannot request proof', async () => {
  const f = fixture(), original = await observeAdminOriginal(config, f.snapshot, f.observer);
  const flow = createAdminFlow(config, original, f.context, f.dependencies);
  f.reply = () => Response.json({ ...f.preparation, request_id: id });
  await expect(flow.initial('prepare')).rejects.toThrow(/^d1_receipt_binding_mismatch$/);
  const records = [...f.records];
  await expect(flow.initial('issue')).rejects.toThrow(/^d1_admin_preparation_required$/);
  await expect(flow.refund('unknown' as 'full_gross_v1', 'execute')).rejects.toThrow(/^d1_admin_refund_reference_required$/);
  expect(f.signatures).toBe(1); expect(f.calls).toHaveLength(1); expect([...f.records]).toEqual(records); expect(f.hold).toBeNull();
});

test('refund parser preserves original economics and rejects mismatched reports after one send', async () => {
  for (const change of [{ donor: beneficiary }, { grossAmount: '1.0000000' }, { paymentOperationId: '100' }, { paymentTransactionHash: 'ab'.repeat(32) }, { asset: { type: 'issued', code: 'USD', issuer: pool } }, { deadline: '2023-11-14T22:18:21Z' }]) {
    const f = fixture(), original = await observeAdminOriginal(config, f.snapshot, f.observer);
    const { deadline = '2023-11-14T22:18:20Z', ...donationChanges } = change as Record<string, unknown>;
    f.reply = () => Response.json({ version: 1, network: 'TESTNET', namespace: id, pool, requestId: issuanceId, state: 'not_started', verification: 'unverified', deadline, donation: { paymentOperationId: '99', paymentTransactionHash: f.snapshot.transactionHash, donor: donor.publicKey(), asset: { type: 'native' }, grossAmount: '10.0000000', ...donationChanges }, refund: null, settlement: { beneficiaryClaimedAmount: null, donorRefundedAmount: null, remainingPrincipalAmount: null }, safeActions: ['refund', 'refund_status'], reason: null });
    const flow = createAdminFlow(config, original, f.context, f.dependencies);
    await expect(flow.refund('full_gross_v1', 'execute')).rejects.toThrow(/^d1_admin_refund_original_mismatch$/);
    const hold = JSON.stringify(f.hold);
    await expect(flow.refund('full_gross_v1', 'execute')).rejects.toThrow(/^d1_refund_execution_retained$/);
    expect(f.calls).toHaveLength(1); expect(f.signatures).toBe(1); expect(JSON.stringify(f.hold)).toBe(hold);
  }
});

test('browser initial-action history excludes competing claims and never replaces retained bytes', async () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } } as Storage;
  let tail = Promise.resolve();
  const locks = { request: (_key: string, callback: () => boolean) => { const result = tail.then(callback); tail = result.then(() => {}); return result; } } as unknown as LockManager;
  const first = browserAdminActionHistory(storage, locks), second = browserAdminActionHistory(storage, locks);
  expect(await Promise.all([first.claim('original:issue', 'first bytes'), second.claim('original:issue', 'other bytes')])).toEqual([true, false]);
  expect(await browserAdminActionHistory(storage, locks).claim('original:issue', 'reload')).toBe(false);
  expect([...data]).toEqual([['original:issue', 'first bytes']]);
});

test('proof expiration during initial durable claim retains history and never sends', async () => {
  const f = fixture(), original = await observeAdminOriginal(config, f.snapshot, f.observer);
  let now = 2000;
  f.dependencies.clock = () => now;
  const claim = f.dependencies.history.claim;
  f.dependencies.history.claim = async (key, body) => { const result = await claim(key, body); now = 2061; return result; };
  const flow = createAdminFlow(config, original, f.context, f.dependencies);
  await expect(flow.initial('prepare')).rejects.toThrow(/^d1_stale_command$/);
  expect(f.records.size).toBe(1); expect(f.calls).toEqual([]); expect(f.signatures).toBe(1);
  const before = [...f.records];
  await expect(flow.initial('prepare')).rejects.toThrow(/^d1_admin_action_retained$/);
  expect([...f.records]).toEqual(before); expect(f.calls).toEqual([]);
});

test('B uses existing proof, receipt and one-use refund helpers without touching A holds', async () => {
  const bConfig = { ...config, namespace: D1_B.namespace, pool_public_key: D1_B.pool };
  const a = fixture(), b = fixture(bConfig);
  const aOriginal = await observeAdminOriginal(config, a.snapshot, a.observer);
  const bOriginal = await observeAdminOriginal(bConfig, b.snapshot, b.observer);
  const aFlow = createAdminFlow(config, aOriginal, a.context, a.dependencies);
  await aFlow.initial('prepare');
  const retained = [...a.records];
  expect(() => createAdminFlow(bConfig, bOriginal, b.context, b.dependencies)).toThrow('d1_profile_scope_mismatch');
  expect(() => createAdminFlow(config, aOriginal, a.context, { ...a.dependencies, profile: null as unknown as 'A' })).toThrow('d1_profile_unavailable');
  expect(() => createAdminFlow(bConfig, aOriginal, b.context, { ...b.dependencies, profile: 'B' })).toThrow('d1_admin_original_mismatch');
  expect(b.calls).toEqual([]); expect(b.signatures).toBe(0); expect(b.hold).toBeNull();
  const flow = createAdminFlow(bConfig, bOriginal, b.context, { ...b.dependencies, profile: 'B' });
  await flow.initial('prepare');
  expect(b.calls[0].body).not.toHaveProperty('namespace'); // Original prepare signature schema.
  b.reply = () => Response.json({ state: 'pending', verification: 'unverified', requestId: issuanceId, transactionHash: 'cd'.repeat(32) }, { status: 202 });
  await flow.initial('issue');
  b.reply = () => Response.json({ state: 'reconciliation_progress', requestId: issuanceId, transactionHash: 'cd'.repeat(32), stage: 'discovery' }, { status: 202 });
  await flow.initial('reconcile');
  b.reply = () => Response.json({ error: 'outcome_unresolved' }, { status: 503 });
  await expect(flow.refund('verified_remainder_v2', 'execute')).rejects.toThrow('d1_admin_http_503:outcome_unresolved');
  const hold = JSON.stringify(b.hold);
  await expect(flow.refund('full_gross_v1', 'execute')).rejects.toThrow('d1_refund_execution_retained');
  await expect(createAdminFlow(bConfig, bOriginal, b.context, { ...b.dependencies, profile: 'B' }).refund('verified_remainder_v2', 'execute')).rejects.toThrow('d1_refund_execution_retained');
  expect(b.calls.map(call => call.url)).toEqual(['prepare', 'issue', 'reconcile', 'refund-remainder'].map(action => '/api/d1/video-auto/' + action));
  expect(b.calls.every(call => call.body.pool === D1_B.pool && call.body.network === 'TESTNET')).toBe(true);
  expect(b.calls.slice(1).every(call => call.body.namespace === D1_B.namespace)).toBe(true);
  expect(b.signatures).toBe(4); expect(JSON.stringify(b.hold)).toBe(hold); expect([...a.records]).toEqual(retained);
  await expect(aFlow.initial('prepare')).rejects.toThrow('d1_admin_action_retained'); expect(a.calls).toHaveLength(1);
});

test('bounded admin transport rejects invalid media and oversized responses without retry', async () => {
  for (const variant of ['media', 'size', 'json', 'redirect']) {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      const response = new Response(variant === 'size' ? ' '.repeat(65537) : '{', { headers: { 'Content-Type': variant === 'media' ? 'text/html' : 'application/json' } });
      if (variant === 'redirect') Object.defineProperty(response, 'redirected', { value: true });
      return response;
    };
    await expect(postAdminCommand('refund', '{}', fetcher)).rejects.toThrow(/^d1_admin_transport_unknown$/);
    expect(calls).toBe(1);
  }
});
