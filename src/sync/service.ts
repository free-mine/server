import { readFund } from '../fund/index.js'
import { chainIdentity } from '../snapshot/index.js'
import { readPortfolio } from '../portfolio/index.js'
import type { SyncStatus, SyncOptions } from './types.js'
import type { PublicSnapshot } from '../snapshot/index.js'

export class SyncService {
  private active?: Promise<PublicSnapshot>
  private statusValue: SyncStatus = {
    running: false,
    lastAttemptAt: null,
    lastError: null,
  }

  constructor(private readonly options: SyncOptions) {}

  get status(): SyncStatus {
    return { ...this.statusValue }
  }

  // Startup, the timer, and owner requests share one update and one commit.
  refresh(): Promise<PublicSnapshot> {
    if (this.active) {
      return this.active
    }
    this.statusValue = {
      running: true,
      lastAttemptAt: new Date().toISOString(),
      lastError: null,
    }
    this.active = this.update()
      .catch((error: unknown) => {
        // RPC errors may contain credentials from RPC_URL; do not expose them.
        this.statusValue.lastError =
          'Update failed; the previous snapshot is retained. Check RPC access, deployment and persisted block hash.'
        throw error
      })
      .finally(() => {
        this.statusValue.running = false
        this.active = undefined
      })
    return this.active
  }

  async idle() {
    await this.active?.catch(() => undefined)
  }

  private async update(): Promise<PublicSnapshot> {
    const { config, provider, snapshots } = this.options
    const network = await provider.getNetwork()
    if (network.chainId !== BigInt(config.chain.chainId)) {
      throw new Error('RPC chain does not match configuration')
    }
    // Avalanche's latest executed block is accepted/final. Save its hash as
    // well, and reject any incompatible RPC history on every subsequent run.
    const target = await provider.getBlock('latest')
    if (!target?.hash) {
      throw new Error('RPC did not return a complete block')
    }
    const previous = snapshots.snapshot
    let fromBlock: number
    if (previous) {
      if (target.number < previous.block.number) {
        throw new Error('RPC is behind the persisted snapshot')
      }
      const persistedBlock = await provider.getBlock(previous.block.number)
      if (persistedBlock?.hash?.toLowerCase() !== previous.block.hash) {
        throw new Error('Persisted block no longer matches RPC history')
      }
      fromBlock = previous.block.number + 1
    } else {
      const receipt = await provider.getTransactionReceipt(
        config.chain.deploymentTx,
      )
      if (
        !receipt ||
        receipt.status !== 1 ||
        receipt.blockNumber > target.number
      ) {
        throw new Error('Successful deployment transaction was not found')
      }
      fromBlock = receipt.blockNumber
    }
    const results = await Promise.allSettled([
      (this.options.readFund ?? readFund)(
        provider,
        config.chain,
        previous?.fund,
        fromBlock,
        target.number,
        config.logBatchSize,
      ),
      (this.options.readPortfolio ?? readPortfolio)(
        provider,
        config.chain,
        target.number,
      ),
    ])
    const [fund, portfolio] = results
    if (fund.status === 'rejected') {
      throw fund.reason
    }
    if (portfolio.status === 'rejected') {
      throw portfolio.reason
    }
    const verifiedBlock = await provider.getBlock(target.number)
    if (verifiedBlock?.hash !== target.hash) {
      throw new Error('Target block changed during update')
    }
    const snapshot: PublicSnapshot = {
      format: 1,
      chain: chainIdentity(config.chain),
      block: {
        number: target.number,
        hash: target.hash.toLowerCase(),
        timestamp: target.timestamp,
      },
      updatedAt: new Date().toISOString(),
      fund: fund.value,
      portfolio: portfolio.value,
    }
    await snapshots.save(snapshot)
    return snapshots.snapshot ?? snapshot
  }
}
