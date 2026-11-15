import { readFile } from 'node:fs/promises'
import { createHash, timingSafeEqual } from 'node:crypto'

export async function verifyOwnerKey(
  header: string | undefined,
  hashFile: string,
): Promise<boolean> {
  const key = /^Bearer ([\x21-\x7e]+)$/i.exec(header ?? '')?.[1]
  if (!key) {
    return false
  }

  let expected: string
  try {
    expected = (await readFile(hashFile, 'utf8')).trim()
  } catch {
    return false
  }
  if (!/^[a-fA-F0-9]{64}$/.test(expected)) {
    return false
  }

  const actual = createHash('sha256').update(key, 'utf8').digest()
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'))
}
