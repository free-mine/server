import { z } from 'zod'

import { fundStateSchema } from '../fund/index.js'
import type { ChainConfig } from '../config/index.js'
import { portfolioStateSchema } from '../portfolio/index.js'

const hash = z.string().regex(/^0x[0-9a-f]{64}$/)
const address = z.string().regex(/^0x[0-9a-f]{40}$/)

export const snapshotSchema = z
  .strictObject({
    format: z.literal(1),
    chain: z.strictObject({
      chainId: z.literal(43114),
      deploymentTx: hash,
      magicOre: address,
      freeMine: address,
      oreVein: address,
    }),
    block: z.strictObject({
      number: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      hash,
      timestamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
    updatedAt: z.iso.datetime(),
    fund: fundStateSchema,
    portfolio: portfolioStateSchema,
  })
  .refine(
    snapshot => snapshot.portfolio.blockNumber === snapshot.block.number,
    {
      message: 'Fund and portfolio must refer to the same block',
    },
  )
  .superRefine((snapshot, ctx) => {
    if (
      snapshot.fund.freeMine.magicOre !== snapshot.chain.magicOre ||
      snapshot.fund.oreVein.freeMine !== snapshot.chain.freeMine
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Fund references do not match the configured deployment',
      })
    }
    const locked = Object.values(snapshot.fund.freeMine.claims).reduce(
      (sum, claim) => sum + BigInt(claim.oreAmount),
      0n,
    )
    if (
      BigInt(snapshot.fund.magicOre.holders[snapshot.chain.freeMine] ?? '0') <
      locked
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Active claims exceed the MagicOre balance held by FreeMine',
      })
    }
  })

export function chainIdentity(config: ChainConfig) {
  return {
    chainId: config.chainId,
    deploymentTx: config.deploymentTx.toLowerCase(),
    magicOre: config.addresses.magicOre.toLowerCase(),
    freeMine: config.addresses.freeMine.toLowerCase(),
    oreVein: config.addresses.oreVein.toLowerCase(),
  }
}
