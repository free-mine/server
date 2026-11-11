import { createHash, randomBytes } from 'node:crypto'

import { settings } from '../config/index.js'
import { atomicWrite } from '../storage/index.js'

const key = randomBytes(32).toString('base64url')
await atomicWrite(
  settings.ownerKeyHashFile,
  `${createHash('sha256').update(key).digest('hex')}\n`,
)
process.stderr.write(
  `SHA-256 hash saved to ${settings.ownerKeyHashFile}. Store the following key on the owner server.\n`,
)
process.stdout.write(`${key}\n`)
