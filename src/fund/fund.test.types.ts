import type { Log } from 'ethers'

import type { FundShift } from './types.js'

export interface FixtureOptions {
  logs?: Log[]
  failCalls?: boolean
  rangeLimit?: number
  totalSupply?: bigint
  currentShiftId?: bigint
  permanentLogError?: boolean
  shifts?: Record<string, FundShift>
}

export interface GetterCall {
  method: string
  blockTag: unknown
}

export interface LogRange {
  toBlock: number
  fromBlock: number
}
