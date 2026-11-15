import { createServer } from './http/index.js'
import { createRpcProvider } from './rpc/index.js'
import { TransactionStore } from './storage/index.js'
import { SyncService, startSyncLoop } from './sync/index.js'
import { SnapshotStore, snapshotFileName } from './snapshot/index.js'
import { loadConfig, RpcConfigurationError } from './config/index.js'

async function start() {
  const config = loadConfig()
  const provider = createRpcProvider(config)

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

    if (snapshots.snapshot) {
      app.log.info(
        {
          dataDir: config.dataDir,
          block: snapshots.snapshot.block.number,
          blockTimestamp: snapshots.snapshot.block.timestamp,
          updatedAt: snapshots.snapshot.updatedAt,
        },
        'Restored public snapshot',
      )
    } else {
      app.log.warn(
        { dataDir: config.dataDir, filename: snapshotFileName },
        'No public snapshot found; indexing full history from deployment',
      )
    }

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
      try {
        await app.close()
      } finally {
        // Stop RPC replay before waiting; initial indexing may take hours.
        provider.destroy()
        await sync.idle()
      }
    }
    const onSignal = () => {
      void stop().catch(() => {
        app.log.error('Server shutdown failed')
        process.exitCode = 1
      })
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
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
