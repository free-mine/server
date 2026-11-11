import type { Provider } from 'ethers'
import { Contract, ZeroAddress } from 'ethers'

import type { ChainConfig } from '../config/index.js'
import { poolAbi, factoryAbi, positionManagerAbi } from './abi.js'
import { MIN_TICK, MAX_TICK, sqrtRatioAtTick } from './tick-math.js'
import { quotePrice, accruedFees, liquidityAmounts } from './math.js'
import type { PoolSnapshot, PortfolioState, UniswapPosition } from './types.js'

const sameAddress = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase()

function orient(amount0: bigint, amount1: bigint, baseIsToken0: boolean) {
  return {
    base: (baseIsToken0 ? amount0 : amount1).toString(),
    quote: (baseIsToken0 ? amount1 : amount0).toString(),
  }
}

async function readPools(
  provider: Provider,
  config: ChainConfig,
  blockNumber: number,
) {
  const factory = new Contract(
    config.addresses.uniswapFactory,
    factoryAbi,
    provider,
  )
  const options = { blockTag: blockNumber }
  const pools: PortfolioState['uniswap']['pools'] = []
  const snapshots: PoolSnapshot[] = []
  for (const pair of config.pairs) {
    const base = config.tokens.find(token => token.symbol === pair.baseSymbol)
    const quote = config.tokens.find(token => token.symbol === pair.quoteSymbol)
    if (!base || !quote || sameAddress(base.address, quote.address)) {
      throw new Error('INVALID_UNISWAP_PAIR')
    }
    const address = String(
      await factory.getFunction('getPool')(
        base.address,
        quote.address,
        pair.fee,
        options,
      ),
    )
    const view: PortfolioState['uniswap']['pools'][number] = {
      baseSymbol: base.symbol,
      quoteSymbol: quote.symbol,
      fee: pair.fee,
      address: sameAddress(address, ZeroAddress) ? null : address,
      price: null,
    }
    pools.push(view)
    if (view.address === null) {
      continue
    }
    const contract = new Contract(address, poolAbi, provider)
    const [token0, token1, slot, spacing] = await Promise.all([
      contract.getFunction('token0')(options),
      contract.getFunction('token1')(options),
      contract.getFunction('slot0')(options),
      contract.getFunction('tickSpacing')(options),
    ])
    const baseIsToken0 = sameAddress(String(token0), base.address)
    if (
      !sameAddress(
        String(token0),
        baseIsToken0 ? base.address : quote.address,
      ) ||
      !sameAddress(String(token1), baseIsToken0 ? quote.address : base.address)
    ) {
      throw new Error('UNISWAP_POOL_TOKEN_MISMATCH')
    }
    const tickSpacing = Number(spacing)
    if (
      !Number.isInteger(tickSpacing) ||
      tickSpacing <= 0 ||
      tickSpacing > MAX_TICK
    ) {
      throw new Error('INVALID_UNISWAP_TICK_SPACING')
    }
    const sqrtPriceX96 = BigInt(slot.sqrtPriceX96)
    if (sqrtPriceX96 === 0n) {
      continue
    }
    const [feeGrowth0, feeGrowth1] = await Promise.all([
      contract.getFunction('feeGrowthGlobal0X128')(options),
      contract.getFunction('feeGrowthGlobal1X128')(options),
    ])
    view.price = quotePrice(
      sqrtPriceX96,
      baseIsToken0,
      base.decimals,
      quote.decimals,
    )
    snapshots.push({
      tick: Number(slot.tick),
      address,
      contract,
      base,
      quote,
      config: pair,
      tickSpacing,
      baseIsToken0,
      sqrtPriceX96,
      feeGrowth0: BigInt(feeGrowth0),
      feeGrowth1: BigInt(feeGrowth1),
    })
  }
  return { pools, snapshots }
}

export async function readUniswap(
  provider: Provider,
  config: ChainConfig,
  blockNumber: number,
): Promise<PortfolioState['uniswap']> {
  const options = { blockTag: blockNumber }
  const manager = new Contract(
    config.addresses.uniswapPositionManager,
    positionManagerAbi,
    provider,
  )
  const factory = String(await manager.getFunction('factory')(options))
  if (!sameAddress(factory, config.addresses.uniswapFactory)) {
    throw new Error('UNISWAP_FACTORY_MISMATCH')
  }
  const { pools, snapshots } = await readPools(provider, config, blockNumber)
  const count = BigInt(
    await manager.getFunction('balanceOf')(config.addresses.oreVein, options),
  )
  const positions: UniswapPosition[] = []
  for (let index = 0n; index < count; index++) {
    const tokenId = BigInt(
      await manager.getFunction('tokenOfOwnerByIndex')(
        config.addresses.oreVein,
        index,
        options,
      ),
    )
    const [position, owner] = await Promise.all([
      manager.getFunction('positions')(tokenId, options),
      manager.getFunction('ownerOf')(tokenId, options),
    ])
    if (!sameAddress(String(owner), config.addresses.oreVein)) {
      throw new Error('UNISWAP_POSITION_OWNER_MISMATCH')
    }
    const pool = snapshots.find(
      value =>
        Number(position.fee) === value.config.fee &&
        sameAddress(
          String(position.token0),
          value.baseIsToken0 ? value.base.address : value.quote.address,
        ) &&
        sameAddress(
          String(position.token1),
          value.baseIsToken0 ? value.quote.address : value.base.address,
        ),
    )
    if (!pool) {
      continue
    }
    const lowerTick = Number(position.tickLower)
    const upperTick = Number(position.tickUpper)
    if (
      lowerTick >= upperTick ||
      lowerTick % pool.tickSpacing !== 0 ||
      upperTick % pool.tickSpacing !== 0
    ) {
      throw new Error('INVALID_UNISWAP_POSITION_RANGE')
    }
    const lower = sqrtRatioAtTick(lowerTick)
    const upper = sqrtRatioAtTick(upperTick)
    const liquidity = BigInt(position.liquidity)
    const [amount0, amount1] = liquidityAmounts(
      liquidity,
      pool.sqrtPriceX96,
      lower,
      upper,
    )
    const [lowerState, upperState] = await Promise.all([
      pool.contract.getFunction('ticks')(lowerTick, options),
      pool.contract.getFunction('ticks')(upperTick, options),
    ])
    const bounds = {
      liquidity,
      currentTick: pool.tick,
      lowerTick,
      upperTick,
    }
    const fees0 = accruedFees({
      ...bounds,
      global: pool.feeGrowth0,
      lastInside: BigInt(position.feeGrowthInside0LastX128),
      lowerOutside: BigInt(lowerState.feeGrowthOutside0X128),
      upperOutside: BigInt(upperState.feeGrowthOutside0X128),
    })
    const fees1 = accruedFees({
      ...bounds,
      global: pool.feeGrowth1,
      lastInside: BigInt(position.feeGrowthInside1LastX128),
      lowerOutside: BigInt(lowerState.feeGrowthOutside1X128),
      upperOutside: BigInt(upperState.feeGrowthOutside1X128),
    })
    const stored0 = BigInt(position.tokensOwed0)
    const stored1 = BigInt(position.tokensOwed1)
    // Avoid publishing amounts larger than the NPM can account for as uint128.
    if (stored0 + fees0 >= 1n << 128n || stored1 + fees1 >= 1n << 128n) {
      throw new Error('UNISWAP_OWED_OVERFLOW')
    }
    const price = (sqrt: bigint) =>
      quotePrice(
        sqrt,
        pool.baseIsToken0,
        pool.base.decimals,
        pool.quote.decimals,
      )
    positions.push({
      tokenId: tokenId.toString(),
      pool: pool.address,
      baseSymbol: pool.base.symbol,
      quoteSymbol: pool.quote.symbol,
      fee: pool.config.fee,
      liquidity: liquidity.toString(),
      range: {
        lowerPrice: price(pool.baseIsToken0 ? lower : upper),
        upperPrice: price(pool.baseIsToken0 ? upper : lower),
        fullRange:
          lowerTick ===
            Math.ceil(MIN_TICK / pool.tickSpacing) * pool.tickSpacing &&
          upperTick ===
            Math.floor(MAX_TICK / pool.tickSpacing) * pool.tickSpacing,
      },
      inRange:
        liquidity > 0n && pool.tick >= lowerTick && pool.tick < upperTick,
      price: price(pool.sqrtPriceX96),
      amounts: orient(amount0, amount1, pool.baseIsToken0),
      newlyAccruedFees: orient(fees0, fees1, pool.baseIsToken0),
      storedOwed: orient(stored0, stored1, pool.baseIsToken0),
      totalCollectable: orient(
        stored0 + fees0,
        stored1 + fees1,
        pool.baseIsToken0,
      ),
    })
  }
  return { pools, positions }
}
