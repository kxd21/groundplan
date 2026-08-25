/**
 * Ad-hoc signs the macOS app after packaging.
 *
 * Apple Silicon refuses to launch an arm64 binary with no signature at all, so
 * an unsigned build that runs fine on the machine that made it is dead on
 * arrival anywhere else. An ad-hoc signature ("-") costs nothing, needs no
 * Developer ID, and makes the binary loadable; Gatekeeper still asks the user
 * to approve it the first time, which is expected for an unnotarised app.
 */

const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // A signed build gets a real Developer ID signature from electron-builder
  // after this hook. Ad-hoc signing here would overwrite it and put the app
  // straight back to "Apple could not verify this software".
  if (process.env.GROUNDPLAN_SIGNED === '1') {
    console.log('  • skipping ad-hoc signature: Developer ID build');
    return;
  }

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'pipe' });
    console.log(`  • ad-hoc signed  ${app}`);
  } catch (error) {
    // Not fatal: the build is still usable on Intel and for local testing.
    console.warn(`  • ad-hoc signing failed: ${error.message}`);
  }
};
