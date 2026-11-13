import type { Log } from 'ethers'

export interface FundClaim {
  miner: string
  shiftId: string
  claimId: string
  oreAmount: string
}

export interface FundShift {
  price: string
  dollar: string
  funded: boolean
  fundedAt: string
  oreAmount: string
  dollarScale: string
  currentClaimId: string
}

export interface FundState {
  magicOre: {
    name: string
    owner: string
    symbol: string
    decimals: number
    totalSupply: string
    holders: Record<string, string>
  }
  oreVein: {
    owner: string
    freeMine: string
    admins: string[]
    contractURI: string
    pendingOwner: string
    successors: Record<string, string>
  }
  freeMine: {
    owner: string
    magicOre: string
    entryPrice: string
    priceUpdatedAt: string
    currentShiftId: string
    claims: Record<string, FundClaim>
    shifts: Record<string, FundShift>
    dollar: { address: string; decimals: number }
  }
}

export interface EventState {
  admins: Set<string>
  holders: Record<string, string>
  claims: Record<string, FundClaim>
  successors: Record<string, string>
}

export type RetryDelay = (milliseconds: number) => Promise<void>

export interface LogBatch {
  logs: Log[]
  toBlock: number
  fromBlock: number
}
