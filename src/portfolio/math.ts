import type { FeeGrowthInput } from './types.js'

export const Q96 = 1n << 96n
export const Q128 = 1n << 128n
const Q192 = 1n << 192n
const UINT256 = 1n << 256n

// Decimal display only: truncate, retaining at least 36 significant fractional
// digits even for full-range endpoints. Asset amounts always remain integers.
export function formatRatio(numerator: bigint, denominator: bigint): string {
  if (numerator < 0n || denominator <= 0n) {
    throw new Error('INVALID_PORTFOLIO_RATIO')
  }
  if (numerator === 0n) {
    return '0'
  }
  const decimals = Math.max(
    36,
    denominator.toString().length - numerator.toString().length + 36,
  )
  const scale = 10n ** BigInt(decimals)
  const value = (numerator * scale) / denominator
  const fraction = (value % scale)
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '')
  return `${value / scale}${fraction ? `.${fraction}` : ''}`
}

export function quotePrice(
  sqrtPriceX96: bigint,
  baseIsToken0: boolean,
  baseDecimals: number,
  quoteDecimals: number,
): string {
  if (sqrtPriceX96 <= 0n) {
    throw new Error('UNINITIALIZED_UNISWAP_POOL')
  }
  const square = sqrtPriceX96 * sqrtPriceX96
  const numerator = baseIsToken0 ? square : Q192
  const denominator = baseIsToken0 ? Q192 : square
  return formatRatio(
    numerator * 10n ** BigInt(baseDecimals),
    denominator * 10n ** BigInt(quoteDecimals),
  )
}

// LiquidityAmounts.getAmountsForLiquidity, with the protocol's floor rounding.
export function liquidityAmounts(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  lower: bigint,
  upper: bigint,
): [bigint, bigint] {
  if (liquidity < 0n || lower <= 0n || lower >= upper || sqrtPriceX96 <= 0n) {
    throw new Error('INVALID_UNISWAP_LIQUIDITY')
  }
  const current =
    sqrtPriceX96 < lower ? lower : sqrtPriceX96 > upper ? upper : sqrtPriceX96
  return [
    (liquidity * Q96 * (upper - current)) / upper / current,
    (liquidity * (current - lower)) / Q96,
  ]
}

function uint256(value: bigint): bigint {
  return ((value % UINT256) + UINT256) % UINT256
}

// Fee growth is uint256 and subtraction deliberately wraps in the contracts.
// https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/Tick.sol
export function accruedFees(input: FeeGrowthInput): bigint {
  if (input.liquidity === 0n) {
    return 0n
  }
  const below =
    input.currentTick >= input.lowerTick
      ? input.lowerOutside
      : uint256(input.global - input.lowerOutside)
  const above =
    input.currentTick < input.upperTick
      ? input.upperOutside
      : uint256(input.global - input.upperOutside)
  const inside = uint256(input.global - below - above)
  return (uint256(inside - input.lastInside) * input.liquidity) / Q128
}
