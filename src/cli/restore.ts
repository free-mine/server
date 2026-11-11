import { readFile } from 'node:fs/promises'

import { loadConfig } from '../config/index.js'
import { SnapshotStore, decodeSnapshot } from '../snapshot/index.js'

const source = process.argv[2]
if (!source) {
  throw new Error(
    'Usage: backup:restore -- <backup.json.gz>; stop the server first',
  )
}
const config = await loadConfig()
const store = await SnapshotStore.open(config.dataDir, config.chain)
if (store.snapshot) {
  throw new Error(
    'Data directory already contains a snapshot. Restore into a fresh data directory.',
  )
}
const snapshot = await decodeSnapshot(await readFile(source), config.chain)
await store.save(snapshot)
process.stdout.write(
  `Restored block ${snapshot.block.number}. The next update will verify its hash with RPC.\n`,
)
