import type { SyncLoopOptions } from './types.js'

export function startSyncLoop(options: SyncLoopOptions) {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  async function run() {
    let delay = options.intervalMs
    try {
      await options.refresh()
    } catch {
      delay = options.retryIntervalMs
      options.onError()
    }
    if (!stopped) {
      timer = setTimeout(() => void run(), delay)
    }
  }

  void run()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
