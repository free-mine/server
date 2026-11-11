import { z } from 'zod'

const units = z.string().regex(/^(0|[1-9]\d*)$/)
const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/)
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const tokenBalance = z.strictObject({
  symbol: z.string().min(1),
  address,
  decimals: z.number().int().min(0).max(255),
  amount: units,
})
const pairAmounts = z.strictObject({ base: units, quote: units })
const pool = z.strictObject({
  baseSymbol: z.string().min(1),
  quoteSymbol: z.string().min(1),
  fee: z.number().int().positive().max(999999),
  address: address.nullable(),
  price: decimal.nullable(),
})
const position = z.strictObject({
  tokenId: units,
  pool: address,
  baseSymbol: z.string().min(1),
  quoteSymbol: z.string().min(1),
  fee: z.number().int().positive().max(999999),
  liquidity: units,
  range: z.strictObject({
    lowerPrice: decimal,
    upperPrice: decimal,
    fullRange: z.boolean(),
  }),
  inRange: z.boolean(),
  price: decimal,
  amounts: pairAmounts,
  // Only growth since the last NFT accounting update is identifiable as fees.
  newlyAccruedFees: pairAmounts,
  // NPM tokensOwed mixes older fees with principal from decreaseLiquidity.
  storedOwed: pairAmounts,
  // Combined claim including removed principal; it is not a fee-only amount.
  totalCollectable: pairAmounts,
})

export const portfolioStateSchema = z.strictObject({
  blockNumber: z.number().int().nonnegative(),
  nativeBalance: z.strictObject({
    symbol: z.literal('AVAX'),
    decimals: z.literal(18),
    amount: units,
  }),
  balances: z.array(tokenBalance),
  aave: z.strictObject({
    supplies: z.array(tokenBalance),
    debts: z.array(
      tokenBalance.extend({ variableDebt: units, stableDebt: units }),
    ),
    healthFactor: decimal.nullable(),
  }),
  uniswap: z.strictObject({
    pools: z.array(pool),
    positions: z.array(position),
  }),
})
