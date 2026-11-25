// Voto comunitario on-chain (testnet): el votante firma una tx
// manageData {vq-vote: incidentId} en su propia cuenta — un ballot público e
// inmutable. El servidor verifica la tx por hash contra Horizon, aplica
// cooldown 5 min, dedup por incidente y auto-promueve al umbral.

import {
  TransactionBuilder,
  Operation,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import { signTransaction } from '@stellar/freighter-api';
import { getServer, NETWORK } from './stellar';
import { fundIfMissing } from './donate';

const VOTE_ENDPOINT = '/functions/v1/vaquita-vote';
const VOTE_DATA_NAME = 'vq-vote';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

export interface VoteResult {
  votes: number;
  donationStatus: string | null;
  cooldownS: number;
  txHash: string;
  explorerUrl: string;
}

export interface VoteFailureDetails {
  code?: string;
  eligibleAt?: string;
  minAgeSeconds?: number;
  /** Absolute fallback deadline derived once from the server's age retry_after. */
  ageRetryAtMs?: number;
  txHash?: string;
}

export interface VoteFeedbackState extends VoteFailureDetails {
  accepted: boolean;
  message?: string;
}

export class VoteError extends Error {
  readonly code?: string;
  readonly eligibleAt?: string;
  readonly minAgeSeconds?: number;
  readonly ageRetryAtMs?: number;
  readonly txHash?: string;

  constructor(
    message: string,
    public readonly retryAfter?: number,
    details: VoteFailureDetails = {},
  ) {
    super(message);
    this.code = details.code;
    this.eligibleAt = details.eligibleAt;
    this.minAgeSeconds = details.minAgeSeconds;
    this.ageRetryAtMs = details.ageRetryAtMs;
    this.txHash = details.txHash;
  }
}

/**
 * Emite el voto: tx manageData firmada por el votante → Horizon → hash como
 * prueba al backend. El ballot queda público en el ledger de testnet.
 */
export async function castVote(
  supabaseUrl: string,
  voterPublicKey: string,
  incidentId: string,
): Promise<VoteResult> {
  const srv = getServer();
  await fundIfMissing(voterPublicKey);
  const source = await srv.loadAccount(voterPublicKey);

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.manageData({ name: VOTE_DATA_NAME, value: incidentId }),
    )
    .setTimeout(180)
    .build();

  const { signedTxXdr, error } = await signTransaction(tx.toXDR(), {
    networkPassphrase: NETWORK,
    address: voterPublicKey,
  });
  if (error || !signedTxXdr) {
    throw new VoteError(error?.message ?? 'Firma rechazada');
  }

  const signed = TransactionBuilder.fromXDR(signedTxXdr, NETWORK);
  const submitted = await srv.submitTransaction(signed);
  const txHash = submitted.hash;

  let resp: Response;
  try {
    resp = await fetch(`${supabaseUrl}${VOTE_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(SUPABASE_ANON_KEY ? { apikey: SUPABASE_ANON_KEY } : {}),
      },
      body: JSON.stringify({
        incident_id: incidentId,
        public_key: voterPublicKey,
        tx_hash: txHash,
      }),
    });
  } catch {
    // Submission already succeeded; a missing API response must not lose its proof.
    throw new VoteError('No se pudo confirmar el registro del voto', undefined, {
      code: 'registration_unconfirmed', txHash,
    });
  }
  const body = await resp.json().catch(() => ({}));
  const ageRetryAtMs = body?.error === 'wallet_too_new' && Number.isSafeInteger(body?.retry_after) && body.retry_after >= 0
    ? Date.now() + body.retry_after * 1000 : undefined;
  const details: VoteFailureDetails = {
    code: typeof body?.error === 'string' ? body.error : 'registration_unconfirmed',
    eligibleAt: typeof body?.eligible_at === 'string' ? body.eligible_at : undefined,
    minAgeSeconds: typeof body?.min_age_s === 'number' ? body.min_age_s : undefined,
    ageRetryAtMs: typeof ageRetryAtMs === 'number' && Number.isSafeInteger(ageRetryAtMs) && ageRetryAtMs <= 8.64e15 ? ageRetryAtMs : undefined,
    txHash,
  };

  if (resp.status === 429) {
    throw new VoteError(
      `Puedes votar de nuevo en ${body?.retry_after ?? '?'} s`,
      body?.retry_after,
      { ...details, code: 'cooldown' },
    );
  }
  if (resp.status === 409) {
    throw new VoteError('Ya votaste esta señal', undefined, { ...details, code: 'already_voted' });
  }
  if (!resp.ok) {
    // Age eligibility is not the five-minute voting cooldown.
    throw new VoteError(body?.error ?? 'No se pudo registrar el voto', undefined, details);
  }

  if (body?.ok !== true || !Number.isSafeInteger(body?.votes) || body.votes < 0) {
    throw new VoteError('No se pudo confirmar el registro del voto', undefined, {
      code: 'registration_unconfirmed', txHash,
    });
  }

  return {
    votes: Number(body.votes ?? 0),
    donationStatus: body.donation_status ?? null,
    cooldownS: Number(body.cooldown_s ?? 300),
    txHash,
    explorerUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
  };
}

/** Cooldown restante del votante (0 = puede votar ya). Sin side-effects. */
export async function getVoteCooldown(
  supabaseUrl: string,
  voterPublicKey: string,
): Promise<number> {
  try {
    const resp = await fetch(
      `${supabaseUrl}${VOTE_ENDPOINT}?voter=${voterPublicKey}`,
      { headers: SUPABASE_ANON_KEY ? { apikey: SUPABASE_ANON_KEY } : {} },
    );
    const body = await resp.json();
    return Math.max(0, Number(body?.retry_after ?? 0));
  } catch {
    return 0;
  }
}
