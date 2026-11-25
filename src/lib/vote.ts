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
  stage?: 'preflight';
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
  readonly stage?: 'preflight';
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
    this.stage = details.stage;
    this.code = details.code;
    this.eligibleAt = details.eligibleAt;
    this.minAgeSeconds = details.minAgeSeconds;
    this.ageRetryAtMs = details.ageRetryAtMs;
    this.txHash = details.txHash;
  }
}

/** Read-only gate. A missing/legacy response must never authorize signing. */
async function requireWalletAge(supabaseUrl: string, voterPublicKey: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(
      `${supabaseUrl}${VOTE_ENDPOINT}?voter=${encodeURIComponent(voterPublicKey)}&check=wallet_age`,
      { method: 'GET', cache: 'no-store', signal: controller.signal,
        headers: SUPABASE_ANON_KEY ? { apikey: SUPABASE_ANON_KEY } : {} },
    );
    const body = await response.json();
    if (response.status === 200 && body?.wallet_age_eligible === true) return;
    if (response.status === 403 && body?.error === 'wallet_too_new') {
      const deadline = Number.isSafeInteger(body.retry_after) && body.retry_after >= 0
        ? Date.now() + body.retry_after * 1000 : undefined;
      throw new VoteError('wallet_too_new', undefined, {
        stage: 'preflight', code: 'wallet_too_new',
        eligibleAt: typeof body.eligible_at === 'string' ? body.eligible_at : undefined,
        minAgeSeconds: typeof body.min_age_s === 'number' ? body.min_age_s : undefined,
        ageRetryAtMs: typeof deadline === 'number' && Number.isSafeInteger(deadline) && deadline <= 8.64e15 ? deadline : undefined,
      });
    }
  } catch (error) {
    if (error instanceof VoteError) throw error;
  } finally {
    clearTimeout(timer);
  }
  throw new VoteError('No se pudo verificar la antigüedad antes de firmar', undefined, {
    stage: 'preflight', code: 'wallet_age_unavailable',
  });
}

/**
 * Comprueba antigüedad sin efectos → firma manageData → Horizon → registro.
 * El backend vuelve a validar la prueba y la antigüedad antes de aceptar.
 */
export async function castVote(
  supabaseUrl: string,
  voterPublicKey: string,
  incidentId: string,
): Promise<VoteResult> {
  await requireWalletAge(supabaseUrl, voterPublicKey);
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
