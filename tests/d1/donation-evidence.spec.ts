import { test, expect } from '@playwright/test';
import { Account, Asset, Keypair, Memo, Networks, Operation, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { parseDonationEvidence } from '../../src/lib/d1/donation-evidence';
import { buildDonationTransaction, validateSignedDonation } from '../../src/lib/d1/donation-transaction';
import { originalDeadline, validateReceiptContext } from '../../src/lib/d1/receipt-context';

// Synthetic public fixtures, never a live wallet, clock, observer or journal.
const donor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const id = 'abcdef01-2345-6789-abcd-0123456789ab';
const closed_at = '2023-11-14T22:13:25Z';
const success = () => xdr.OperationResult.opInner(xdr.OperationResultTr.payment(xdr.PaymentResult.paymentSuccess()));
function resultXdr(result = xdr.TransactionResultResult.txSuccess([success()])) {
  return new xdr.TransactionResult({ feeCharged: xdr.Int64.fromString('100'), result,
    ext: xdr.TransactionResultExt.fromXDR('00000000', 'hex') }).toXDR('base64');
}
function fixture(code?: string) {
  const asset = code ? { type: 'issued', code, issuer: pool.publicKey() } : { type: 'native' };
  const built = buildDonationTransaction({
    config: { network: 'TESTNET', pool_public_key: pool.publicKey(), namespace: id, donation_ttl_seconds: 300 },
    request_id: id, donor: donor.publicKey(), incident_id: 'original incident', asset, amount: '12.0000001',
  }, { sequence: '9007199254740993', fee: '100', timebounds: { minTime: 1700000000, maxTime: 1700000060 } });
  const tx = new Transaction(built.unsignedXdr, Networks.TESTNET);
  tx.sign(donor);
  const snapshot = validateSignedDonation(built, { signedTxXdr: tx.toXDR() + '\n', signerAddress: donor.publicKey() });
  return JSON.parse(JSON.stringify({ snapshot,
    transaction: { hash: built.transactionHash, successful: true, operation_count: 1, source_account: donor.publicKey(),
      source_account_sequence: tx.sequence, ledger: 42, envelope_xdr: tx.toXDR(), result_xdr: resultXdr(), created_at: closed_at },
    operations: { _embedded: { records: [{ type: 'payment', type_i: 1, transaction_successful: true,
      transaction_hash: built.transactionHash, id: '9007199254740993', source_account: donor.publicKey(), from: donor.publicKey(),
      to: pool.publicKey(), amount: '12.0000001', created_at: closed_at,
      ...(code ? { asset_type: code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12', asset_code: code, asset_issuer: pool.publicKey() }
        : { asset_type: 'native' }) }] } },
    ledger: { sequence: 42, hash: 'ab'.repeat(32), closed_at },
  }));
}
type Fixture = ReturnType<typeof fixture>;
const parse = (f: Fixture) => parseDonationEvidence(f.snapshot, f.transaction, f.operations, f.ledger);
const operation = (f: Fixture) => f.operations._embedded.records[0];
function unchangedAfter(f: Fixture, action: () => void) {
  const retained: [object, PropertyDescriptorMap, boolean][] = [];
  function remember(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    retained.push([value, descriptors, Object.isFrozen(value)]);
    for (const descriptor of Object.values(descriptors)) if ('value' in descriptor) remember(descriptor.value);
  }
  remember(f);
  action();
  for (const [value, descriptors, frozen] of retained) {
    expect(Object.getOwnPropertyDescriptors(value)).toEqual(descriptors);
    expect(Object.isFrozen(value)).toBe(frozen);
  }
}
function reject(f: Fixture) {
  unchangedAfter(f, () => expect(() => parse(f)).toThrow(/^d1_donation_evidence_invalid$/));
}
function frozen(value: unknown) {
  if (!value || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach(frozen);
}

for (const code of [undefined, 'USDC', 'LONGASSET123']) {
  test(`exact frozen original receipt subset: ${code ?? 'native'}`, () => {
    const f = fixture(code);
    f.transaction._links = { self: { href: 'https://invalid.example/not-followed' } };
    f.operations._links = { next: { href: 'https://invalid.example/not-followed' } };
    f.ledger.paging_token = '42';
    operation(f).paging_token = '9007199254740993';
    unchangedAfter(f, () => {
      const actual = parse(f);
      expect(actual).toEqual({ config: f.snapshot.intent.config, request_id: id, incident_id: 'original incident',
        payment: { transaction_hash: f.snapshot.transactionHash, operation_id: '9007199254740993', donor: donor.publicKey(),
          pool: pool.publicKey(), asset: f.snapshot.intent.asset, amount: '12.0000001', confirmedAt: 1700000005 },
        ledger: { sequence: 42, hash: 'ab'.repeat(32), closed_at } });
      frozen(actual);
    });
  });
}

test('original time remains receipt-compatible with deadline +300, independent of validity bounds', () => {
  const f = fixture();
  for (const date of ['1970-01-01T00:00:00Z', closed_at, '9999-12-31T23:54:59Z']) {
    f.ledger.closed_at = f.transaction.created_at = operation(f).created_at = date;
    const actual = parse(f);
    const { ledger: _ledger, ...subset } = actual;
    const context = validateReceiptContext({ ...subset, admin: pool.publicKey(), beneficiary: donor.publicKey(), amount: '1.0000000' });
    expect(context.payment.confirmedAt).toBe(Date.parse(date) / 1000);
    expect(originalDeadline(context.payment.confirmedAt)).toBe(new Date(Date.parse(date) + 300000).toISOString().replace('.000Z', 'Z'));
    expect(context.payment.amount).toBe('12.0000001');
  }
});

test('accepts donor proof with different additional signature bytes and precise ID/ledger boundaries', () => {
  const f = fixture();
  const tx = new Transaction(f.snapshot.signedTxXdr, Networks.TESTNET);
  tx.sign(pool);
  f.transaction.envelope_xdr = tx.toXDR();
  for (const opId of ['1', '9999999999999999999']) for (const sequence of [1, 4294967295]) {
    operation(f).id = opId;
    f.transaction.ledger = f.ledger.sequence = sequence;
    expect(parse(f).payment.operation_id).toBe(opId);
  }
});

test('rejects missing, nonplain and malformed raw collections without effects', () => {
  for (const key of ['snapshot', 'transaction', 'operations', 'ledger']) for (const value of [null, undefined, [], 'raw', new Date()]) {
    const f = fixture(); f[key] = value; reject(f);
  }
  for (const value of [{}, { records: [] }, { _embedded: {} }, { _embedded: { records: [] } },
    { _embedded: { records: [operation(fixture()), operation(fixture())] } }, { _embedded: { records: { 0: operation(fixture()), length: 1 } } }]) {
    const f = fixture(); f.operations = value; reject(f);
  }
});

test('rejects accessors, symbols, hidden fields and unknown snapshot fields without getter invocation', () => {
  const targets = (f: Fixture) => [f.snapshot, f.snapshot.intent, f.snapshot.intent.config, f.snapshot.intent.asset,
    f.snapshot.parameters, f.snapshot.parameters.timebounds, f.transaction, f.operations, f.operations._embedded,
    f.operations._embedded.records, operation(f), f.ledger];
  for (let i = 0; i < targets(fixture()).length; i++) for (const kind of ['accessor', 'symbol', 'hidden']) {
    const f = fixture(); let calls = 0;
    Object.defineProperty(targets(f)[i], kind === 'symbol' ? Symbol('bad') : 'bad', kind === 'accessor'
      ? { enumerable: true, get: () => { calls++; throw new Error('sensitive detail'); } }
      : { enumerable: kind !== 'hidden', value: true });
    reject(f); expect(calls).toBe(0);
  }
  const f = fixture(); f.snapshot.extra = true; reject(f);
  const nested = fixture(); nested.transaction._links = { self: {} };
  Object.defineProperty(nested.transaction._links.self, 'href', { enumerable: true, get: () => { throw new Error('must not run'); } });
  reject(nested);
});

test('original snapshot requires exact unsigned reconstruction and retained donor signature', () => {
  for (const change of [ { transactionHash: 'ab'.repeat(32) }, { unsignedXdr: fixture().snapshot.signedTxXdr },
    { signedTxXdr: fixture().snapshot.unsignedXdr }, { signedTxXdr: 'bad' }, { signedTxXdr: undefined } ]) {
    const f = fixture(); Object.assign(f.snapshot, change); reject(f);
  }
  for (const mutate of [(f: Fixture) => { f.snapshot.intent.amount = '1.0000000'; },
    (f: Fixture) => { f.snapshot.parameters.fee = '101'; }, (f: Fixture) => { f.snapshot.intent.config.network = 'PUBLIC'; }]) {
    const f = fixture(); mutate(f); reject(f);
  }
  for (const field of ['unsignedXdr', 'signedTxXdr']) { const f = fixture(); f.snapshot[field] = 'A'.repeat(1048577); reject(f); }
});

test('raw transaction identities, success, count, sequence, and encoded bounds must agree', () => {
  const invalid = { hash: ['ab'.repeat(32), undefined], successful: [false, 'true', undefined], operation_count: [0, 2, '1'],
    source_account: [pool.publicKey(), undefined], source_account_sequence: ['9007199254740993', 9007199254740994, '09007199254740994'],
    ledger: [0, -1, 1.5, '42', 4294967296, Number.MAX_SAFE_INTEGER + 1],
    envelope_xdr: ['', 'bad', fixture().snapshot.unsignedXdr, 'A'.repeat(1048577)], result_xdr: ['', 'bad', 'A'.repeat(1048577)] };
  for (const [field, values] of Object.entries(invalid)) for (const value of values) {
    const f = fixture(); f.transaction[field] = value; reject(f);
  }
});

test('envelopes reject wrong body/memo/economics/network/signature, path/multiop, fee bump and v0', () => {
  const f = fixture();
  for (const change of [{ amount: '1.0000000' }, { incident_id: 'other' }, { donor: pool.publicKey() },
    { asset: { type: 'issued', code: 'USD', issuer: pool.publicKey() } }, { config: { ...f.snapshot.intent.config, pool_public_key: donor.publicKey() } }]) {
    const built = buildDonationTransaction({ ...f.snapshot.intent, ...change }, f.snapshot.parameters);
    const tx = new Transaction(built.unsignedXdr, Networks.TESTNET); tx.sign(donor);
    f.transaction.envelope_xdr = tx.toXDR(); reject(f);
  }
  for (const [key, network] of [[pool, Networks.TESTNET], [donor, Networks.PUBLIC]] as const) {
    const tx = new Transaction(f.snapshot.unsignedXdr, network); tx.sign(key);
    f.transaction.envelope_xdr = tx.toXDR(); reject(f);
    const retained = fixture(); retained.snapshot.signedTxXdr = tx.toXDR(); reject(retained);
  }
  const payment = Operation.payment({ source: donor.publicKey(), destination: pool.publicKey(), amount: '12.0000001', asset: Asset.native() });
  const path = Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: '12.0000001', destination: pool.publicKey(), destAsset: Asset.native(), destAmount: '12.0000001', path: [] });
  for (const operations of [[payment], [payment, payment], [path]]) {
    const builder = new TransactionBuilder(new Account(donor.publicKey(), f.snapshot.parameters.sequence), { fee: '100',
      timebounds: f.snapshot.parameters.timebounds, networkPassphrase: Networks.TESTNET }).addMemo(Memo.text('wrong'));
    operations.forEach(op => builder.addOperation(op));
    const tx = builder.build(); tx.sign(donor); f.transaction.envelope_xdr = tx.toXDR(); reject(f);
  }
  const inner = new Transaction(f.snapshot.signedTxXdr, Networks.TESTNET);
  f.transaction.envelope_xdr = TransactionBuilder.buildFeeBumpTransaction(pool.publicKey(), '100', inner, Networks.TESTNET).toXDR(); reject(f);
  const body = inner.toEnvelope().v1().tx();
  const v0 = new xdr.TransactionV0({ sourceAccountEd25519: donor.rawPublicKey(), fee: body.fee(), seqNum: body.seqNum(),
    timeBounds: body.cond().timeBounds(), memo: body.memo(), operations: body.operations(), ext: xdr.TransactionV0Ext.fromXDR('00000000', 'hex') });
  f.transaction.envelope_xdr = xdr.TransactionEnvelope.envelopeTypeTxV0(new xdr.TransactionV0Envelope({ tx: v0, signatures: inner.signatures })).toXDR('base64'); reject(f);
});

test('result XDR requires canonical txSuccess / one opInner / paymentSuccess, never standalone payment proof', () => {
  const wrong = [xdr.TransactionResultResult.txFailed([success()]), xdr.TransactionResultResult.txBadAuth(),
    xdr.TransactionResultResult.txSuccess([]), xdr.TransactionResultResult.txSuccess([success(), success()]),
    xdr.TransactionResultResult.txSuccess([xdr.OperationResult.opBadAuth()]),
    xdr.TransactionResultResult.txSuccess([xdr.OperationResult.opInner(xdr.OperationResultTr.payment(xdr.PaymentResult.paymentUnderfunded()))]),
    xdr.TransactionResultResult.txSuccess([xdr.OperationResult.opInner(xdr.OperationResultTr.createAccount(xdr.CreateAccountResult.createAccountSuccess()))])];
  for (const result of wrong) { const f = fixture(); f.transaction.result_xdr = resultXdr(result); reject(f); }
  for (const encoded of [resultXdr() + '\n', Buffer.concat([Buffer.from(resultXdr(), 'base64'), Buffer.alloc(4)]).toString('base64'), resultXdr().replace(/=+$/, '')]) {
    const f = fixture(); f.transaction.result_xdr = encoded; reject(f);
  }
});

test('operation identity, full gross, native and issued asset bindings and decimal ID bounds', () => {
  const invalid = { type: ['path_payment_strict_receive', undefined], type_i: [2, '1'], transaction_successful: [false, 'true'],
    transaction_hash: ['ab'.repeat(32)], source_account: [pool.publicKey()], from: [pool.publicKey()], to: [donor.publicKey()],
    amount: ['1.0000000', '12.00000010', '012.0000001', 12.0000001], id: ['0', '01', '-1', '1.0', '1e2', '1\n', '10000000000000000000', 1],
    asset_type: ['credit_alphanum4'], asset_code: ['XLM'], asset_issuer: [pool.publicKey()] };
  for (const [field, values] of Object.entries(invalid)) for (const value of values) { const f = fixture(); operation(f)[field] = value; reject(f); }
  for (const field of ['source_account_muxed', 'source_account_muxed_id', 'from_muxed', 'from_muxed_id', 'to_muxed', 'to_muxed_id']) {
    const f = fixture(); operation(f)[field] = undefined; reject(f);
  }
  for (const field of ['source_account_muxed', 'source_account_muxed_id']) { const f = fixture(); f.transaction[field] = '1'; reject(f); }
  for (const code of ['USDC', 'LONGASSET123']) for (const change of [{ asset_type: 'native' }, { asset_type: code.length <= 4 ? 'credit_alphanum12' : 'credit_alphanum4' },
    { asset_code: 'OTHER' }, { asset_code: undefined }, { asset_issuer: donor.publicKey() }, { asset_issuer: undefined }]) {
    const f = fixture(code); Object.assign(operation(f), change); reject(f);
  }
});

test('ledger sequence/hash/date and conservative timestamp agreement reject contradictions', () => {
  for (const [field, values] of Object.entries({ sequence: [43, '42', 0], hash: ['AB'.repeat(32), 'a'.repeat(63), 'ab'.repeat(32) + '\n'] })) {
    for (const value of values) { const f = fixture(); f.ledger[field] = value; reject(f); }
  }
  for (const date of ['2023-02-30T00:00:00Z', '2023-11-14T22:13:25.000Z', '2023-11-14T22:13:25+00:00',
    '2023-11-14T22:13:25Z\n', '1969-12-31T23:59:59Z', '9999-12-31T23:55:00Z', undefined]) {
    const f = fixture(); f.ledger.closed_at = f.transaction.created_at = operation(f).created_at = date; reject(f);
  }
  for (const target of ['ledger', 'transaction', 'operation']) {
    const f = fixture(); const value = target === 'operation' ? operation(f) : f[target];
    value[target === 'ledger' ? 'closed_at' : 'created_at'] = '2023-11-14T22:13:26Z'; reject(f);
  }
});
