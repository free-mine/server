import { FetchRequest, JsonRpcProvider } from 'ethers'

import { SyncService } from './sync/index.js'
import { loadConfig } from './config/index.js'
import { createServer } from './http/index.js'
import { SnapshotStore } from './snapshot/index.js'
import { TransactionStore } from './storage/index.js'

async function start() {
  const config = await loadConfig()
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

    const refresh = () => {
      void sync
        .refresh()
        .catch(() =>
          app.log.warn(
            'Synchronization failed; previous snapshot retained. See /v1/status.',
          ),
        )
    }
    refresh()
    const timer = setInterval(refresh, config.syncIntervalMs)
    let stopping = false
    const stop = async () => {
      if (stopping) {
        return
      }
      stopping = true
      clearInterval(timer)
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

void start().catch(() => {
  process.stderr.write(
    'Server startup failed. Check configuration, data files and port availability.\n',
  )
  process.exitCode = 1
})
