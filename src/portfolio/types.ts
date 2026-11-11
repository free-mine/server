import type { z } from 'zod'
import type { Contract } from 'ethers'

import type { portfolioStateSchema } from './schema.js'
import type { PairConfig, TokenConfig } from '../config/index.js'

export type PortfolioState = z.infer<typeof portfolioStateSchema>
export type TokenBalance = PortfolioState['balances'][number]
export type UniswapPosition = PortfolioState['uniswap']['positions'][number]

export interface FeeGrowthInput {
  global: bigint
  liquidity: bigint
  lowerTick: number
  upperTick: number
  lastInside: bigint
  currentTick: number
  lowerOutside: bigint
  upperOutside: bigint
}

export interface PoolSnapshot {
  tick: number
  address: string
  base: TokenConfig
  contract: Contract
  quote: TokenConfig
  config: PairConfig
  feeGrowth0: bigint
  feeGrowth1: bigint
  tickSpacing: number
  sqrtPriceX96: bigint
  baseIsToken0: boolean
}
