/**
 * Crash-safe persistence for application-owned files.
 *
 * Every write is staged beside its destination, flushed, and renamed. Keeping
 * the temporary file on the same volume is what makes the final replacement
 * atomic on macOS and Windows local filesystems.
 */

import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { copyFile, open, rename, stat, unlink } from 'node:fs/promises';

export type AtomicData = string | Uint8Array;

export interface AtomicWriteOptions {
  /** Optional last-good copy, created before replacing an existing file. */
  backupPath?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function replaceFile(temporary: string, target: string): Promise<void> {
  try {
    await rename(temporary, target);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EBUSY is the usual Windows lock from antivirus, Search indexing, or
    // OneDrive/Dropbox — the whole reason this fallback exists.
    if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || !(await exists(target))) {
      throw error;
    }
  }

  // Windows may refuse rename-over-existing. Move the previous file aside so
  // failure can be rolled back instead of deleting the only good copy.
  const displaced = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.previous`,
  );
  await rename(target, displaced);
  try {
    await rename(temporary, target);
  } catch (error) {
    await rename(displaced, target).catch(() => undefined);
    throw error;
  }
  await unlink(displaced).catch(() => undefined);
}

export async function atomicWriteFile(
  target: string,
  data: AtomicData,
  options: AtomicWriteOptions = {},
): Promise<void> {
  if (options.backupPath && (await exists(target))) {
    await copyFile(target, options.backupPath);
  }

  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await replaceFile(temporary, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function atomicWriteJson(
  target: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await atomicWriteFile(target, `${JSON.stringify(value, null, 2)}\n`, options);
}
