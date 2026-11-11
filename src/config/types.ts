export interface TokenConfig {
  symbol: string
  address: string
  decimals: number
  aave?: 'supply' | 'borrow'
}

export interface PairConfig {
  fee: number
  baseSymbol: string
  quoteSymbol: string
}

export interface ChainConfig {
  chainId: 43114
  pairs: PairConfig[]
  deploymentTx: string
  tokens: TokenConfig[]
  addresses: {
    oreVein: string
    magicOre: string
    freeMine: string
    aavePool: string
    uniswapFactory: string
    uniswapPositionManager: string
  }
}

export interface ServerConfig {
  host: string
  port: number
  rpcUrl: string
  dataDir: string
  chain: ChainConfig
  logBatchSize: number
  rpcTimeoutMs: number
  syncIntervalMs: number
  ownerKeyHashFile: string
}
