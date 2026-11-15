import { join } from 'node:path'
import { promisify } from 'node:util'
import { gzip, gunzip } from 'node:zlib'

import { parseSnapshot } from './schema.js'
import type { ChainConfig } from '../config/index.js'
import { atomicWrite, readOptional } from '../storage/index.js'
import type { PublicSnapshot, StoredSnapshot } from './types.js'

const compress = promisify(gzip)
const decompress = promisify(gunzip)
const maximumSize = 256 * 1024 * 1024
export const snapshotFileName = 'public-snapshot.json.gz'

export async function decodeSnapshot(
  data: Buffer,
  chain: ChainConfig,
): Promise<PublicSnapshot> {
  if (data.length > maximumSize) {
    throw new Error('Backup exceeds 256 MiB')
  }
  const json = await decompress(data, { maxOutputLength: maximumSize })
  return parseSnapshot(JSON.parse(json.toString('utf8')), chain)
}

export class SnapshotStore {
  private current?: StoredSnapshot

  private constructor(
    private readonly path: string,
    private readonly chain: ChainConfig,
  ) {}

  static async open(directory: string, chain: ChainConfig) {
    const store = new SnapshotStore(join(directory, snapshotFileName), chain)
    const data =
      (await readOptional(store.path)) ??
      (await readOptional(join(directory, 'free-mine-backup.json.gz')))
    if (data) {
      const snapshot = await decodeSnapshot(data, chain)
      // Re-encode validated public fields; never serve arbitrary uploaded bytes.
      const backup = await compress(JSON.stringify(snapshot))
      store.current = { snapshot, backup }
    }
    return store
  }

  get snapshot() {
    return this.current?.snapshot
  }

  get backup() {
    return this.current?.backup
  }

  async save(value: PublicSnapshot) {
    const snapshot = parseSnapshot(value, this.chain)
    const json = JSON.stringify(snapshot)
    if (Buffer.byteLength(json) > maximumSize) {
      throw new Error('Snapshot exceeds 256 MiB')
    }
    const backup = await compress(json)
    await atomicWrite(this.path, backup)
    this.current = { snapshot, backup }
    return snapshot
  }
}
