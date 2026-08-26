/**
 * Assembles a release that travels on a USB stick.
 *
 * `app-release.ts` prepares a release to be *hosted* — its manifest points at
 * download URLs. This prepares one to be *carried*: the same signed manifest,
 * with the packages sitting next to it, plus the installers for machines that
 * have never had Groundplan on them at all.
 *
 * Both audiences are covered because they are different problems. Somebody who
 * already runs Groundplan wants Help → Install Update from USB, which verifies
 * the signature and swaps the application. Somebody with a bare laptop wants an
 * installer to double-click. One folder holds both.
 *
 *   npm run build && npx electron-builder --mac --win
 *   npx tsx tools/usb-release.ts --version 1.1.0 --out /Volumes/USB/GROUNDPLAN
 *
 * The signing key is required, and never leaves this machine.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

const version = arg('version', String(JSON.parse(readFileSync('package.json', 'utf8')).version));
const outDir = arg('out', join('dist-usb', `GROUNDPLAN-${version}`));
const buildDir = arg('build', 'release');
const keyPath = arg('key', 'catalog-signing-key.pem');

if (!existsSync(keyPath)) {
  console.error(`no signing key at ${keyPath}. A USB release is signed exactly like a hosted one.`);
  process.exit(1);
}
if (!existsSync(buildDir)) {
  console.error(`no build output at ${buildDir}. Run: npm run build && npx electron-builder --mac --win`);
  process.exit(1);
}

/**
 * The packages a running copy can update itself from.
 *
 * Keyed the way `process.platform`-`process.arch` reports, because that is what
 * the updater looks itself up by.
 */
const UPDATE_TARGETS: Array<{ key: string; match: RegExp }> = [
  { key: 'darwin-arm64', match: /mac-arm64\.zip$/ },
  { key: 'darwin-x64', match: /mac-x64\.zip$/ },
  { key: 'win32-x64', match: /Setup-.*win-x64\.exe$/ },
];

/** Everything else worth carrying: first installs, and the portable build. */
const EXTRA_INSTALLERS = [/\.dmg$/, /Portable-.*\.exe$/, /\.AppImage$/];

const built = readdirSync(buildDir).filter((name) => name.includes(version));
if (!built.length) {
  console.error(`no ${version} artifacts in ${buildDir}. Build that version first.`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const packages: Record<string, AppPackage> = {};
const copied: string[] = [];

function take(name: string): { bytes: number; sha256: string } {
  const from = join(buildDir, name);
  const to = join(outDir, name);
  copyFileSync(from, to);
  copied.push(name);
  const bytes = statSync(to).size;
  return { bytes, sha256: sha256(readFileSync(to)) };
}

for (const target of UPDATE_TARGETS) {
  const name = built.find((file) => target.match.test(file));
  if (!name) {
    console.warn(`  no build for ${target.key} — copies on that platform cannot self-update from this stick`);
    continue;
  }
  const { bytes, sha256: digest } = take(name);
  // A bare filename, not a URL: on a stick the package sits beside the
  // manifest, and the reader resolves it by name.
  packages[target.key] = { url: name, bytes, sha256: digest };
}

for (const pattern of EXTRA_INSTALLERS) {
  for (const name of built.filter((file) => pattern.test(file))) {
    if (!copied.includes(name)) take(name);
  }
}

if (!Object.keys(packages).length) {
  console.error('nothing to update from: no self-update package matched. Refusing to write a useless stick.');
  process.exit(1);
}

const manifest: AppManifest = {
  schema: 1,
  version,
  released: new Date().toISOString(),
  notes: arg('notes', ''),
  packages,
};

const signature = cryptoSign(null, Buffer.from(canonicalise(manifest), 'utf8'), readFileSync(keyPath, 'utf8'));
writeFileSync(join(outDir, 'app-manifest.json'), `${JSON.stringify({ ...manifest, signature: signature.toString('base64') }, null, 2)}\n`);

/*
 * Only describe the platforms this stick actually carries.
 *
 * The instructions used to list Mac, Windows and Linux unconditionally, so a
 * stick built without a Windows build told a Windows user to "Run the Setup
 * .exe" — a file that is not in the folder. Somebody handed that stick has no
 * way to tell a missing build from a mistake they made, and the section that
 * would have told them (WHAT IS IN HERE) is below the instructions.
 */
const has = (pattern: RegExp): boolean => copied.some((name) => pattern.test(name));
const firstRunSections: string[] = [];
if (has(/\.dmg$/)) {
  firstRunSections.push(
    `Mac      Open the .dmg and drag Groundplan to Applications.
         The first launch needs a right-click (or Control-click) on the app,
         then Open, then Open again. macOS asks this once for an app that did
         not come from the App Store.`,
  );
}
if (has(/\.exe$/)) {
  firstRunSections.push(
    `Windows  Run the Setup .exe.${
      has(/Portable-.*\.exe$/)
        ? `
         No admin rights? Use the Portable .exe instead — it runs from this
         stick without installing.`
        : ''
    }`,
  );
}
if (has(/\.AppImage$/)) {
  firstRunSections.push(`Linux    chmod +x the .AppImage, then run it.`);
}
const missing = [
  has(/\.dmg$/) ? null : 'Mac',
  has(/\.exe$/) ? null : 'Windows',
  has(/\.AppImage$/) ? null : 'Linux',
].filter(Boolean);
const firstRunInstructions = [
  firstRunSections.join('\n\n'),
  missing.length
    ? `\nThis stick has no ${missing.join(' or ')} build. Ask for one that does —
a ${missing.length === 1 ? 'copy' : 'machine'} on ${
        missing.length === 1 ? 'that platform' : 'those platforms'
      } cannot be installed or updated from here.`
    : '',
]
  .filter(Boolean)
  .join('\n');

writeFileSync(
  join(outDir, 'README.txt'),
  `Groundplan ${version}
${'='.repeat(20 + version.length)}

No internet needed. Everything required is in this folder.


ALREADY HAVE GROUNDPLAN?
------------------------
Open it and choose  Help > Install Update from USB...
then pick this folder. It checks the signature before it installs anything.


FIRST TIME ON THIS COMPUTER?
----------------------------
${firstRunInstructions}


WHAT IS IN HERE
---------------
${copied.map((name) => `  ${name}`).join('\n')}
  app-manifest.json   signed release description — do not edit
  README.txt          this file

Editing or replacing any file here will cause Groundplan to refuse the update.
That is deliberate: it is what makes a stick safe to accept from someone else.
`,
);

const total = copied.reduce((sum, name) => sum + statSync(join(outDir, name)).size, 0);
console.log(`USB release ${version} -> ${outDir}`);
console.log(`  self-update packages : ${Object.keys(packages).join(', ')}`);
console.log(`  files                : ${copied.length + 2}`);
console.log(`  size                 : ${(total / 1024 / 1024).toFixed(0)} MB`);
console.log('\nCopy that folder to the stick. Nothing else is needed.');

void execFileSync;
