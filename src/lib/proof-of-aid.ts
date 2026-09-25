export const PROOF_OF_AID_MOCK = {
  tokenId: 1,
  contractId: 'CAE2RWTDM3Q5SJRSLIP247F2ERB4AXJTCVNYNCFHYBVKJL42HKARYDSP',
  mintTxHash: 'a8c14a0dbf0b712622454861df07a9f8104bae80d0227fa22e1c04de2b0e3509',
  claimTxHash: '71c104bc9c211790fc2cd6d62750e3780226cffa9d31993d6e8b41c85214d024',
  incidentHash: 'a1f5f1eef1046b169e8296d946c7e946c1026848cd68172d219e2dbb3cebe7d3',
  imageHash: 'ed2581976b1bbf6893f0824e509dda2753364d1780330b65f401fa771dbd99c4',
  recipient: 'GCJYF5YTPSOOT5XY6IUJ3TYB5VTT6FI2JMP2WJ5ODKN5MFKIKUROSB2E',
  issuedAt: '2026-09-23T15:09:12.000Z',
  imagePath: '/proof-of-aid.png',
} as const;

export function proofMintExplorerUrl(): string {
  return `https://stellar.expert/explorer/testnet/tx/${PROOF_OF_AID_MOCK.mintTxHash}`;
}

export function proofContractLabUrl(): string {
  return `https://lab.stellar.org/r/testnet/contract/${PROOF_OF_AID_MOCK.contractId}`;
}
