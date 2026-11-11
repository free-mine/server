import type { SyncService } from '../sync/index.js'
import type { ServerConfig } from '../config/index.js'
import type { SnapshotStore } from '../snapshot/index.js'
import type { TransactionStore } from '../storage/index.js'

export interface HttpOptions {
  logger?: boolean
  sync: SyncService
  config: ServerConfig
  snapshots: SnapshotStore
  transactions: TransactionStore
}
