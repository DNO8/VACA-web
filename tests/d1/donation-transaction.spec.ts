import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { Account, Asset, Keypair, Memo, Networks, Operation, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { buildDonationTransaction, createDonationIntent, validateDonationIntent, validateSignedDonation } from '../../src/lib/d1/donation-transaction';

// Public deterministic fixtures only; no live wallet, network or funds.
const donor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const id = 'abcdef01-2345-6789-abcd-0123456789ab';
const config = { network: 'TESTNET', pool_public_key: other.publicKey(), namespace: id, donation_ttl_seconds: 300 };
const issued = { type: 'issued', code: 'USD', issuer: other.publicKey() };
const input = (asset: object = { type: 'native' }) => ({ request_id: id, donor: donor.publicKey(), incident_id: 'incident: not a UUID', asset, amount: '12.0000001' });
const parameters = () => ({ sequence: '9007199254740993', fee: '100', timebounds: { minTime: 1700000000, maxTime: 1700000060 } });
const build = () => buildDonationTransaction(createDonationIntent(config, input()), parameters());
function transaction(xdr: string): Transaction {
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  expect(tx).toBeInstanceOf(Transaction);
  return tx as Transaction;
}
function signed(snapshot: ReturnType<typeof build>, key = donor, network = Networks.TESTNET) {
  const tx = new Transaction(snapshot.unsignedXdr, network);
  tx.sign(key);
  return { signedTxXdr: tx.toXDR(), signerAddress: donor.publicKey() };
}
function immutableCopy(actual: unknown, original: unknown) {
  expect(actual).toEqual(original);
  if (actual && typeof actual === 'object') {
    expect(actual).not.toBe(original);
    expect(Object.isFrozen(actual)).toBe(true);
    expect(Object.isFrozen(original)).toBe(false);
    for (const key of Object.keys(actual)) immutableCopy(Reflect.get(actual, key), Reflect.get(original as object, key));
  }
}
function rejects(call: () => unknown, error: string, ...inputs: unknown[]) {
  const retained: [object, PropertyDescriptorMap, boolean][] = [];
  function remember(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    retained.push([value, descriptors, Object.isFrozen(value)]);
    for (const descriptor of Object.values(descriptors)) if ('value' in descriptor) remember(descriptor.value);
  }
  inputs.forEach(remember);
  expect(call).toThrow(new RegExp(`^${error}$`));
  for (const [value, descriptors, frozen] of retained) {
    expect(Object.getOwnPropertyDescriptors(value)).toEqual(descriptors);
    expect(Object.isFrozen(value)).toBe(frozen);
  }
}

for (const asset of [{ type: 'native' }, issued]) {
  test(`${asset.type}: exact original bindings, independent frozen intent/build/signed snapshots`, () => {
    const original = { config: { ...config }, ...input({ ...asset }) };
    const intent = createDonationIntent(original.config, input(original.asset));
    immutableCopy(intent, original);
    immutableCopy(validateDonationIntent(original), original);
    const params = parameters();
    const result = buildDonationTransaction(original, params);
    immutableCopy(result.intent, original);
    immutableCopy(result.parameters, params);
    expect(Object.isFrozen(result)).toBe(true);
    const tx = transaction(result.unsignedXdr);
    expect(tx.source).toBe(original.donor);
    expect(tx.sequence).toBe('9007199254740994');
    expect(tx.fee).toBe('100');
    expect(tx.timeBounds).toEqual({ minTime: '1700000000', maxTime: '1700000060' });
    expect(tx.signatures).toHaveLength(0);
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0]).toEqual({ type: 'payment', source: original.donor, destination: config.pool_public_key,
      asset: asset.type === 'native' ? Asset.native() : new Asset(issued.code, issued.issuer), amount: original.amount });
    expect(result.transactionHash).toBe(tx.hash().toString('hex'));
    // Rehydrated plain data works: no process-local WeakSet/brand requirement.
    const retained = JSON.parse(JSON.stringify(result));
    const reply = { ...signed(result), signedTxXdr: signed(result).signedTxXdr + '\n', error: null };
    const validated = validateSignedDonation(retained, reply);
    immutableCopy(validated, { ...retained, signedTxXdr: reply.signedTxXdr });
    expect(validated.signedTxXdr).toBe(reply.signedTxXdr);
    original.config.pool_public_key = donor.publicKey();
    original.incident_id = 'changed';
    params.timebounds.maxTime++;
    expect(result.intent.config.pool_public_key).toBe(config.pool_public_key);
    expect(result.intent.incident_id).toBe('incident: not a UUID');
    expect(result.parameters.timebounds.maxTime).toBe(1700000060);
  });
}

test('D1 memo uses the domain and full exact incident, never legacy vq truncation', () => {
  // Independent Node-crypto oracle, fixed literal preimage (not the implementation helper).
  const expected = createHash('sha256').update('vaca.d1.donation.v1\nincident: not a UUID', 'utf8').digest('hex');
  expect(expected).toBe('a341169b7a49f40a4249a48acb49c3a8214a15231c96b089453ae3b5879a9794');
  const memo = transaction(build().unsignedXdr).memo;
  expect(memo.type).toBe('hash');
  expect((memo.value as Buffer).toString('hex')).toBe(expected);
  const prefix = 'a'.repeat(255);
  const hashes = [prefix + 'x', prefix + 'y'].map(incident_id => {
    const tx = buildDonationTransaction(createDonationIntent(config, { ...input(), incident_id }), parameters());
    return (transaction(tx.unsignedXdr).memo.value as Buffer).toString('hex');
  });
  expect(hashes[0]).not.toBe(hashes[1]);
});

test('accepts positive signed64 stroop boundaries and exact sequence/fee/time boundaries', () => {
  for (const amount of ['0.0000001', '922337203685.4775807']) {
    const intent = createDonationIntent(config, { ...input(), amount });
    for (const sequence of ['0', '9223372036854775806']) {
      const result = buildDonationTransaction(intent, { sequence, fee: '4294967295', timebounds: { minTime: 0, maxTime: Number.MAX_SAFE_INTEGER } });
      const tx = transaction(result.unsignedXdr);
      expect(tx.sequence).toBe((BigInt(sequence) + BigInt(1)).toString());
      expect(tx.fee).toBe('4294967295');
      expect(tx.timeBounds).toEqual({ minTime: '0', maxTime: String(Number.MAX_SAFE_INTEGER) });
      expect(tx.operations[0]).toMatchObject({ type: 'payment', amount });
    }
  }
});

test('rejects invalid config, identities, assets and money without normalization or mutation', () => {
  for (const change of [{ network: 'PUBLIC' }, { pool_public_key: 'bad' }, { namespace: id.toUpperCase() }, { donation_ttl_seconds: 301 }, { extra: true }]) {
    const settings = { ...config, ...change }, value = input();
    rejects(() => createDonationIntent(settings, value), 'd1_invalid_donation_intent', settings, value);
  }
  const invalid = {
    request_id: ['id', id.toUpperCase(), id + '\n', 1], donor: ['bad', donor.publicKey().toLowerCase(), 1],
    incident_id: ['', ' incident', 'incident ', 'x\n', 'é', 'x'.repeat(257)],
    amount: ['0.0000000', '922337203685.4775808', '999999999999.9999999', '1', '01.0000000', '-1.0000000', '1.000000', '1.00000000', '1e2', '1.0000000\n', 1],
    asset: [{}, { type: 'native', issuer: other.publicKey() }, { type: 'issued', code: 'USD' }, { ...issued, issuer: 'bad' }, { ...issued, code: '' }, { ...issued, code: 'a'.repeat(13) }],
  };
  for (const [key, values] of Object.entries(invalid)) for (const value of values) {
    const candidate = { config: { ...config }, ...input(), [key]: value };
    rejects(() => validateDonationIntent(candidate), 'd1_invalid_donation_intent', candidate);
    rejects(() => buildDonationTransaction(candidate, parameters()), 'd1_invalid_donation_intent', candidate);
  }
});

test('rejects noncanonical/overflow sequence, fee and explicit timebounds without mutation', () => {
  const invalid = {
    sequence: ['-1', '01', '1.0', '1e2', '1\n', 1, '9223372036854775807', '18446744073709551615'],
    fee: ['0', '-1', '01', '1.0', '100\n', '4294967296', 100],
    timebounds: [undefined, {}, { minTime: -1, maxTime: 1 }, { minTime: 1, maxTime: 1 }, { minTime: 2, maxTime: 1 },
      { minTime: 0, maxTime: 0 }, { minTime: 0, maxTime: Infinity }, { minTime: 0.5, maxTime: 1 },
      { minTime: '0', maxTime: 1 }, { minTime: NaN, maxTime: 1 }, { minTime: 0, maxTime: Number.MAX_SAFE_INTEGER + 1 }],
  };
  const intent = { config: { ...config }, ...input() };
  for (const [key, values] of Object.entries(invalid)) for (const value of values) {
    const params = { ...parameters(), [key]: value };
    rejects(() => buildDonationTransaction(intent, params), 'd1_invalid_donation_parameters', intent, params);
  }
});

test('strict data shapes reject hidden, unknown, symbol and accessor fields without calling getters', () => {
  for (const location of ['intent', 'config', 'asset', 'parameters', 'timebounds']) for (const kind of ['extra', 'hidden', 'symbol', 'accessor']) {
    const intent = { config: { ...config }, ...input({ ...issued }) }, params = parameters();
    const targets: Record<string, object> = { intent, config: intent.config, asset: intent.asset, parameters: params, timebounds: params.timebounds };
    const target = targets[location];
    let calls = 0;
    const key = kind === 'symbol' ? Symbol('extra') : kind === 'accessor' ? Object.keys(target)[0] : kind;
    Object.defineProperty(target, key, kind === 'accessor'
      ? { enumerable: true, get: () => { calls++; return 'bad'; } }
      : { enumerable: kind !== 'hidden', value: true });
    rejects(() => buildDonationTransaction(intent, params), location === 'parameters' || location === 'timebounds'
      ? 'd1_invalid_donation_parameters' : 'd1_invalid_donation_intent', intent, params);
    expect(calls).toBe(0);
  }
});

test('wallet errors, signer strings, malformed XDR and invalid signatures fail closed', () => {
  const snapshot = build();
  const valid = signed(snapshot);
  const invalid: [unknown, string][] = [
    [null, 'd1_wallet_error'], [{ ...valid, error: false }, 'd1_wallet_error'], [{ ...valid, error: { message: 'rejected' } }, 'd1_wallet_error'],
    [{ ...valid, signerAddress: other.publicKey() }, 'd1_signer_mismatch'], [{ signedTxXdr: valid.signedTxXdr }, 'd1_signer_mismatch'],
    [{ ...valid, signedTxXdr: 'bad' }, 'd1_invalid_signed_donation'], [{ ...valid, signedTxXdr: snapshot.unsignedXdr }, 'd1_invalid_signature'],
    [signed(snapshot, other), 'd1_invalid_signature'], [signed(snapshot, donor, Networks.PUBLIC), 'd1_invalid_signature'],
  ];
  for (const [result, error] of invalid) {
    const retained = JSON.parse(JSON.stringify(snapshot));
    rejects(() => validateSignedDonation(retained, result), error, retained);
  }
  const tx = transaction(snapshot.unsignedXdr);
  tx.addDecoratedSignature(new xdr.DecoratedSignature({ hint: donor.signatureHint(), signature: Buffer.alloc(64) }));
  expect(() => validateSignedDonation(snapshot, { ...valid, signedTxXdr: tx.toXDR() })).toThrow(/^d1_invalid_signature$/);
});

test('rejects signed changed payment/body, extra operations, fee-bumps and v0 envelopes', () => {
  const snapshot = build();
  for (const change of [{ amount: '12.0000002' }, { donor: other.publicKey() }, { incident_id: 'other' }, { asset: issued }]) {
    const changed = buildDonationTransaction(createDonationIntent(config, { ...input(), ...change }), parameters());
    expect(() => validateSignedDonation(snapshot, signed(changed))).toThrow(/^d1_donation_body_mismatch$/);
  }
  for (const change of [{ sequence: '1' }, { fee: '101' }, { timebounds: { minTime: 0, maxTime: 1 } }]) {
    const changed = buildDonationTransaction(snapshot.intent, { ...parameters(), ...change });
    expect(() => validateSignedDonation(snapshot, signed(changed))).toThrow(/^d1_donation_body_mismatch$/);
  }
  const payment = Operation.payment({ source: donor.publicKey(), destination: config.pool_public_key, amount: '12.0000001', asset: Asset.native() });
  const changed = new TransactionBuilder(new Account(donor.publicKey(), parameters().sequence), { ...parameters(), networkPassphrase: Networks.TESTNET })
    .addOperation(payment).addOperation(payment).addMemo(Memo.text('vq:incident')).build();
  changed.sign(donor);
  expect(() => validateSignedDonation(snapshot, { signedTxXdr: changed.toXDR(), signerAddress: donor.publicKey() })).toThrow(/^d1_donation_body_mismatch$/);
  const inner = transaction(signed(snapshot).signedTxXdr);
  const bump = TransactionBuilder.buildFeeBumpTransaction(other.publicKey(), '100', inner, Networks.TESTNET);
  expect(() => validateSignedDonation(snapshot, { signedTxXdr: bump.toXDR(), signerAddress: donor.publicKey() })).toThrow(/^d1_invalid_signed_donation$/);
  const body = inner.toEnvelope().v1().tx();
  const v0 = new xdr.TransactionV0({ sourceAccountEd25519: donor.rawPublicKey(), fee: body.fee(), seqNum: body.seqNum(),
    timeBounds: body.cond().timeBounds(), memo: body.memo(), operations: body.operations(), ext: xdr.TransactionV0Ext.fromXDR('00000000', 'hex') });
  const envelope = xdr.TransactionEnvelope.envelopeTypeTxV0(new xdr.TransactionV0Envelope({ tx: v0, signatures: inner.signatures }));
  expect(() => validateSignedDonation(snapshot, { signedTxXdr: envelope.toXDR('base64'), signerAddress: donor.publicKey() })).toThrow(/^d1_invalid_signed_donation$/);
});

test('rehydrated snapshots cannot substitute unsigned body/hash or retain unsigned signatures', () => {
  const snapshot = build(), reply = signed(snapshot);
  const changed = buildDonationTransaction(createDonationIntent(config, { ...input(), amount: '2.0000000' }), parameters());
  for (const change of [{ unsignedXdr: changed.unsignedXdr, transactionHash: changed.transactionHash },
    { unsignedXdr: reply.signedTxXdr }, { transactionHash: 'ab'.repeat(32) }, { parameters: { ...parameters(), fee: '101' } },
    { intent: changed.intent }, { extra: true }]) {
    const retained = { ...snapshot, ...change };
    rejects(() => validateSignedDonation(retained, reply), 'd1_invalid_donation_snapshot', retained);
  }
});
