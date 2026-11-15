import { FetchRequest, JsonRpcProvider } from 'ethers'

import type { ServerConfig } from '../config/index.js'

export function createRpcProvider(config: ServerConfig) {
  const request = new FetchRequest(config.rpcUrl)
  request.timeout = config.rpcTimeoutMs
  return new JsonRpcProvider(request, config.chain.chainId, {
    cacheTimeout: -1,
    batchMaxCount: 20,
    // SyncService checks the actual chain ID once per refresh. Avoid a hidden
    // eth_chainId call for every sequential log batch and contract read.
    staticNetwork: true,
  })
}
