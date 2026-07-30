/**
 * Fetching catalog releases.
 *
 * Uses Node's own `https`, so the application keeps its zero-dependency
 * runtime. Downloads resume where they stopped: a catalog is tens of megabytes
 * and a laptop closed at a venue should not mean starting again on the way
 * home.
 *
 * Nothing here decides whether a download is trustworthy. It produces bytes;
 * `install.ts` verifies them against the hash in the signed manifest before
 * anything is written. Keeping the two apart means a bug in transfer handling
 * cannot become a bug in trust.
 */

import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { get as httpsGet } from 'node:https';
import type { IncomingMessage } from 'node:http';

export interface DownloadProgress {
  received: number;
  total: number;
  /** True while resuming a part-finished file. */
  resumed: boolean;
}

export interface DownloadOptions {
  url: string;
  /** Where the partial file lives between attempts. */
  target: string;
  expectedBytes?: number;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  /** Redirect budget. GitHub releases redirect to object storage. */
  maxRedirects?: number;
}

export interface DownloadResult {
  ok: boolean;
  bytes?: Uint8Array;
  reason?: string;
  /** True when the transfer picked up from a previous attempt. */
  resumed?: boolean;
}

/** Follows redirects and returns the response that carries a body. */
function request(url: string, headers: Record<string, string>, redirects: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (redirects < 0) return reject(new Error('too many redirects'));

    httpsGet(url, { headers }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;

      if (status >= 300 && status < 400 && location) {
        response.resume();
        const next = new URL(location, url).toString();
        // Range headers are dropped across a redirect: the new host may not
        // honour them, and a silently ignored Range yields a file that looks
        // resumed but starts from zero.
        request(next, { ...headers }, redirects - 1).then(resolve, reject);
        return;
      }

      if (status !== 200 && status !== 206) {
        response.resume();
        return reject(new Error(`the server replied ${status}`));
      }

      resolve(response);
    }).on('error', reject);
  });
}

/**
 * Downloads a release package, resuming a partial file when one exists.
 *
 * A server that ignores `Range` answers 200 rather than 206; that is detected
 * and the partial file discarded, because appending a whole file to a partial
 * one produces bytes that fail their hash in a way that is tedious to diagnose.
 */
export async function downloadPackage(options: DownloadOptions): Promise<DownloadResult> {
  const { url, target, expectedBytes, onProgress, signal } = options;

  await mkdir(dirname(target), { recursive: true });

  let start = 0;
  if (existsSync(target)) {
    const size = statSync(target).size;
    // A partial file already the expected size is either complete or wrong;
    // either way the hash check decides, so read it rather than re-fetch.
    if (expectedBytes && size >= expectedBytes) {
      return { ok: true, bytes: await readFile(target), resumed: true };
    }
    start = size;
  }

  const headers: Record<string, string> = { 'user-agent': 'Groundplan' };
  if (start > 0) headers.range = `bytes=${start}-`;

  let response: IncomingMessage;
  try {
    response = await request(url, headers, options.maxRedirects ?? 5);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  // The server ignored our Range, so anything already on disk is not a prefix
  // of what is arriving.
  const resuming = start > 0 && response.statusCode === 206;
  if (start > 0 && !resuming) {
    await rm(target, { force: true });
    start = 0;
  }

  const total =
    expectedBytes ??
    start + Number.parseInt(String(response.headers['content-length'] ?? '0'), 10);

  return new Promise<DownloadResult>((resolve) => {
    const file = createWriteStream(target, { flags: resuming ? 'a' : 'w' });
    let received = start;
    let settled = false;

    const finish = (result: DownloadResult): void => {
      if (settled) return;
      settled = true;
      file.close(() => resolve(result));
    };

    const abort = (): void => {
      response.destroy();
      // The partial file is kept on purpose: the next attempt resumes from it.
      finish({ ok: false, reason: 'the download was cancelled' });
    };
    signal?.addEventListener('abort', abort, { once: true });

    response.on('data', (chunk: Buffer) => {
      received += chunk.length;
      onProgress?.({ received, total, resumed: resuming });
    });

    response.on('error', (err) => finish({ ok: false, reason: err.message }));
    file.on('error', (err) => finish({ ok: false, reason: err.message }));

    response.pipe(file);

    file.on('finish', () => {
      signal?.removeEventListener('abort', abort);
      if (settled) return;
      void readFile(target)
        .then((bytes) => finish({ ok: true, bytes, resumed: resuming }))
        .catch((err: Error) => finish({ ok: false, reason: err.message }));
    });
  });
}

/** Fetches a small document — the manifest — straight into memory. */
export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const response = await request(url, { 'user-agent': 'Groundplan' }, 5);
    const chunks: Buffer[] = [];
    return await new Promise<T | null>((resolve) => {
      const abort = (): void => {
        response.destroy();
        resolve(null);
      };
      signal?.addEventListener('abort', abort, { once: true });
      response.on('data', (c: Buffer) => chunks.push(c));
      response.on('error', () => resolve(null));
      response.on('end', () => {
        signal?.removeEventListener('abort', abort);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
        } catch {
          resolve(null);
        }
      });
    });
  } catch {
    // Offline is normal, not exceptional. The caller shows "cannot check"
    // rather than treating this as a failure worth interrupting anyone for.
    return null;
  }
}
