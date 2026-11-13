import { setTimeout } from 'node:timers/promises'

import type { Provider } from 'ethers'

import type { LogBatch, RetryDelay } from './types.js'

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
    /range.{0,40}(?:too large|too wide|exceed|limit)|too many blocks|query returned more than|response size|result(?:s| set)? (?:size|limit|too large)|(?:limit|maximum).{0,40}(?:range|logs|blocks)|up to (?:a )?[\d,]+ blocks? range/i.test(
      message,
    )
  ) {
    return 'range'
  }
  return 'permanent'
}

function smallerRange(error: unknown, currentSize: number): number {
  const message = errorText(error)
  const advertised =
    /up to (?:a )?([\d,]+) blocks? range/i.exec(message) ??
    /maximum of ([\d,]+) blocks?\b/i.exec(message)
  const limit = Number(advertised?.[1]?.replaceAll(',', ''))
  return Number.isSafeInteger(limit) && limit > 0 && limit < currentSize
    ? limit
    : Math.max(1, Math.floor(currentSize / 2))
}

export async function* fetchLogBatches(
  provider: Provider,
  addresses: string[],
  fromBlock: number,
  toBlock: number,
  batchSize: number,
  delay: RetryDelay = setTimeout,
): AsyncGenerator<LogBatch> {
  let start = fromBlock
  let rangeSize = batchSize
  let retries = 0
  while (start <= toBlock) {
    const end = Math.min(start + rangeSize - 1, toBlock)
    let logs
    try {
      logs = await provider.getLogs({
        address: addresses,
        fromBlock: start,
        toBlock: end,
      })
    } catch (error) {
      const kind = failureKind(error)
      if (kind === 'transient' && retries < 3) {
        await delay(1000 * 2 ** retries++)
        continue
      }
      if (kind !== 'range' || start === end) {
        throw error
      }
      // Keep the learned limit for all following batches in this replay.
      rangeSize = smallerRange(error, end - start + 1)
      retries = 0
      continue
    }
    yield { logs, fromBlock: start, toBlock: end }
    start = end + 1
    retries = 0
  }
}
