import { resolve } from 'node:path'

import type { ChainConfig, ServerConfig } from './types.js'

export const defaultChain: ChainConfig = {
  chainId: 43114,
  deploymentTx:
    '0x55f4fc48647fc41b96fb52125d11427473c215d76bac672b261f159c3f46d42d',
  addresses: {
    magicOre: '0xFB58D4B7c4c9f834a7211B5ae0e636cBd1b2fEac',
    freeMine: '0x5A2bA936848220F0cb7a4C3b961612674C135168',
    oreVein: '0xe757a8b1d003BC8704dE110C8458b5358dB12070',
    aavePool: '0x794a61358d6845594f94dc1db02a252b5b4814ad',
    uniswapFactory: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD',
    uniswapPositionManager: '0x655C406EBFa14EE2006250925e54ec43AD184f8B',
  },
  tokens: [
    {
      symbol: 'WAVAX',
      address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
      decimals: 18,
      aave: 'supply',
    },
    {
      symbol: 'BTC.b',
      address: '0x152b9d0FdC40C096757F570A51E494bd4b943E50',
      decimals: 8,
      aave: 'supply',
    },
    {
      symbol: 'USDT',
      address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
      decimals: 6,
      aave: 'borrow',
    },
    {
      symbol: 'USDC',
      address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      decimals: 6,
      aave: 'borrow',
    },
  ],
  pairs: [
    { baseSymbol: 'WAVAX', quoteSymbol: 'USDC', fee: 500 },
    { baseSymbol: 'BTC.b', quoteSymbol: 'USDC', fee: 500 },
  ],
}

export const settings: Omit<ServerConfig, 'rpcUrl'> = {
  chain: defaultChain,
  host: '0.0.0.0',
  port: 3000,
  dataDir: resolve('data'),
  ownerKeyHashFile: resolve('data/owner-key.sha256'),
  syncIntervalMs: 600_000,
  syncRetryIntervalMs: 60_000,
  logBatchSize: 10,
  rpcTimeoutMs: 30_000,
}
