/**
 * Swallow broken-pipe writes on stdout/stderr.
 *
 * When Electron is launched from a terminal, Finder, or a parent that closes
 * its pipes, Node still emits process warnings / console.error. Writing to the
 * closed pipe throws `Error: write EPIPE`, which Electron surfaces as an
 * "Uncaught Exception" dialog even though the app is otherwise fine.
 *
 * Import this module before anything else in the main process.
 */

function isBrokenPipe(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'EPIPE'
  );
}

function ignoreBrokenPipe(stream: NodeJS.WriteStream | null | undefined): void {
  if (!stream || typeof stream.on !== 'function') return;
  stream.on('error', (err) => {
    if (isBrokenPipe(err)) return;
    throw err;
  });
}

ignoreBrokenPipe(process.stdout);
ignoreBrokenPipe(process.stderr);

for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: Parameters<typeof original>) => {
    try {
      original(...args);
    } catch (err) {
      if (!isBrokenPipe(err)) throw err;
    }
  };
}

export { isBrokenPipe };
