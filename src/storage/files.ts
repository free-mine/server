import { randomUUID } from 'node:crypto'
import { join, dirname, basename } from 'node:path'
import { rm, open, mkdir, rename, readFile } from 'node:fs/promises'

export async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

export async function atomicWrite(
  path: string,
  data: Uint8Array | string,
): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)

  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(data)
      await file.sync()
    } finally {
      await file.close()
    }

    await rename(temporary, path)

    // Linux containers need the directory entry flushed as well as file contents.
    if (process.platform === 'linux') {
      const parent = await open(directory, 'r')
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}
