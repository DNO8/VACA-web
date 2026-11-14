import { Buffer } from 'buffer';
import { Account, Asset, hash, Keypair, Memo, Networks, Operation, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { validateD1Config, type D1Config } from './commands';
import { receiptAccount, receiptAmount, receiptAssert, receiptAsset, receiptId, receiptIncident, receiptRecord, receiptString, receiptStroops, type D1Asset } from './receipt-context';

export type DonationIntent = Readonly<{
  config: D1Config;
  request_id: string;
  donor: string;
  incident_id: string;
  asset: D1Asset;
  amount: string;
}>;
export type DonationParameters = Readonly<{
  /** Current account sequence, before the builder increments its local Account. */
  sequence: string;
  fee: string;
  timebounds: Readonly<{ minTime: number; maxTime: number }>;
}>;
export type DonationTransaction = Readonly<{
  intent: DonationIntent;
  parameters: DonationParameters;
  unsignedXdr: string;
  transactionHash: string;
}>;
export type SignedDonation = DonationTransaction & Readonly<{ signedTxXdr: string }>;
const intentKeys = ['request_id', 'donor', 'incident_id', 'asset', 'amount'] as const;
const maxInt64 = BigInt('9223372036854775807');

/** Retain exactly the caller's original identity/economics; no UUID or time generation. */
export function validateDonationIntent(value: unknown): DonationIntent {
  try {
    const data = receiptRecord(value, ['config', ...intentKeys]);
    const amount = receiptAmount(data.amount);
    receiptAssert(receiptStroops(amount) <= maxInt64);
    return Object.freeze({
      config: validateD1Config(data.config), request_id: receiptId(data.request_id),
      donor: receiptAccount(data.donor), incident_id: receiptIncident(data.incident_id),
      asset: receiptAsset(data.asset), amount,
    });
  } catch {
    throw new Error('d1_invalid_donation_intent');
  }
}

export function createDonationIntent(config: unknown, input: unknown): DonationIntent {
  try {
    return validateDonationIntent({ config, ...receiptRecord(input, intentKeys) });
  } catch {
    throw new Error('d1_invalid_donation_intent');
  }
}

function validateParameters(value: unknown): DonationParameters {
  try {
    const data = receiptRecord(value, ['sequence', 'fee', 'timebounds']);
    const sequence = receiptString(data.sequence, /^(0|[1-9][0-9]{0,18})$/);
    receiptAssert(BigInt(sequence) < maxInt64);
    const fee = receiptString(data.fee, /^[1-9][0-9]{0,9}$/);
    receiptAssert(BigInt(fee) <= BigInt('4294967295'));
    const { minTime, maxTime } = receiptRecord(data.timebounds, ['minTime', 'maxTime']);
    receiptAssert(typeof minTime === 'number' && Number.isSafeInteger(minTime) && minTime >= 0);
    receiptAssert(typeof maxTime === 'number' && Number.isSafeInteger(maxTime) && maxTime > minTime);
    return Object.freeze({ sequence, fee, timebounds: Object.freeze({ minTime, maxTime }) });
  } catch {
    throw new Error('d1_invalid_donation_parameters');
  }
}

/** Pure unsigned builder. Time bounds are transaction validity, NOT D1 financial expiry. */
export function buildDonationTransaction(intent: unknown, parameters: unknown): DonationTransaction {
  const retained = validateDonationIntent(intent);
  const params = validateParameters(parameters);
  try {
    const asset = retained.asset.type === 'native' ? Asset.native() : new Asset(retained.asset.code, retained.asset.issuer);
    const tx = new TransactionBuilder(new Account(retained.donor, params.sequence), {
      fee: params.fee, timebounds: { ...params.timebounds }, networkPassphrase: Networks.TESTNET,
    }).addOperation(Operation.payment({
      source: retained.donor, destination: retained.config.pool_public_key, asset, amount: retained.amount,
    })).addMemo(Memo.hash(hash(Buffer.from('vaca.d1.donation.v1\n' + retained.incident_id, 'utf8')))).build();
    return Object.freeze({ intent: retained, parameters: params, unsignedXdr: tx.toXDR(), transactionHash: tx.hash().toString('hex') });
  } catch {
    throw new Error('d1_invalid_donation_parameters');
  }
}

function validateSnapshot(value: unknown): DonationTransaction {
  try {
    const data = receiptRecord(value, ['intent', 'parameters', 'unsignedXdr', 'transactionHash']);
    // Reconstruction works after JSON reload and proves that unsigned body belongs to the intent.
    // Metadata is not authenticated provenance: a wholly replaced intent still requires external retention.
    const rebuilt = buildDonationTransaction(data.intent, data.parameters);
    receiptAssert(data.unsignedXdr === rebuilt.unsignedXdr && data.transactionHash === rebuilt.transactionHash);
    return rebuilt;
  } catch {
    throw new Error('d1_invalid_donation_snapshot');
  }
}

function walletResult(value: unknown): Record<string, unknown> {
  try {
    receiptAssert(value && typeof value === 'object');
    const keys = ['signedTxXdr', 'signerAddress', 'error'].filter(key => Object.hasOwn(value, key));
    const result = receiptRecord(value, keys);
    receiptAssert(result.error == null);
    return result;
  } catch {
    throw new Error('d1_wallet_error');
  }
}

/** Verify direct donor Ed25519 proof, not account thresholds, ledger inclusion or settlement. */
export function validateSignedDonation(snapshot: unknown, result: unknown): SignedDonation {
  const retained = validateSnapshot(snapshot);
  const response = walletResult(result);
  if (response.signerAddress !== retained.intent.donor) throw new Error('d1_signer_mismatch');
  const signedTxXdr = response.signedTxXdr;
  let signed: Transaction;
  try {
    receiptAssert(typeof signedTxXdr === 'string');
    const parsed = TransactionBuilder.fromXDR(signedTxXdr, Networks.TESTNET);
    receiptAssert(parsed instanceof Transaction && parsed.toEnvelope().switch().value === xdr.EnvelopeType.envelopeTypeTx().value);
    signed = parsed;
  } catch {
    throw new Error('d1_invalid_signed_donation');
  }
  const unsigned = new Transaction(retained.unsignedXdr, Networks.TESTNET);
  if (!signed.signatureBase().equals(unsigned.signatureBase()) || !signed.hash().equals(unsigned.hash())) {
    throw new Error('d1_donation_body_mismatch');
  }
  const key = Keypair.fromPublicKey(retained.intent.donor);
  const verified = signed.signatures.some(signature => {
    try {
      return signature.hint().equals(key.signatureHint()) && key.verify(signed.hash(), signature.signature());
    } catch {
      return false;
    }
  });
  if (!verified) throw new Error('d1_invalid_signature');
  // Do not reserialize the wallet's envelope: durable callers need the EXACT returned XDR.
  return Object.freeze({ ...retained, signedTxXdr: signedTxXdr as string });
}
