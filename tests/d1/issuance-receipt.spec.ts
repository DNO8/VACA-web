import { test, expect } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';
import { parseIssuanceReceipt, parseReconciliationReceipt } from '../../src/lib/d1/issuance-receipt';

// Deterministic public fixtures only; no signing, funds or network.
const [admin, donor, beneficiary, pool, issuer] = [1, 2, 3, 4, 5].map(seed =>
  Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey());
const id = 'abcdef01-2345-6789-abcd-0123456789ab';
const otherId = '00000000-0000-0000-0000-000000000000';
const hash = 'cd'.repeat(32);
const cbid = '00000000' + 'ef'.repeat(32);
const issued = { type: 'issued', code: 'USD', issuer };
function context(asset = { type: 'native' }) {
  return {
    config: { network: 'TESTNET', pool_public_key: pool, namespace: otherId, donation_ttl_seconds: 300 },
    request_id: id, admin, incident_id: 'incident: not a UUID', beneficiary, amount: '1.0000000',
    payment: { transaction_hash: 'ab'.repeat(32), operation_id: '9999999999999999999', donor, pool,
      asset: { ...asset }, amount: '10.0000000', confirmedAt: 1700000000 },
  };
}
function observed(success = true, asset = { type: 'native' }) {
  return {
    state: success ? 'issuance_observed' : 'issuance_failed_observed', verification: 'persisted_sdk_observation',
    requestId: id, transactionHash: hash, donor, beneficiary, asset: { ...asset }, amount: '1.0000000',
    paymentTransactionHash: 'ab'.repeat(32), deadline: '2023-11-14T22:18:20Z',
    ...(success ? { claimableBalanceId: cbid } : {}),
  };
}
const branches = () => [
  { parse: parseIssuanceReceipt, status: 202, raw: { state: 'pending', verification: 'unverified', requestId: id, transactionHash: hash } },
  ...[true, false].map(success => ({ parse: parseIssuanceReceipt, status: 200, raw: observed(success) })),
  ...['discovery', 'transactions'].map(stage => ({ parse: parseReconciliationReceipt, status: 202,
    raw: { state: 'reconciliation_progress', requestId: id, transactionHash: hash, stage } })),
  ...['success', 'failed'].map(outcome => ({ parse: parseReconciliationReceipt, status: 200,
    raw: { state: 'issuance_outcome_recorded', requestId: id, transactionHash: hash, outcome } })),
];
type Branch = ReturnType<typeof branches>[number];
const malformed = (parse: Branch['parse']) => parse === parseIssuanceReceipt
  ? 'd1_malformed_issuance_receipt' : 'd1_malformed_reconciliation_receipt';

// Snapshot descriptors, not property values: getters and cyclic data remain inert.
function unchangedAfter(values: unknown[], action: () => void) {
  const snapshots = new Map<object, { descriptors: PropertyDescriptorMap; prototype: object; extensible: boolean }>();
  function visit(value: unknown) {
    if (!value || typeof value !== 'object' || snapshots.has(value)) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    snapshots.set(value, { descriptors, prototype: Object.getPrototypeOf(value), extensible: Object.isExtensible(value) });
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
      if ('value' in descriptor) visit(descriptor.value);
    }
  }
  values.forEach(visit);
  action();
  for (const [object, before] of snapshots) {
    expect(Object.getOwnPropertyDescriptors(object)).toEqual(before.descriptors);
    expect(Object.getPrototypeOf(object)).toBe(before.prototype);
    expect(Object.isExtensible(object)).toBe(before.extensible);
  }
}
function rejects(branch: Branch, raw: unknown, expected = context(), known: unknown = undefined, error = malformed(branch.parse), status: unknown = branch.status) {
  unchangedAfter([raw, expected, known, status], () => {
    expect(() => branch.parse(status, raw, expected, known)).toThrow(new RegExp(`^${error}$`));
  });
}
function frozenCopy(actual: unknown, original: unknown) {
  expect(actual).toEqual(original);
  if (!actual || typeof actual !== 'object') return;
  expect(actual).not.toBe(original);
  expect(Object.isFrozen(actual)).toBe(true);
  for (const key of Object.keys(actual)) frozenCopy(Reflect.get(actual, key), Reflect.get(original as object, key));
}

test('all HTTP branches return independent frozen historical data and local hash provenance', () => {
  for (const branch of branches()) {
    const expected = context();
    for (const known of [undefined, hash]) {
      unchangedAfter([branch.raw, expected], () => {
        const parsed = branch.parse(branch.status, branch.raw, expected, known);
        expect(Object.keys(parsed).sort()).toEqual(['receipt', 'transactionHashBinding']);
        expect(parsed.transactionHashBinding).toBe(known ? 'retained_match' : 'first_report');
        expect(Object.isFrozen(parsed)).toBe(true);
        frozenCopy(parsed.receipt, branch.raw);
      });
    }
    const parsed = branch.parse(branch.status, branch.raw, expected);
    branch.raw.requestId = otherId;
    expected.payment.amount = '20.0000000';
    expect(parsed.receipt.requestId).toBe(id);
  }
  for (const success of [true, false]) {
    const raw = observed(success, issued);
    const expected = context(issued);
    const parsed = parseIssuanceReceipt(200, raw, expected);
    frozenCopy(parsed.receipt, raw);
    raw.asset.type = expected.payment.asset.type = 'changed';
    expect(parsed.receipt).toMatchObject({ asset: issued, amount: '1.0000000', paymentTransactionHash: 'ab'.repeat(32) });
  }
});

test('requires exact HTTP/state pairing and literals, never coerces status', () => {
  for (const branch of branches()) {
    for (const status of [0, 201, 204, 400, 500, '200', '202', null, NaN, { valueOf: () => branch.status }, branch.status === 200 ? 202 : 200]) {
      rejects(branch, branch.raw, context(), undefined, malformed(branch.parse), status);
    }
    for (const state of ['allocated', 'success', '', null]) rejects(branch, { ...branch.raw, state });
    if (branch.parse === parseIssuanceReceipt) {
      rejects(branch, { ...branch.raw, verification: branch.status === 202 ? 'persisted_sdk_observation' : 'unverified' });
    } else {
      rejects(branch, { ...branch.raw, verification: 'persisted_sdk_observation' });
      const field = branch.status === 202 ? 'stage' : 'outcome';
      for (const value of [null, {}, { outcome: 'success' }, 'pending', 'SUCCESS', 1]) rejects(branch, { ...branch.raw, [field]: value });
    }
  }
});

test('validates retained context and optional hash before binding every branch', () => {
  for (const branch of branches()) {
    for (const invalid of [null, [], {}, { ...context(), request_id: 'incident' }, { ...context(), amount: '11.0000000' }]) {
      rejects(branch, branch.raw, invalid as ReturnType<typeof context>, undefined, 'd1_invalid_receipt_context');
    }
    for (const known of [null, '', 'CD'.repeat(32), 'a'.repeat(63), 'a'.repeat(65), hash + '\n', 1, {}]) {
      rejects(branch, branch.raw, context(), known, 'd1_invalid_receipt_context');
    }
    rejects(branch, branch.raw, context(), 'ef'.repeat(32), 'd1_receipt_binding_mismatch');
    rejects(branch, { ...branch.raw, requestId: otherId }, context(), undefined, 'd1_receipt_binding_mismatch');
    rejects(branch, branch.raw, context(), context().payment.transaction_hash, 'd1_receipt_binding_mismatch');
    for (const requestId of ['incident: not a UUID', cbid, id.toUpperCase(), id + '\n']) rejects(branch, { ...branch.raw, requestId });
    for (const transactionHash of ['CD'.repeat(32), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), hash + '\n', 1]) {
      rejects(branch, { ...branch.raw, transactionHash });
    }
  }
});

test('binds all issue economics to allocation and original confirmation, not gross amount or renewed time', () => {
  for (const success of [true, false]) {
    const branch = { parse: parseIssuanceReceipt, status: 200, raw: observed(success) };
    for (const change of [{ donor: admin }, { beneficiary: admin }, { asset: issued }, { amount: '10.0000000' },
      { paymentTransactionHash: hash }, { deadline: '2023-11-14T22:23:20Z' }]) {
      rejects(branch, { ...branch.raw, ...change }, context(), undefined, 'd1_receipt_binding_mismatch');
    }
    for (const asset of [{ ...issued, code: 'EUR' }, { ...issued, issuer: donor }, { type: 'native' }]) {
      rejects(branch, { ...observed(success, issued), asset }, context(issued), undefined, 'd1_receipt_binding_mismatch');
    }
    for (const amount of ['0.0000001', '999999999999.9999999']) {
      const expected = context();
      expected.amount = expected.payment.amount = amount;
      expect(parseIssuanceReceipt(200, { ...branch.raw, amount }, expected).receipt).toMatchObject({ amount });
    }
  }
});

test('requires canonical primitives, assets, dates and full zero-discriminant XDR balance IDs', () => {
  for (const success of [true, false]) {
    const branch = { parse: parseIssuanceReceipt, status: 200, raw: observed(success) };
    const invalid = {
      donor: ['G'.repeat(56), donor.toLowerCase(), 1], beneficiary: [null, {}, 'bad'],
      amount: [1, '1', '01.0000000', '0.0000000', '-1.0000000', '1.000000', '1.00000000', '1e0', '1.0000000\n', '1000000000000.0000000'],
      paymentTransactionHash: [hash.toUpperCase(), hash + '\n', 1],
      deadline: ['2023-02-29T22:18:20Z', '2023-11-14T22:18:20.000Z', '2023-11-14T22:18:20+00:00', '2023-11-14T22:18:20Z\n', 1700000300],
      asset: [null, [], 'native', { type: 'native', code: 'XLM' }, { type: 'issued' },
        { ...issued, code: '' }, { ...issued, code: 'a'.repeat(13) }, { ...issued, issuer: 'bad' }],
    };
    for (const [key, values] of Object.entries(invalid)) for (const value of values) rejects(branch, { ...branch.raw, [key]: value });
  }
  const branch = branches()[1];
  for (const claimableBalanceId of [hash, '00000001' + hash, 'f'.repeat(72), cbid.toUpperCase(), cbid + '\n', cbid.slice(1), cbid + '0', null]) {
    rejects(branch, { ...branch.raw, claimableBalanceId });
  }
  const failed = branches()[2];
  rejects(failed, { ...failed.raw, claimableBalanceId: cbid });
  rejects(failed, { ...failed.raw, availability: undefined });
});

test('strict outer/nested fields reject missing, unknown, hidden, symbol and accessor data without effects', () => {
  for (const branch of branches()) {
    for (const raw of [null, [], 'receipt', 200, true, Object.create({ ...branch.raw })]) rejects(branch, raw);
    for (const target of [branch.raw, ...('asset' in branch.raw ? [branch.raw.asset] : [])]) {
      for (const key of Object.keys(target)) {
        const previous = Object.getOwnPropertyDescriptor(target, key)!;
        for (const kind of ['missing', 'hidden', 'getter']) {
          let calls = 0;
          Reflect.deleteProperty(target, key);
          if (kind !== 'missing') Object.defineProperty(target, key, kind === 'hidden'
            ? { ...previous, enumerable: false } : { configurable: true, enumerable: true, get: () => { calls++; throw Error('invoked'); } });
          rejects(branch, branch.raw);
          expect(calls).toBe(0);
          Object.defineProperty(target, key, previous);
        }
      }
      for (const key of ['extra', Symbol('extra'), 'namespace', 'transactionHashBinding']) {
        Object.defineProperty(target, key, { configurable: true, enumerable: key !== 'extra', value: 'unexpected' });
        rejects(branch, branch.raw);
        Reflect.deleteProperty(target, key);
      }
    }
  }
  const raw = observed(true, issued);
  for (const key of ['type', 'code', 'issuer']) {
    const asset = { ...issued };
    Object.defineProperty(asset, key, { enumerable: true, get: () => { throw Error('do not invoke'); } });
    rejects(branches()[1], { ...raw, asset }, context(issued));
  }
});

test('success availability alone is ignored by name, never evaluated or returned', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const availability of [null, cycle, undefined, { current: 'claimable' }]) {
    const raw = { ...observed(), availability };
    unchangedAfter([raw], () => frozenCopy(parseIssuanceReceipt(200, raw, context()).receipt, observed()));
  }
  let calls = 0;
  const raw = observed();
  Object.defineProperty(raw, 'availability', { enumerable: true, configurable: true, get: () => { calls++; throw Error('must not execute'); } });
  unchangedAfter([raw], () => frozenCopy(parseIssuanceReceipt(200, raw, context()).receipt, observed()));
  expect(calls).toBe(0);
  Object.defineProperty(raw, 'availability', { enumerable: false });
  rejects(branches()[1], raw);
  for (const branch of branches().filter(branch => branch.raw.state !== 'issuance_observed')) {
    rejects(branch, { ...branch.raw, availability: cycle });
  }
});
