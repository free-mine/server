import { Contract } from 'ethers'
import type { Provider } from 'ethers'

import { erc20Abi } from './abi.js'
import { readUniswap } from './uniswap.js'
import type { PortfolioState } from './types.js'
import { readAave, tokenBalance } from './aave.js'
import { portfolioStateSchema } from './schema.js'
import type { ChainConfig } from '../config/index.js'

export async function readPortfolio(
  provider: Provider,
  config: ChainConfig,
  blockNumber: number,
): Promise<PortfolioState> {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error('INVALID_PORTFOLIO_BLOCK')
  }
  const [nativeAmount, balances, aave, uniswap] = await Promise.all([
    provider.getBalance(config.addresses.oreVein, blockNumber),
    Promise.all(
      config.tokens.map(async token =>
        tokenBalance(
          token,
          BigInt(
            await new Contract(token.address, erc20Abi, provider).getFunction(
              'balanceOf',
            )(config.addresses.oreVein, { blockTag: blockNumber }),
          ),
        ),
      ),
    ),
    readAave(provider, config, blockNumber),
    readUniswap(provider, config, blockNumber),
  ])
  return portfolioStateSchema.parse({
    blockNumber,
    nativeBalance: {
      symbol: 'AVAX',
      decimals: 18,
      amount: nativeAmount.toString(),
    },
    balances,
    aave,
    uniswap,
  })
}
