import type { Provider, Interface } from 'ethers'

import { applyEvents } from './events.js'
import { fundStateSchema } from './schema.js'
import type { ChainConfig } from '../config/index.js'
import type { FundShift, FundState, EventState } from './types.js'
import { dollarAbi, oreVeinAbi, freeMineAbi, magicOreAbi } from './abi.js'

export async function readFund(
  provider: Provider,
  config: ChainConfig,
  previous: FundState | undefined,
  fromBlock: number,
  toBlock: number,
  logBatchSize: number,
): Promise<FundState> {
  if (
    !Number.isSafeInteger(fromBlock) ||
    !Number.isSafeInteger(toBlock) ||
    fromBlock < 0 ||
    toBlock < 0 ||
    fromBlock > toBlock + 1 ||
    !Number.isSafeInteger(logBatchSize) ||
    logBatchSize < 1
  ) {
    throw new Error('Invalid fund indexing block range or log batch size')
  }
  if (previous) {
    fundStateSchema.parse(previous)
  }
  const events: EventState = {
    admins: new Set(previous?.oreVein.admins ?? []),
    holders: { ...previous?.magicOre.holders },
    successors: { ...previous?.oreVein.successors },
    claims: structuredClone(previous?.freeMine.claims ?? {}),
  }
  await applyEvents(provider, config, events, fromBlock, toBlock, logBatchSize)

  const read = async (
    address: string,
    abi: Interface,
    method: string,
    args: readonly unknown[] = [],
  ) =>
    abi.decodeFunctionResult(
      method,
      await provider.call({
        to: address,
        data: abi.encodeFunctionData(method, args),
        blockTag: toBlock,
      }),
    )
  const scalar = async (address: string, abi: Interface, method: string) =>
    String((await read(address, abi, method))[0])
  const addressValue = async (
    address: string,
    abi: Interface,
    method: string,
  ) => (await scalar(address, abi, method)).toLowerCase()

  const { magicOre, freeMine, oreVein } = config.addresses
  const [
    name,
    symbol,
    decimals,
    totalSupply,
    magicOreOwner,
    oreVeinOwner,
    pendingOwner,
    contractURI,
    linkedFreeMine,
    freeMineOwner,
    linkedMagicOre,
    dollar,
    entryPrice,
    priceUpdatedAt,
    currentShiftId,
  ] = await Promise.all([
    scalar(magicOre, magicOreAbi, 'name'),
    scalar(magicOre, magicOreAbi, 'symbol'),
    scalar(magicOre, magicOreAbi, 'decimals'),
    scalar(magicOre, magicOreAbi, 'totalSupply'),
    addressValue(magicOre, magicOreAbi, 'owner'),
    addressValue(oreVein, oreVeinAbi, 'owner'),
    addressValue(oreVein, oreVeinAbi, 'pendingOwner'),
    scalar(oreVein, oreVeinAbi, 'contractURI'),
    addressValue(oreVein, oreVeinAbi, 'freeMine'),
    addressValue(freeMine, freeMineAbi, 'owner'),
    addressValue(freeMine, freeMineAbi, 'magicOre'),
    addressValue(freeMine, freeMineAbi, 'dollar'),
    scalar(freeMine, freeMineAbi, 'entryPrice'),
    scalar(freeMine, freeMineAbi, 'priceUpdatedAt'),
    scalar(freeMine, freeMineAbi, 'currentShiftId'),
  ])
  if (
    linkedFreeMine !== freeMine.toLowerCase() ||
    linkedMagicOre !== magicOre.toLowerCase()
  ) {
    throw new Error(
      'Configured fund addresses do not match contract references',
    )
  }
  if (BigInt(currentShiftId) < 1n) {
    throw new Error('The current shift identifier must be positive')
  }
  const dollarDecimals = Number(await scalar(dollar, dollarAbi, 'decimals'))
  const shiftIds = new Set([
    currentShiftId,
    (BigInt(currentShiftId) - 1n).toString(),
    ...Object.values(events.claims).map(claim => claim.shiftId),
  ])
  const shifts: Record<string, FundShift> = {}
  // Sequential calls keep the number of in-flight requests bounded even if
  // many old shifts still contain active claims.
  for (const shiftId of shiftIds) {
    const result = await read(freeMine, freeMineAbi, 'shifts', [shiftId])
    shifts[shiftId] = {
      funded: Boolean(result.funded),
      price: String(result.price),
      dollar: String(result.dollar).toLowerCase(),
      fundedAt: String(result.fundedAt),
      oreAmount: String(result.oreAmount),
      dollarScale: String(result.dollarScale),
      currentClaimId: String(result.currentClaimId),
    }
  }

  return fundStateSchema.parse({
    magicOre: {
      name,
      symbol,
      decimals: Number(decimals),
      totalSupply,
      owner: magicOreOwner,
      holders: events.holders,
    },
    oreVein: {
      owner: oreVeinOwner,
      pendingOwner,
      contractURI,
      freeMine: linkedFreeMine,
      admins: [...events.admins].sort(),
      successors: events.successors,
    },
    freeMine: {
      owner: freeMineOwner,
      magicOre: linkedMagicOre,
      dollar: { address: dollar, decimals: dollarDecimals },
      entryPrice,
      priceUpdatedAt,
      currentShiftId,
      claims: events.claims,
      shifts,
    },
  })
}
