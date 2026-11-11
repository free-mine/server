import { join } from 'node:path'

import { chainIdentity } from '../snapshot/index.js'
import type { ServerConfig } from '../config/index.js'
import type { PublicSnapshot } from '../snapshot/index.js'
import { settings, defaultChain } from '../config/index.js'

export function makeConfig(directory: string): ServerConfig {
  return {
    ...settings,
    chain: structuredClone(defaultChain),
    rpcUrl: 'http://localhost:8545',
    host: '127.0.0.1',
    dataDir: directory,
    ownerKeyHashFile: join(directory, 'owner-key.sha256'),
  }
}

export function makeSnapshot(): PublicSnapshot {
  const zero = `0x${'0'.repeat(40)}`
  const { freeMine, magicOre, oreVein } = chainIdentity(defaultChain)
  const shift = {
    funded: false,
    price: '0',
    dollar: zero,
    fundedAt: '0',
    oreAmount: '0',
    dollarScale: '0',
    currentClaimId: '0',
  }
  return {
    format: 1,
    chain: chainIdentity(defaultChain),
    block: { number: 100, hash: `0x${'a'.repeat(64)}`, timestamp: 1700000000 },
    updatedAt: '2026-11-11T00:00:00.000Z',
    fund: {
      magicOre: {
        name: 'Magic Ore',
        symbol: 'ORE',
        owner: freeMine,
        decimals: 18,
        totalSupply: '0',
        holders: {},
      },
      oreVein: {
        owner: `0x${'1'.repeat(40)}`,
        pendingOwner: zero,
        freeMine,
        contractURI: '',
        admins: [],
        successors: { [`0x${'2'.repeat(40)}`]: '1900000000' },
      },
      freeMine: {
        owner: oreVein,
        magicOre,
        entryPrice: '1000000000000000000',
        priceUpdatedAt: '1700000000',
        currentShiftId: '1',
        dollar: {
          address: defaultChain.tokens[3]?.address.toLowerCase() ?? zero,
          decimals: 6,
        },
        claims: {},
        shifts: { '0': { ...shift }, '1': { ...shift } },
      },
    },
    portfolio: {
      blockNumber: 100,
      nativeBalance: { symbol: 'AVAX', decimals: 18, amount: '0' },
      balances: [],
      aave: { supplies: [], debts: [], healthFactor: null },
      uniswap: { pools: [], positions: [] },
    },
  }
}
