/**
 * Publishes an application release.
 *
 * Packages the built app, signs a manifest with the same Ed25519 key the
 * catalog uses, and writes both ready to attach to a GitHub release. Installed
 * copies check that manifest, verify the signature, and update themselves — no
 * reinstalling, and no Apple Developer ID.
 *
 *   npm run build && npx electron-builder --mac --win
 *   npx tsx tools/app-release.ts --version 1.0.2
 *
 * Then attach `dist-app/app-manifest.json` and the archives to the release.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sign as cryptoSign } from 'node:crypto';

import { canonicalise, sha256 } from '../src/catalog/manifest.js';
import type { AppManifest, AppPackage } from '../src/update/app-update.js';

function arg(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : process.argv[at + 1];
  if (value === undefined && fallback === undefined) {
    console.error(`missing --${name}`);
    process.exit(1);
  }
  return value ?? fallback!;
}

const version = arg('version');
const outDir = arg('out', 'dist-app');
const releaseDir = arg('release', 'release');
const keyPath = arg('key', 'catalog-signing-key.pem');
const baseUrl = arg(
  'base-url',
  `https://github.com/kxd21/groundplan-catalog/releases/download/app-v${version}`,
);

const privateKey =
  process.env.CATALOG_SIGNING_KEY ?? (existsSync(keyPath) ? readFileSync(keyPath, 'utf8') : '');
if (!privateKey) {
  console.error(`no signing key. Set CATALOG_SIGNING_KEY or place one at ${keyPath}.`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const packages: Record<string, AppPackage> = {};
let windowsArtifact: string | undefined;

/**
 * Zips a macOS bundle with `ditto`.
 *
 * `zip` mangles the symlinks inside a framework bundle; `ditto -c -k
 * --keepParent` is what Apple's own tooling uses and what the installer script
 * expects to unpack.
 */
function packMac(appPath: string, key: string, label: string): void {
  if (!existsSync(appPath)) {
    console.log(`  ${label.padEnd(14)} not built, skipped`);
    return;
  }
  const archive = join(outDir, `Groundplan-${version}-${label}.zip`);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, archive]);
  const bytes = statSync(archive).size;
  packages[key] = {
    url: `${baseUrl}/${archive.split('/').pop()}`,
    bytes,
    sha256: sha256(readFileSync(archive)),
  };
  console.log(`  ${label.padEnd(14)} ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}

packMac(join(releaseDir, 'mac-arm64', 'Groundplan.app'), 'darwin-arm64', 'mac-arm64');
packMac(join(releaseDir, 'mac', 'Groundplan.app'), 'darwin-x64', 'mac-x64');

/**
 * Finds the Windows installer by shape rather than by exact name.
 *
 * electron-builder's artifact naming is configurable and has already changed
 * once; matching on "a setup .exe carrying this version" survives that, and
 * fails loudly rather than silently publishing a release with no Windows build.
 */
const windowsInstaller = readdirSync(releaseDir)
  .filter((f) => f.toLowerCase().endsWith('.exe'))
  .filter((f) => f.includes(version))
  .filter((f) => /setup/i.test(f))
  .map((f) => join(releaseDir, f))
  .find(existsSync);

if (windowsInstaller) {
  const bytes = statSync(windowsInstaller).size;
  const fileName = windowsInstaller.split('/').pop()!;
  packages['win32-x64'] = {
    url: `${baseUrl}/${encodeURIComponent(fileName)}`,
    bytes,
    sha256: sha256(readFileSync(windowsInstaller)),
  };
  console.log(`  ${'win-x64'.padEnd(14)} ${(bytes / 1024 / 1024).toFixed(1)} MB  (${fileName})`);
  windowsArtifact = windowsInstaller;
} else {
  console.log(`  ${'win-x64'.padEnd(14)} no setup .exe for ${version} found in ${releaseDir}/`);
}

if (Object.keys(packages).length === 0) {
  console.error('nothing was packaged — build the application first');
  process.exit(1);
}

const manifest: AppManifest = {
  schema: 1,
  version,
  released: new Date().toISOString(),
  notes: arg('notes', ''),
  packages,
};
manifest.signature = cryptoSign(null, Buffer.from(canonicalise(manifest), 'utf8'), privateKey).toString(
  'base64',
);

writeFileSync(join(outDir, 'app-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`\napplication ${version}`);
console.log(`  platforms   ${Object.keys(packages).join(', ')}`);
console.log(`  signed      ${manifest.signature.slice(0, 16)}…`);
console.log(`  written to  ${outDir}/`);
console.log(`\nAttach to a release with:`);
console.log(`  gh release create app-v${version} --title "Groundplan ${version}" \\`);
console.log(`    ${outDir}/app-manifest.json ${outDir}/*.zip${windowsArtifact ? ` \\\n    ${JSON.stringify(windowsArtifact)}` : ''}`);
