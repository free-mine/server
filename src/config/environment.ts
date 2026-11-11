import { settings } from './constants.js'
import type { ServerConfig } from './types.js'

export class RpcConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RpcConfigurationError'
  }
}

export function loadConfig(rpcUrl = process.env.RPC_URL): ServerConfig {
  const value = rpcUrl?.trim()
  if (!value) {
    throw new RpcConfigurationError('RPC_URL is required')
  }
  if (
    !URL.canParse(value) ||
    !['http:', 'https:'].includes(new URL(value).protocol)
  ) {
    throw new RpcConfigurationError('RPC_URL must be a valid HTTP or HTTPS URL')
  }
  return { ...settings, rpcUrl: value }
}
