#!/usr/bin/env node
/**
 * Render the first-install page at the two sizes people actually share and use.
 *
 * The desktop and mobile captures are temporary QA evidence. The 1200x630
 * social card is a published asset referenced by the page's Open Graph tags.
 */

const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'docs', 'download', 'index.html');
const PAGE_HTML = readFileSync(PAGE, 'utf8');
const SHARE = path.join(ROOT, 'docs', 'download', 'groundplan-share.png');
const VERSION = require(path.join(ROOT, 'package.json')).version;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function capturePage(win, width, height, output) {
  win.setContentSize(Math.ceil(width / 2), Math.ceil(height / 2));
  win.webContents.setZoomFactor(0.5);
  await win.webContents.executeJavaScript(
    `document.open(); document.write(${JSON.stringify(PAGE_HTML)}); document.close();`,
  );
  await win.webContents.executeJavaScript('document.fonts.ready');
  for (let i = 0; i < 30; i += 1) {
    const ready = await win.webContents.executeJavaScript(
      "document.getElementById('primary-download')?.getAttribute('aria-disabled') !== 'true'",
    );
    if (ready) break;
    await delay(150);
  }
  win.webContents.invalidate();
  await delay(350);
  const shot = await win.webContents.capturePage();
  const png = shot.resize({ width, height, quality: 'best' }).toPNG();
  writeFileSync(output, png);
}

async function captureShareCard(win) {
  const width = 1200;
  const height = 630;
  const html = `<!doctype html><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
    body {
      position: relative; padding: 72px 82px;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif;
      color: #142033;
      background:
        radial-gradient(circle at 12% 5%, rgba(22,135,248,.18), transparent 340px),
        radial-gradient(circle at 92% 90%, rgba(63,163,112,.13), transparent 390px),
        #f5f6f8;
    }
    body::after {
      content: ""; position: absolute; right: 70px; top: 68px; width: 360px; height: 480px;
      background: linear-gradient(155deg,#fff,#edf3f8); border: 1px solid #d6dee8;
      border-radius: 36px; box-shadow: 0 32px 78px rgba(32,55,82,.16); transform: rotate(3deg);
    }
    .brand { display: flex; align-items: center; gap: 14px; font-size: 24px; font-weight: 730; }
    .mark {
      display: grid; width: 46px; height: 46px; place-items: center; color: white;
      background: linear-gradient(145deg,#1687f8,#0b63b8); border-radius: 13px;
      box-shadow: 0 8px 20px rgba(11,110,203,.24);
    }
    h1 { width: 720px; margin: 96px 0 22px; font-size: 72px; line-height: .96; letter-spacing: -.057em; }
    p { width: 650px; margin: 0; color: #526174; font-size: 23px; line-height: 1.45; }
    .chips { display: flex; gap: 10px; margin-top: 38px; }
    .chip { padding: 8px 13px; color: #31506f; background: rgba(255,255,255,.74); border: 1px solid #d5dde6; border-radius: 999px; font-size: 15px; font-weight: 650; }
    .url { position: absolute; left: 82px; bottom: 42px; color: #0b64b7; font-size: 18px; font-weight: 680; }
    .card-copy { position: absolute; z-index: 2; right: 106px; top: 130px; width: 292px; transform: rotate(3deg); }
    .card-copy .label { color: #176b43; font-size: 13px; font-weight: 760; letter-spacing: .08em; text-transform: uppercase; }
    .card-copy strong { display: block; margin-top: 22px; font-size: 30px; letter-spacing: -.04em; }
    .card-copy span { display: block; margin-top: 9px; color: #657386; font-size: 16px; line-height: 1.4; }
    .download { margin-top: 28px; padding: 15px; color: #fff; background: #0b6ecb; border-radius: 12px; text-align: center; font-size: 17px; font-weight: 700; }
    .steps { display: grid; gap: 12px; margin-top: 25px; color: #42536a; font-size: 15px; }
    .steps div { padding-top: 12px; border-top: 1px solid #dce2e9; }
  </style>
  <body>
    <div class="brand"><span class="mark">GP</span>Groundplan</div>
    <h1>Build the room.<br>Plan the show.</h1>
    <p>A modern workspace for event rooms, seating, stages, equipment, and show readiness.</p>
    <div class="chips"><span class="chip">macOS</span><span class="chip">Windows</span><span class="chip">Linux</span><span class="chip">Opens native .rv4</span></div>
    <div class="url">kxd21.github.io/groundplan/download</div>
    <div class="card-copy">
      <div class="label">Latest release</div>
      <strong>Groundplan ${VERSION}</strong>
      <span>One link detects the computer and chooses the installer.</span>
      <div class="download">Download Groundplan</div>
      <div class="steps"><div>1 &nbsp;Download</div><div>2 &nbsp;Install</div><div>3 &nbsp;Start planning</div></div>
    </div>
  </body>`;

  win.setContentSize(width / 2, height / 2);
  win.webContents.setZoomFactor(0.5);
  await win.webContents.executeJavaScript(
    `document.open(); document.write(${JSON.stringify(html)}); document.close();`,
  );
  await delay(250);
  const shot = await win.webContents.capturePage();
  writeFileSync(SHARE, shot.resize({ width, height, quality: 'best' }).toPNG());
}

app.whenReady().then(async () => {
  mkdirSync(path.dirname(SHARE), { recursive: true });
  const probe = new BrowserWindow({
    width: 640,
    height: 586,
    show: false,
    frame: false,
    useContentSize: true,
    webPreferences: { sandbox: false },
  });
  await probe.loadURL('data:text/html;charset=utf-8,%3Chtml%3E%3Cbody%3E%3C%2Fbody%3E%3C%2Fhtml%3E');
  await capturePage(probe, 1440, 1000, '/tmp/groundplan-download-desktop.png');
  await capturePage(probe, 390, 844, '/tmp/groundplan-download-mobile.png');
  await captureShareCard(probe);
  console.log('download page captures written to /tmp');
  console.log(`social preview written to ${SHARE}`);
  probe.destroy();
  app.quit();
  process.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
