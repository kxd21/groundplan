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
    -webkit-font-smoothing: antialiased; color: #1d1d1f; background: #f2f2f4;
  }
  /* A seam separates "put it there" from "then do this": they happen minutes
     apart and the second is the surprising half. */
  .install {
    position: absolute; inset: 0 0 auto 0; height: 250px;
    background: linear-gradient(180deg, #fbfbfc 0%, #f2f2f4 100%);
    border-bottom: 1px solid #dcdce0;
  }
  .step-label {
    position: absolute; left: 0; right: 0; text-align: center;
    font-size: 12px; font-weight: 590; letter-spacing: 0.04em;
    text-transform: uppercase; color: #86868b;
  }
  .install .step-label { top: 26px; }
  .headline {
    position: absolute; left: 0; right: 0; text-align: center;
    font-size: 19px; font-weight: 600; letter-spacing: -0.01em;
  }
  .install .headline { top: 50px; }
  /* The arrow spans the gap between the icon slots the DMG places at x=170 and
     x=470, both at y=175. Nothing may be drawn inside those slots. */
  .arrow { position: absolute; top: 168px; left: 258px; width: 124px; height: 18px; }
  /* Normal flow below the seam, not absolute coordinates. The first attempt
     positioned this block's label with a page-absolute "top", which put "Step 2"
     at the very bottom of the window and dropped the footnote on top of the
     cards. A flex column cannot get that wrong. */
  .gate {
    position: absolute; inset: 250px 0 0 0; padding: 20px 30px 12px;
    display: flex; flex-direction: column;
  }
  .gate .step-label { position: static; }
  .gate-headline {
    margin-top: 9px; text-align: center;
    font-size: 17px; font-weight: 600; letter-spacing: -0.01em;
  }
  .gate-sub {
    margin-top: 5px; text-align: center;
    font-size: 12.5px; line-height: 1.45; color: #6e6e73;
  }
  .routes { display: flex; gap: 14px; margin-top: 16px; }
  .route {
    flex: 1; min-width: 0; padding: 12px 13px 13px;
    background: #ffffff; border: 1px solid #dcdce0; border-radius: 9px;
  }
  .route h3 { font-size: 11px; font-weight: 640; letter-spacing: 0.02em; }
  .route .ver {
    display: block; margin-top: 1px;
    font-size: 10px; font-weight: 500; color: #86868b;
  }
  .route p { margin-top: 8px; font-size: 11.5px; line-height: 1.5; color: #3a3a3c; }
  .route b { font-weight: 600; color: #1d1d1f; }
  /* Amber, not red: a step to follow, not a failure to fear. */
  .route.primary { border-color: #e0b45c; background: #fffdf7; }
  .route.primary h3 { color: #8a5a00; }
  /* "margin-top: auto" pins this to the bottom of the flex column without
     needing a coordinate that has to be kept in step with the cards above. */
  .footnote {
    margin-top: auto; padding-top: 12px;
    text-align: center; font-size: 10.5px; line-height: 1.45; color: #86868b;
  }
</style></head>
<body>
  <div class="install">
    <div class="step-label">Step 1</div>
    <div class="headline">Drag Groundplan into Applications</div>
    <svg class="arrow" viewBox="0 0 124 18" fill="none">
      <path d="M2 9 H108" stroke="#b8b8bd" stroke-width="2" stroke-linecap="round" stroke-dasharray="7 6"/>
      <path d="M104 3 L114 9 L104 15" stroke="#b8b8bd" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </div>

  <div class="gate">
    <div class="step-label">Step 2 &middot; first launch only</div>
    <div class="gate-headline">macOS will refuse to open it. This is expected.</div>
    <div class="gate-sub">
      You will see &ldquo;Apple could not verify Groundplan is free of malware.&rdquo;<br>
      macOS says that about any app not put through Apple&rsquo;s paid notarisation
      service. Approve it once &mdash; it opens normally ever after.
    </div>
    <div class="routes">
      <div class="route primary">
        <h3>Open System Settings<span class="ver">macOS 15 Sequoia, macOS 26 Tahoe, newer</span></h3>
        <p>Double-click Groundplan, click <b>Done</b>, then open
        <b>System&nbsp;Settings &rsaquo; Privacy&nbsp;&amp;&nbsp;Security</b>.
        Scroll to <b>Security</b>, click <b>Open&nbsp;Anyway</b>, authenticate,
        then click <b>Open&nbsp;Anyway</b> once more.</p>
      </div>
      <div class="route">
        <h3>Control-click the app<span class="ver">macOS 14 Sonoma and older</span></h3>
        <p><b>Control-click</b> Groundplan in Applications and choose <b>Open</b>,
        then <b>Open</b> again. The Control-click is the part that matters &mdash;
        double-clicking will only ever refuse.</p>
      </div>
    </div>
    <div class="footnote">
      Not sure which macOS you have? Apple menu &rsaquo; About This Mac.
      Approving Groundplan does not turn off Gatekeeper.<br>
      Stuck, or it says &ldquo;damaged&rdquo;? &nbsp;kxd21.github.io/groundplan/download
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
