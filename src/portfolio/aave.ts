import type { Provider } from 'ethers'
import { Contract, ZeroAddress } from 'ethers'

import { formatRatio } from './math.js'
import { aaveAbi, erc20Abi } from './abi.js'
import type { TokenBalance, PortfolioState } from './types.js'
import type { ChainConfig, TokenConfig } from '../config/index.js'

export function tokenBalance(token: TokenConfig, amount: bigint): TokenBalance {
  return {
    symbol: token.symbol,
    address: token.address,
    decimals: token.decimals,
    amount: amount.toString(),
  }
}

export async function readAave(
  provider: Provider,
  config: ChainConfig,
  blockNumber: number,
): Promise<PortfolioState['aave']> {
  const pool = new Contract(config.addresses.aavePool, aaveAbi, provider)
  const options = { blockTag: blockNumber }
  const account = await pool.getFunction('getUserAccountData')(
    config.addresses.oreVein,
    options,
  )
  const supplies: PortfolioState['aave']['supplies'] = []
  const debts: PortfolioState['aave']['debts'] = []
  const balance = async (address: string): Promise<bigint> =>
    address.toLowerCase() === ZeroAddress
      ? 0n
      : BigInt(
          await new Contract(address, erc20Abi, provider).getFunction(
            'balanceOf',
          )(config.addresses.oreVein, options),
        )

  for (const token of config.tokens) {
    if (token.aave === undefined) {
      continue
    }
    const reserve = await pool.getFunction('getReserveData')(
      token.address,
      options,
    )
    if (String(reserve.aTokenAddress).toLowerCase() === ZeroAddress) {
      throw new Error(`AAVE_RESERVE_NOT_FOUND:${token.symbol}`)
    }
    if (token.aave === 'supply') {
      // aToken.balanceOf and debtToken.balanceOf apply the current indexes,
      // including accrued interest, at the explicitly selected block.
      supplies.push(
        tokenBalance(token, await balance(String(reserve.aTokenAddress))),
      )
    } else {
      const [variableDebt, stableDebt] = await Promise.all([
        balance(String(reserve.variableDebtTokenAddress)),
        balance(String(reserve.stableDebtTokenAddress)),
      ])
      debts.push({
        ...tokenBalance(token, variableDebt + stableDebt),
        variableDebt: variableDebt.toString(),
        stableDebt: stableDebt.toString(),
      })
    }
  }
  return {
    supplies,
    debts,
    healthFactor:
      BigInt(account.totalDebtBase) === 0n
        ? null
        : formatRatio(BigInt(account.healthFactor), 10n ** 18n),
  }
}
