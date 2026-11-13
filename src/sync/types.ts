import type { Provider } from 'ethers'

import type { readFund } from '../fund/index.js'
import type { ServerConfig } from '../config/index.js'
import type { SnapshotStore } from '../snapshot/index.js'
import type { readPortfolio } from '../portfolio/index.js'

export interface SyncOptions {
  provider: Provider
  config: ServerConfig
  snapshots: SnapshotStore
  readFund?: typeof readFund
  readPortfolio?: typeof readPortfolio
}

export interface SyncStatus {
  running: boolean
  lastError: string | null
  lastAttemptAt: string | null
}

export interface SyncLoopOptions {
  intervalMs: number
  onError: () => void
  retryIntervalMs: number
  refresh: () => Promise<unknown>
}
