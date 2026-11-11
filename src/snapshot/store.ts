import { join } from 'node:path'
import { promisify } from 'node:util'
import { gzip, gunzip } from 'node:zlib'

import type { PublicSnapshot } from './types.js'
import type { ChainConfig } from '../config/index.js'
import { chainIdentity, snapshotSchema } from './schema.js'
import { atomicWrite, readOptional } from '../storage/index.js'

const compress = promisify(gzip)
const decompress = promisify(gunzip)
const maximumSize = 256 * 1024 * 1024

export async function decodeSnapshot(
  data: Buffer,
  chain: ChainConfig,
): Promise<PublicSnapshot> {
  if (data.length > maximumSize) {
    throw new Error('Backup exceeds 256 MiB')
  }
  const json = await decompress(data, { maxOutputLength: maximumSize })
  const snapshot = snapshotSchema.parse(JSON.parse(json.toString('utf8')))
  if (JSON.stringify(snapshot.chain) !== JSON.stringify(chainIdentity(chain))) {
    throw new Error('Backup belongs to a different chain or deployment')
  }
  return snapshot
}

export class SnapshotStore {
  private current?: PublicSnapshot
  private compressed?: Buffer

  private constructor(
    private readonly path: string,
    private readonly chain: ChainConfig,
  ) {}

  static async open(directory: string, chain: ChainConfig) {
    const store = new SnapshotStore(
      join(directory, 'public-snapshot.json.gz'),
      chain,
    )
    const data = await readOptional(store.path)
    if (data) {
      store.current = await decodeSnapshot(data, chain)
      // Re-encode validated public fields; never serve arbitrary uploaded bytes.
      store.compressed = await compress(JSON.stringify(store.current))
    }
    return store
  }

  get snapshot() {
    return this.current
  }

  get backup() {
    return this.compressed
  }

  async save(value: PublicSnapshot) {
    const snapshot = snapshotSchema.parse(value)
    if (
      JSON.stringify(snapshot.chain) !==
      JSON.stringify(chainIdentity(this.chain))
    ) {
      throw new Error('Snapshot belongs to a different deployment')
    }
    const json = JSON.stringify(snapshot)
    if (Buffer.byteLength(json) > maximumSize) {
      throw new Error('Snapshot exceeds 256 MiB')
    }
    const compressed = await compress(json)
    await atomicWrite(this.path, compressed)
    this.current = snapshot
    this.compressed = compressed
    return snapshot
  }
}
