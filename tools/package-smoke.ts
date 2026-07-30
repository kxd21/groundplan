/**
 * Cross-platform packaged-application smoke check.
 *
 * The default mode is non-invasive: it inspects electron-builder's unpacked
 * application, verifies the executable and required ASAR entries, and never
 * launches Groundplan. CI adds `--launch`, starts the native executable with an
 * isolated user-data directory, verifies that it stays alive long enough to
 * create its window, then terminates it.
 *
 *   npm run smoke:packaged -- release
 *   npm run smoke:packaged -- release --launch
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { extractFile, listPackage } from '@electron/asar';

interface PackagedApp {
  root: string;
  executable: string;
  archive: string;
  info?: string;
}

function packagedAppAt(path: string): PackagedApp | null {
  if (path.endsWith('.app')) {
    const name = basename(path, '.app');
    return {
      root: path,
      executable: join(path, 'Contents', 'MacOS', name),
      archive: join(path, 'Contents', 'Resources', 'app.asar'),
      info: join(path, 'Contents', 'Info.plist'),
    };
  }
  if (basename(path).toLowerCase() === 'groundplan.exe') {
    return {
      root: dirname(path),
      executable: path,
      archive: join(dirname(path), 'resources', 'app.asar'),
    };
  }
  return null;
}

function findPackagedApps(root: string): PackagedApp[] {
  const found: PackagedApp[] = [];
  const visit = (path: string, depth: number): void => {
    if (depth > 4 || !existsSync(path)) return;
    const direct = packagedAppAt(path);
    if (direct) {
      found.push(direct);
      return;
    }
    if (!statSync(path).isDirectory()) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.name.toLowerCase().endsWith('.exe')) continue;
      visit(join(path, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  return found;
}

function inspectMacMetadata(app: PackagedApp): void {
  if (!app.info) return;
  if (!existsSync(app.info)) throw new Error(`missing packaged metadata: ${app.info}`);

  const converted = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', app.info], {
    encoding: 'utf8',
  });
  if (converted.status !== 0) {
    throw new Error(`could not inspect ${app.info}: ${converted.stderr.trim()}`);
  }

  const plist = JSON.parse(converted.stdout) as {
    CFBundleDisplayName?: string;
    CFBundleExecutable?: string;
    CFBundleIdentifier?: string;
    CFBundleName?: string;
    CFBundleDocumentTypes?: Array<{
      CFBundleTypeExtensions?: string[];
      CFBundleTypeRole?: string;
    }>;
  };
  if (
    plist.CFBundleDisplayName !== 'Groundplan' ||
    plist.CFBundleName !== 'Groundplan' ||
    plist.CFBundleExecutable !== 'Groundplan' ||
    plist.CFBundleIdentifier !== 'com.groundplan.app'
  ) {
    throw new Error(`packaged macOS identity is invalid: ${JSON.stringify(plist)}`);
  }

  const expected = new Map([
    ['rv4', 'Editor'],
    ['rs4', 'Editor'],
    ['se4', 'Editor'],
    ['ds4', 'Editor'],
    ['rsd', 'Editor'],
    ['add', 'Viewer'],
    ['stk', 'Viewer'],
    ['lib', 'Viewer'],
  ]);
  for (const [extension, role] of expected) {
    const association = plist.CFBundleDocumentTypes?.find((type) =>
      type.CFBundleTypeExtensions?.includes(extension),
    );
    if (!association || association.CFBundleTypeRole !== role) {
      throw new Error(`missing macOS .${extension} ${role} file association in ${app.info}`);
    }
  }
}

function inspect(app: PackagedApp): void {
  if (!existsSync(app.executable)) throw new Error(`missing packaged executable: ${app.executable}`);
  if (!existsSync(app.archive)) throw new Error(`missing packaged ASAR: ${app.archive}`);
  if (statSync(app.archive).size < 1024) throw new Error(`packaged ASAR is unexpectedly small: ${app.archive}`);

  const entries = new Set(listPackage(app.archive, { isPack: false }).map((entry) => entry.replace(/^[/\\]/, '')));
  const required = ['package.json', 'out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html'];
  for (const entry of required) {
    if (!entries.has(entry)) throw new Error(`${app.archive} is missing ${entry}`);
  }

  const manifest = JSON.parse(extractFile(app.archive, 'package.json').toString('utf8')) as {
    name?: string;
    version?: string;
    main?: string;
  };
  if (manifest.name !== 'groundplan' || manifest.main !== 'out/main/index.js' || !manifest.version) {
    throw new Error(`packaged manifest is invalid: ${JSON.stringify(manifest)}`);
  }

  inspectMacMetadata(app);
  console.log(`  pass  ${app.root}`);
  console.log(`        Groundplan ${manifest.version}; ${entries.size.toLocaleString()} ASAR entries`);
}

async function launch(app: PackagedApp): Promise<void> {
  const data = mkdtempSync(join(tmpdir(), 'groundplan-package-smoke-'));
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  try {
    child = spawn(app.executable, [`--user-data-dir=${data}`], {
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
      child?.once('error', fail);
      child?.once('exit', (code, signal) => done({ code, signal }));
    });
    const earlyExit = await Promise.race([
      exited,
      new Promise<null>((done) => {
        setTimeout(() => done(null), 5000);
      }),
    ]);

    if (earlyExit) {
      throw new Error(
        `packaged app exited before its smoke window was stable ` +
          `(code ${String(earlyExit.code)}, signal ${String(earlyExit.signal)})${stderr ? `\n${stderr}` : ''}`,
      );
    }

    child.kill();
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<false>((done) => {
        setTimeout(() => done(false), 5000);
      }),
    ]);
    if (!stopped) throw new Error('packaged app did not stop after the smoke check');
    console.log(`  pass  launched for five seconds with isolated user data`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await Promise.race([
        exited?.catch(() => undefined) ?? Promise.resolve(),
        new Promise<void>((done) => {
          setTimeout(done, 1000);
        }),
      ]);
    }
    rmSync(data, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const launchRequested = args.includes('--launch');
  const directory = resolve(args.find((arg) => !arg.startsWith('--')) ?? 'release');
  const apps = findPackagedApps(directory);
  if (apps.length === 0) throw new Error(`no unpacked Groundplan application found under ${directory}`);

  console.log(`Inspecting ${apps.length} packaged application${apps.length === 1 ? '' : 's'}:`);
  for (const app of apps) inspect(app);

  if (launchRequested) {
    const launchable =
      process.platform === 'darwin'
        ? apps.find((app) =>
            process.arch === 'arm64'
              ? app.root.includes('mac-arm64')
              : !app.root.includes('mac-arm64'),
          )
        : apps[0];
    if (!launchable) throw new Error(`no ${process.arch} packaged application is available to launch`);
    await launch(launchable);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
