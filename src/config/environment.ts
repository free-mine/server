import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

import { z } from 'zod'
import { isAddress } from 'ethers'

import { defaultChain } from './constants.js'
import type { ServerConfig } from './types.js'

const address = z.string().refine(isAddress, 'Invalid EVM address')
const tokenSchema = z.strictObject({
  symbol: z.string().min(1).max(32),
  address,
  decimals: z.number().int().min(0).max(36),
  aave: z.enum(['supply', 'borrow']).optional(),
})

export const chainConfigSchema = z
  .strictObject({
    chainId: z.literal(43114),
    deploymentTx: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    addresses: z.strictObject({
      magicOre: address,
      freeMine: address,
      oreVein: address,
      aavePool: address,
      uniswapFactory: address,
      uniswapPositionManager: address,
    }),
    tokens: z.array(tokenSchema).min(1),
    pairs: z.array(
      z.strictObject({
        baseSymbol: z.string(),
        quoteSymbol: z.string(),
        fee: z.number().int().positive().lt(1_000_000),
      }),
    ),
  })
  .superRefine((chain, ctx) => {
    const symbols = new Set(chain.tokens.map(token => token.symbol))
    const addresses = new Set(
      chain.tokens.map(token => token.address.toLowerCase()),
    )
    if (
      symbols.size !== chain.tokens.length ||
      addresses.size !== chain.tokens.length
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Token symbols and addresses must be unique',
      })
    }
    const pairs = new Set<string>()
    for (const pair of chain.pairs) {
      const key = `${[pair.baseSymbol, pair.quoteSymbol].sort().join('/')}:${pair.fee}`
      if (
        !symbols.has(pair.baseSymbol) ||
        !symbols.has(pair.quoteSymbol) ||
        pair.baseSymbol === pair.quoteSymbol ||
        pairs.has(key)
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Pairs must reference distinct configured tokens and be unique',
        })
      }
      pairs.add(key)
    }
  })

function integer(
  value: string | undefined,
  fallback: number,
  max = 2_147_483_647,
) {
  return z.coerce
    .number()
    .int()
    .positive()
    .max(max)
    .parse(value ?? fallback)
}

export async function loadConfig(env = process.env): Promise<ServerConfig> {
  const chain = env.CHAIN_CONFIG_FILE
    ? JSON.parse(await readFile(env.CHAIN_CONFIG_FILE, 'utf8'))
    : defaultChain
  const rpcUrl = env.RPC_URL ?? 'https://api.avax.network/ext/bc/C/rpc'
  const parsedUrl = new URL(rpcUrl)
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('RPC_URL must use HTTP or HTTPS')
  }
  return {
    chain: chainConfigSchema.parse(chain),
    rpcUrl,
    host: env.HOST ?? '0.0.0.0',
    port: integer(env.PORT, 3000, 65535),
    dataDir: resolve(env.DATA_DIR ?? 'data'),
    ownerKeyHashFile: resolve(
      env.OWNER_KEY_HASH_FILE ?? 'secrets/owner-key.sha256',
    ),
    syncIntervalMs: integer(env.SYNC_INTERVAL_MS, 3_600_000),
    logBatchSize: integer(env.LOG_BATCH_SIZE, 2000, 100_000),
    rpcTimeoutMs: integer(env.RPC_TIMEOUT_MS, 30_000, 300_000),
  }
}
