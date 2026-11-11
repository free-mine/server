import { Interface } from 'ethers'

export const magicOreAbi = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function owner() view returns (address)',
])

export const oreVeinAbi = new Interface([
  'event SuccessorScheduled(address indexed successor, uint256 previousClaimableAt, uint256 claimableAt, address indexed scheduledBy)',
  'event SuccessorRemoved(address indexed successor, uint256 claimableAt, address indexed removedBy)',
  'event AdminActivated(address indexed admin, uint256 claimableAt)',
  'event AdminRemoved(address indexed admin)',
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function freeMine() view returns (address)',
  'function contractURI() view returns (string)',
])

export const freeMineAbi = new Interface([
  'event ClaimOpened(uint256 oreAmount, address indexed miner, uint256 indexed shiftId, uint256 indexed claimId)',
  'event ClaimClosed(bool cancelled, address indexed miner, uint256 indexed shiftId, uint256 indexed claimId)',
  'function owner() view returns (address)',
  'function magicOre() view returns (address)',
  'function dollar() view returns (address)',
  'function entryPrice() view returns (uint256)',
  'function priceUpdatedAt() view returns (uint256)',
  'function currentShiftId() view returns (uint256)',
  'function shifts(uint256) view returns (bool funded, uint256 price, address dollar, uint256 fundedAt, uint256 oreAmount, uint256 dollarScale, uint256 currentClaimId)',
])

export const dollarAbi = new Interface([
  'function decimals() view returns (uint8)',
])
