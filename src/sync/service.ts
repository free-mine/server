import { readFund } from '../fund/index.js'
import { chainIdentity } from '../snapshot/index.js'
import { readPortfolio } from '../portfolio/index.js'
import type { SyncStatus, SyncOptions } from './types.js'
import type { PublicSnapshot } from '../snapshot/index.js'

// Only messages defined here are safe for public status and server logs.
class SyncStepError extends Error {}

async function step<T>(message: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (cause) {
    throw new SyncStepError(message, { cause })
  }
}

export class SyncService {
  private active?: Promise<PublicSnapshot>
  private statusValue: Omit<SyncStatus, 'running'> = {
    lastAttemptAt: null,
    lastError: null,
  }

  constructor(private readonly options: SyncOptions) {}

  get status(): SyncStatus {
    return { ...this.statusValue, running: Boolean(this.active) }
  }

  // Startup, the timer, and owner requests share one update and one commit.
  refresh(): Promise<PublicSnapshot> {
    if (this.active) {
      return this.active
    }
    this.statusValue = {
      lastAttemptAt: new Date().toISOString(),
      lastError: null,
    }
    this.active = this.update()
      .catch((error: unknown) => {
        // RPC errors may contain credentials from RPC_URL; do not expose them.
        this.statusValue.lastError =
          error instanceof SyncStepError
            ? `${error.message} Previous snapshot retained.`
            : 'Update failed; the previous snapshot is retained.'
        throw error
      })
      .finally(() => {
        this.active = undefined
      })
    return this.active
  }

  async idle() {
    await this.active?.catch(() => undefined)
  }

  private async update(): Promise<PublicSnapshot> {
    const { config, provider, snapshots } = this.options
    const network = await step('RPC network lookup failed.', () =>
      provider.getNetwork(),
    )
    if (network.chainId !== BigInt(config.chain.chainId)) {
      throw new SyncStepError('RPC chain does not match configuration.')
    }
    // Avalanche's latest executed block is accepted/final. Save its hash as
    // well, and reject any incompatible RPC history on every subsequent run.
    const target = await step('Latest block lookup failed.', () =>
      provider.getBlock('latest'),
    )
    if (!target?.hash) {
      throw new SyncStepError('RPC did not return a complete latest block.')
    }
    const previous = snapshots.snapshot
    let fromBlock: number
    if (previous) {
      if (target.number < previous.block.number) {
        throw new SyncStepError('RPC is behind the persisted snapshot.')
      }
      const persistedBlock = await step('Persisted block lookup failed.', () =>
        provider.getBlock(previous.block.number),
      )
      if (persistedBlock?.hash?.toLowerCase() !== previous.block.hash) {
        throw new SyncStepError(
          'Persisted block no longer matches RPC history.',
        )
      }
      fromBlock = previous.block.number + 1
    } else {
      const receipt = await step('Deployment transaction lookup failed.', () =>
        provider.getTransactionReceipt(config.chain.deploymentTx),
      )
      if (
        !receipt ||
        receipt.status !== 1 ||
        receipt.blockNumber > target.number
      ) {
        throw new SyncStepError(
          'Successful deployment transaction was not found.',
        )
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
      throw new SyncStepError(
        'Fund event indexing or contract state read failed. Check RPC event range limits and history access.',
        { cause: fund.reason },
      )
    }
    if (portfolio.status === 'rejected') {
      throw new SyncStepError('Portfolio contract state read failed.', {
        cause: portfolio.reason,
      })
    }
    const verifiedBlock = await step('Target block verification failed.', () =>
      provider.getBlock(target.number),
    )
    if (verifiedBlock?.hash !== target.hash) {
      throw new SyncStepError('Target block changed during update.')
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
    return step('Snapshot validation or persistence failed.', () =>
      snapshots.save(snapshot),
    )
  }
}
