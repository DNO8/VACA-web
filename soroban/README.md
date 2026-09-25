# Proof of Aid — Soroban Testnet mock

This contract mints a unique, non-transferable Proof of Aid record after a
beneficiary claims aid. It is a prototype NFT-shaped record, not an NFT
standard implementation.

## Recorded on-chain

| Field | Meaning |
| --- | --- |
| `id` | Sequential proof identifier |
| `recipient` | Beneficiary Stellar address |
| `incident_hash` | SHA-256 binding to the incident/demo run |
| `claim_tx_hash` | Stellar claim transaction linked to the proof |
| `image_hash` | SHA-256 of `public/proof-of-aid.png` |
| `issued_at` | Testnet ledger timestamp |

The image is bundled with the web demo. No IPFS or decentralized media
storage is claimed.

## Verify

```powershell
pnpm test:proof-of-aid
pnpm build:proof-of-aid
```

## Testnet evidence

- Contract: `CAE2RWTDM3Q5SJRSLIP247F2ERB4AXJTCVNYNCFHYBVKJL42HKARYDSP`
- WASM hash: `68e1b36b8e8ed9f7f437fd2d8048fc9862fc2bab9089a2ca65d3877cd7160973`
- WASM upload transaction: `e9fc156ce46221c3d395241704628f78dded7515351398e7894adde44fe052b4`
- Deploy transaction: `7c26f9add728ee16cbc674283c9d3eaa0bca1bd0bef216d05e5f59a8d3027d91`
- Proof mint transaction: `a8c14a0dbf0b712622454861df07a9f8104bae80d0227fa22e1c04de2b0e3509`
- Proof ID: `1`
- Image SHA-256: `ed2581976b1bbf6893f0824e509dda2753364d1780330b65f401fa771dbd99c4`

The `ProofMinted` event binds proof `#1` to the existing Testnet claim
transaction and the local image hash.
