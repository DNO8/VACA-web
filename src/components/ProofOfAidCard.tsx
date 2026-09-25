import Image from 'next/image';
import { ExternalLink, FileKey2 } from 'lucide-react';
import {
  PROOF_OF_AID_MOCK,
  proofContractLabUrl,
  proofMintExplorerUrl,
} from '@/lib/proof-of-aid';

export default function ProofOfAidCard() {
  return (
    <article
      aria-label="Proof of Aid mock NFT"
      className="overflow-hidden rounded-lg border border-[rgba(126,240,210,0.35)] bg-[rgba(5,18,24,0.72)]"
    >
      <div className="relative aspect-[715/747] overflow-hidden bg-black/30">
        <Image
          src={PROOF_OF_AID_MOCK.imagePath}
          alt="Mock NFT Proof of Aid: corazón cristalino con registro digital"
          fill
          sizes="(max-width: 768px) 90vw, 360px"
          className="object-cover"
          priority={false}
        />
        <div className="absolute left-2 top-2 rounded-full border border-[rgba(126,240,210,0.5)] bg-black/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#a8ffe8]">
          Soroban Testnet · Mock NFT #{PROOF_OF_AID_MOCK.tokenId}
        </div>
      </div>

      <div className="space-y-2 p-3 text-[11px] text-[var(--text-secondary)]">
        <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
          <FileKey2 size={14} className="text-[#7ef0d2]" />
          Proof of Aid registrado on-chain
        </div>
        <p>
          Prototipo no transferible. El contrato guarda beneficiario, hashes del incidente,
          claim e imagen, y la fecha del ledger.
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 font-mono text-[10px]">
          <dt className="text-[var(--text-muted)]">Contrato</dt>
          <dd className="truncate">{PROOF_OF_AID_MOCK.contractId}</dd>
          <dt className="text-[var(--text-muted)]">Imagen</dt>
          <dd className="truncate">sha256:{PROOF_OF_AID_MOCK.imageHash}</dd>
        </dl>
        <p className="rounded border border-[var(--border-secondary)] bg-black/20 px-2 py-1.5 text-[10px] text-[var(--text-muted)]">
          Imagen incluida localmente para la demo · sin IPFS.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <a
            href={proofMintExplorerUrl()}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-center gap-1 rounded border border-[rgba(126,240,210,0.4)] px-2 py-1.5 font-semibold text-[#a8ffe8]"
          >
            Ver mint <ExternalLink size={11} />
          </a>
          <a
            href={proofContractLabUrl()}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-center gap-1 rounded border border-[var(--border-secondary)] px-2 py-1.5 font-semibold text-[var(--text-primary)]"
          >
            Ver contrato <ExternalLink size={11} />
          </a>
        </div>
      </div>
    </article>
  );
}
