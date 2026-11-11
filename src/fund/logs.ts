import { setTimeout } from 'node:timers/promises'

import type { Log, Provider } from 'ethers'

import type { RetryDelay } from './types.js'

// Ethers wraps HTTP status and JSON-RPC messages at different nesting levels.
// Inspect only error fields; never log the request or its credential-bearing URL.
function errorText(error: unknown, depth = 0): string {
  if (typeof error === 'string') {
    return error
  }
  if (!error || typeof error !== 'object' || depth > 3) {
    return ''
  }
  const fields = error as Record<string, unknown>
  const messages = [
    'message',
    'shortMessage',
    'code',
    'status',
    'statusCode',
    'responseStatus',
    'responseBody',
  ].map(key => {
    const value = fields[key]
    return typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : ''
  })
  for (const key of ['error', 'info', 'response', 'cause']) {
    messages.push(errorText(fields[key], depth + 1))
  }
  return messages.join(' ')
}

function failureKind(error: unknown) {
  const message = errorText(error)
  if (/\b40[13]\b|invalid api.?key|unauthorized|forbidden/i.test(message)) {
    return 'permanent'
  }
  if (
    /\b429\b|\b50[234]\b|\b599\b|rate.?limit|too many requests|exceeded maximum retry limit|timeout|timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|NETWORK_ERROR|temporarily unavailable/i.test(
      message,
    )
  ) {
    return 'transient'
  }
  if (
    /range.{0,40}(?:too large|too wide|exceed|limit)|too many blocks|query returned more than|response size|result(?:s| set)? (?:size|limit|too large)|(?:limit|maximum).{0,40}(?:range|logs|blocks)/i.test(
      message,
    )
  ) {
    return 'range'
  }
  return 'permanent'
}

export async function fetchRange(
  provider: Provider,
  addresses: string[],
  fromBlock: number,
  toBlock: number,
  delay: RetryDelay = setTimeout,
): Promise<Log[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.getLogs({ address: addresses, fromBlock, toBlock })
    } catch (error) {
      const kind = failureKind(error)
      if (kind === 'transient' && attempt < 3) {
        await delay(1000 * 2 ** attempt)
        continue
      }
      if (kind !== 'range' || fromBlock === toBlock) {
        throw error
      }
      const middle = fromBlock + Math.floor((toBlock - fromBlock) / 2)
      const first = await fetchRange(
        provider,
        addresses,
        fromBlock,
        middle,
        delay,
      )
      const second = await fetchRange(
        provider,
        addresses,
        middle + 1,
        toBlock,
        delay,
      )
      return [...first, ...second]
    }
  }
}
