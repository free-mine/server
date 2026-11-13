import { ZeroAddress } from 'ethers'
import type { Provider } from 'ethers'

import { fetchLogBatches } from './logs.js'
import type { EventState } from './types.js'
import type { ChainConfig } from '../config/index.js'
import { oreVeinAbi, freeMineAbi, magicOreAbi } from './abi.js'

function transfer(state: EventState, from: string, to: string, value: bigint) {
  if (value === 0n) {
    return
  }
  if (from !== ZeroAddress) {
    const balance = BigInt(state.holders[from] ?? '0') - value
    if (balance < 0n) {
      throw new Error(`MagicOre transfer exceeds indexed balance of ${from}`)
    }
    if (balance === 0n) {
      delete state.holders[from]
    } else {
      state.holders[from] = balance.toString()
    }
  }
  if (to !== ZeroAddress) {
    state.holders[to] = (BigInt(state.holders[to] ?? '0') + value).toString()
  }
}

export async function applyEvents(
  provider: Provider,
  config: ChainConfig,
  state: EventState,
  fromBlock: number,
  toBlock: number,
  logBatchSize: number,
) {
  const magicOre = config.addresses.magicOre.toLowerCase()
  const freeMine = config.addresses.freeMine.toLowerCase()
  const oreVein = config.addresses.oreVein.toLowerCase()
  for await (const batch of fetchLogBatches(
    provider,
    [magicOre, freeMine, oreVein],
    fromBlock,
    toBlock,
    logBatchSize,
  )) {
    const { logs } = batch
    logs.sort(
      (left, right) =>
        left.blockNumber - right.blockNumber ||
        left.transactionIndex - right.transactionIndex ||
        left.index - right.index,
    )
    for (const log of logs) {
      if (
        log.removed ||
        log.blockNumber < batch.fromBlock ||
        log.blockNumber > batch.toBlock
      ) {
        throw new Error('RPC returned an invalid or removed fund event')
      }
      const address = log.address.toLowerCase()
      const abi =
        address === magicOre
          ? magicOreAbi
          : address === freeMine
            ? freeMineAbi
            : address === oreVein
              ? oreVeinAbi
              : undefined
      if (!abi) {
        throw new Error('RPC returned a log from an unexpected contract')
      }
      const event = abi.parseLog(log)
      if (!event) {
        continue
      }
      const args = event.args
      switch (event.name) {
        case 'Transfer':
          transfer(
            state,
            String(args.from).toLowerCase(),
            String(args.to).toLowerCase(),
            BigInt(args.value),
          )
          break
        case 'ClaimOpened': {
          const shiftId = String(args.shiftId)
          const claimId = String(args.claimId)
          const key = `${shiftId}:${claimId}`
          if (state.claims[key]) {
            throw new Error(`Duplicate open claim ${key}`)
          }
          state.claims[key] = {
            shiftId,
            claimId,
            miner: String(args.miner).toLowerCase(),
            oreAmount: String(args.oreAmount),
          }
          break
        }
        case 'ClaimClosed': {
          const key = `${args.shiftId}:${args.claimId}`
          if (state.claims[key]?.miner !== String(args.miner).toLowerCase()) {
            throw new Error(`Cannot close unknown or mismatched claim ${key}`)
          }
          delete state.claims[key]
          break
        }
        case 'SuccessorScheduled': {
          const successor = String(args.successor).toLowerCase()
          if (
            (state.successors[successor] ?? '0') !==
            String(args.previousClaimableAt)
          ) {
            throw new Error(`Mismatched previous schedule for ${successor}`)
          }
          state.successors[successor] = String(args.claimableAt)
          break
        }
        case 'SuccessorRemoved': {
          const successor = String(args.successor).toLowerCase()
          if (state.successors[successor] !== String(args.claimableAt)) {
            throw new Error(`Cannot remove unknown schedule for ${successor}`)
          }
          delete state.successors[successor]
          break
        }
        case 'AdminActivated': {
          const admin = String(args.admin).toLowerCase()
          if (
            state.admins.has(admin) ||
            state.successors[admin] !== String(args.claimableAt)
          ) {
            throw new Error(
              `Cannot activate unscheduled administrator ${admin}`,
            )
          }
          delete state.successors[admin]
          state.admins.add(admin)
          break
        }
        case 'AdminRemoved': {
          const admin = String(args.admin).toLowerCase()
          if (!state.admins.delete(admin)) {
            throw new Error(`Cannot remove unknown administrator ${admin}`)
          }
          break
        }
      }
    }
  }
}
