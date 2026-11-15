import type { Provider, JsonRpcApiProvider } from 'ethers'

export type RpcProvider = Provider & Pick<JsonRpcApiProvider, 'send'>
