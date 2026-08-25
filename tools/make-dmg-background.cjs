#!/usr/bin/env node
/**
 * Draws the disk image's background.
 *
 *   npm run build:dmg-background
 *
 * The DMG window is the one surface a user cannot skip: it is on screen, by
 * definition, at the moment they install. A README sitting next to the app is
 * not — people drag the icon and close the window, which is exactly why the
 * Gatekeeper block then arrives as a surprise.
 *
 * So the instructions ARE the window. This renders them to a two-representation
 * TIFF, which is how macOS picks between standard and retina; two PNGs sitting
 * beside each other mean nothing to it. electron-builder reads
 * `build/background.tiff` and sizes the DMG window from it, so the layout here
 * and the icon coordinates in `electron-builder.yml` are two halves of one
 * design and have to move together.
 *
 * CommonJS on purpose: Electron never reaches `ready` when handed an .mjs main
 * script, so the ESM version of this hung with no output.
 */

const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build');

/**
 * Window size in points.
 *
 * Tall enough for two steps without the type shrinking, narrow enough that the
 * window still opens fully on a 1280-wide laptop screen.
 */
const WIDTH = 640;
const HEIGHT = 586;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden;
    font-family: -apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased; color: #1d1d1f; background: #f5f6f8;
  }
  /* The icon band stays deliberately quiet: Finder draws the application and
     Applications icons over this artwork at x=170 and x=470. */
  .install {
    position: absolute; inset: 0 0 auto 0; height: 238px;
    background:
      radial-gradient(circle at 50% 8%, rgba(37, 120, 232, .055), transparent 46%),
      linear-gradient(180deg, #ffffff 0%, #f9fafc 100%);
    border-bottom: 1px solid #dfe3e8;
  }
  .step-label {
    display: inline-flex; align-items: center; justify-content: center;
    width: max-content; min-height: 22px; padding: 0 9px;
    border: 1px solid #d8e8fa; border-radius: 999px;
    background: #f2f7fd; color: #1669bd;
    font-size: 10px; font-weight: 700; letter-spacing: .075em;
    line-height: 1; text-transform: uppercase;
  }
  .install .step-label {
    position: absolute; top: 23px; left: 50%; transform: translateX(-50%);
  }
  .headline {
    position: absolute; left: 0; right: 0; text-align: center;
    font-size: 20px; font-weight: 650; letter-spacing: -0.018em;
  }
  .install .headline { top: 54px; }
  .install-sub {
    position: absolute; top: 84px; left: 0; right: 0;
    color: #6e7781; font-size: 12px; text-align: center;
  }
  /* The arrow spans the gap between the icon slots the DMG places at x=170 and
     x=470, both at y=175. Nothing may be drawn inside those slots. */
  .arrow { position: absolute; top: 166px; left: 258px; width: 124px; height: 20px; }
  .gate {
    position: absolute; inset: 238px 0 0 0; padding: 18px 30px 11px;
    display: flex; flex-direction: column;
  }
  .gate .step-label { position: static; align-self: center; }
  .gate-headline {
    margin-top: 7px; text-align: center;
    font-size: 18px; font-weight: 650; letter-spacing: -0.014em;
  }
  .gate-sub {
    margin: 4px auto 0; max-width: 540px; text-align: center;
    font-size: 11.5px; line-height: 1.42; color: #69727d;
  }
  .routes { display: flex; gap: 12px; margin-top: 13px; }
  .route {
    flex: 1; min-width: 0; min-height: 136px; padding: 11px 12px 10px;
    background: #ffffff; border: 1px solid #d9dee5; border-radius: 12px;
    box-shadow: 0 1px 2px rgba(26, 38, 54, .04);
  }
  .route-head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding-bottom: 8px; border-bottom: 1px solid #eceff3;
  }
  .route h3 { font-size: 11.5px; font-weight: 700; letter-spacing: -.005em; }
  .version {
    flex: none; padding: 2px 6px; border-radius: 999px;
    background: #f1f3f6; color: #69727d;
    font-size: 8.5px; font-weight: 700; letter-spacing: .035em;
  }
  .route ol { display: grid; gap: 5px; margin-top: 8px; list-style: none; }
  .route li {
    display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 6px;
    align-items: start; color: #454b53; font-size: 10.5px; line-height: 1.34;
  }
  .route li > span {
    display: grid; width: 16px; height: 16px; place-items: center;
    border-radius: 50%; background: #eef1f5; color: #5f6873;
    font-size: 8.5px; font-weight: 750;
  }
  .route b { font-weight: 650; color: #1d1d1f; }
  .route.primary {
    border-color: #a9cdf2;
    background: linear-gradient(180deg, #f8fbff 0%, #f3f8fe 100%);
    box-shadow: 0 1px 2px rgba(11, 110, 203, .06);
  }
  .route.primary h3 { color: #0b5fab; }
  .route.primary .route-head { border-bottom-color: #d9e9f9; }
  .route.primary .version { background: #dfeefd; color: #0b5fab; }
  .route.primary li > span { background: #dcecff; color: #0b5fab; }
  .footnote {
    margin-top: auto; padding-top: 9px;
    text-align: center; font-size: 9.5px; line-height: 1.45; color: #858c95;
  }
  .footnote strong { color: #5f6873; font-weight: 600; }
</style></head>
<body>
  <div class="install">
    <div class="step-label">1 &middot; Install</div>
    <div class="headline">Move Groundplan to Applications</div>
    <div class="install-sub">Drag the Groundplan icon onto the Applications folder.</div>
    <svg class="arrow" viewBox="0 0 124 20" fill="none">
      <path d="M2 10 H108" stroke="#91a4b7" stroke-width="2" stroke-linecap="round" stroke-dasharray="6 6"/>
      <path d="M104 4 L114 10 L104 16" stroke="#4f86bd" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </div>

  <div class="gate">
    <div class="step-label">2 &middot; First open</div>
    <div class="gate-headline">Allow Groundplan once</div>
    <div class="gate-sub">
      If macOS says it cannot verify Groundplan, use the route for your version.
      This one-time approval applies only to Groundplan.
    </div>
    <div class="routes">
      <div class="route primary">
        <div class="route-head"><h3>System Settings</h3><span class="version">macOS 15+</span></div>
        <ol>
          <li><span>1</span><div>Open Groundplan once, then click <b>Done</b>.</div></li>
          <li><span>2</span><div>Go to <b>Privacy &amp; Security</b> in System Settings.</div></li>
          <li><span>3</span><div>Under Security, click <b>Open Anyway</b>, authenticate, and confirm.</div></li>
        </ol>
      </div>
      <div class="route">
        <div class="route-head"><h3>Control-click to open</h3><span class="version">macOS 14 or earlier</span></div>
        <ol>
          <li><span>1</span><div>Open the <b>Applications</b> folder.</div></li>
          <li><span>2</span><div><b>Control-click</b> Groundplan and choose <b>Open</b>.</div></li>
          <li><span>3</span><div>Click <b>Open</b> once more to confirm.</div></li>
        </ol>
      </div>
    </div>
    <div class="footnote">
      Check your version in <strong>Apple menu &rsaquo; About This Mac</strong>.
      This does not disable Gatekeeper.<br>
      Need help? &nbsp;<strong>kxd21.github.io/groundplan/download</strong>
    </div>
  </div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    useContentSize: true,
    webPreferences: { sandbox: false },
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // A beat for web fonts and layout to settle before the frame is taken.
  await new Promise((resolve) => setTimeout(resolve, 600));

  const shot = await win.webContents.capturePage();
  const { width, height } = shot.getSize();

  /*
   * `capturePage` returns device pixels, so on a retina machine this is already
   * the 2x representation. On a non-retina one it is not, and packing a 1x
   * image as the retina half would ship a blurry background — worth failing
   * over rather than discovering on somebody's laptop.
   */
  if (width !== WIDTH * 2 || height !== HEIGHT * 2) {
    console.error(
      `Expected a ${WIDTH * 2}x${HEIGHT * 2} capture from a retina display, got ${width}x${height}.\n` +
        'Run this on a Mac with a retina screen, or the DMG background will be soft.',
    );
    app.quit();
    process.exit(1);
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'background@2x.png'), shot.toPNG());
  writeFileSync(
    path.join(OUT, 'background.png'),
    shot.resize({ width: WIDTH, height: HEIGHT, quality: 'best' }).toPNG(),
  );

  // The supported way to build a multi-representation TIFF. `-cathidpicheck`
  // verifies the second image really is twice the first.
  execFileSync(
    'tiffutil',
    [
      '-cathidpicheck',
      path.join(OUT, 'background.png'),
      path.join(OUT, 'background@2x.png'),
      '-out',
      path.join(OUT, 'background.tiff'),
    ],
    { stdio: 'pipe' },
  );

  console.log(`build/background.tiff written — ${WIDTH}x${HEIGHT} @1x and @2x`);
  app.quit();
  process.exit(0);
});
