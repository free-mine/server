import { FetchRequest, JsonRpcProvider } from 'ethers'

import { createServer } from './http/index.js'
import { SnapshotStore } from './snapshot/index.js'
import { TransactionStore } from './storage/index.js'
import { SyncService, startSyncLoop } from './sync/index.js'
import { loadConfig, RpcConfigurationError } from './config/index.js'

async function start() {
  const config = loadConfig()
  const request = new FetchRequest(config.rpcUrl)
  request.timeout = config.rpcTimeoutMs
  const provider = new JsonRpcProvider(request, undefined, {
    cacheTimeout: -1,
    batchMaxCount: 20,
  })

  try {
    const snapshots = await SnapshotStore.open(config.dataDir, config.chain)
    const transactions = await TransactionStore.open(config.dataDir)
    const sync = new SyncService({ config, provider, snapshots })
    const app = createServer({
      config,
      snapshots,
      transactions,
      sync,
      logger: true,
    })
    await app.listen({ port: config.port, host: config.host })

    const stopSyncLoop = startSyncLoop({
      refresh: () => sync.refresh(),
      onError: () => app.log.warn(sync.status.lastError),
      intervalMs: config.syncIntervalMs,
      retryIntervalMs: config.syncRetryIntervalMs,
    })
    let stopping = false
    const stop = async () => {
      if (stopping) {
        return
      }
      stopping = true
      stopSyncLoop()
      await app.close()
      await sync.idle()
      provider.destroy()
    }
    process.once('SIGINT', () => void stop())
    process.once('SIGTERM', () => void stop())
  } catch (error) {
    provider.destroy()
    throw error
  }
}

void start().catch((error: unknown) => {
  const message =
    error instanceof RpcConfigurationError
      ? error.message
      : 'Server startup failed. Check data files and port availability.'
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
