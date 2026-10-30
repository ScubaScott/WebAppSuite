// Guided capture in real Chrome with a fake camera playing a video file: overlay drawn, auto-shutter fires on a steady
// card, never on a moving or windowless picture, the switch and the manual shutter work, hint line and outline colors.
// Usage: node live-capture-test.js <repo root> <fake camera folder>   (a dev server for the repo must be listening on 8766)
// The folder must hold steady.y4m, moving.y4m, shaky.y4m and paper.y4m (made by make-fake-camera.py).
const puppeteer = require('puppeteer-core');
const path = require('path');

const [repo, camDir] = [process.argv[2], process.argv[3]];
const base = 'http://localhost:8766/htdocs/Bingo/scan/scan.html';
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function open(file, tag) {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
    userDataDir: 'C:/Users/scott/AppData/Local/Temp/bglc' + tag,
    args: ['--no-first-run', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + path.join(camDir, file)],
    protocolTimeout: 120000
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base, { waitUntil: 'load' });
  await page.evaluate(() => document.getElementById('tabScan').click());
  await page.waitForFunction(() => document.getElementById('camera').videoWidth > 0, { timeout: 20000 });
  return { browser, page, errors };
}

const captured = page => page.evaluate(() => isImageCaptured);

(async () => {
  // ---- Steady card in view: outline, found windows, photo taken by itself ----
  let { browser, page, errors } = await open('steady.y4m', 'a');
  try {
    check('camera starts at the requested size', await page.evaluate(() => document.getElementById('camera').videoWidth >= 640));
    check('hint line tells what to do', /Flash off/.test(await page.$eval('#cameraHint', e => e.textContent)));
    check('the old static grid lines are gone', await page.evaluate(() => !document.querySelector('.grid-line') && document.getElementById('cameraGridOverlay').tagName === 'CANVAS'));
    check('auto-capture switch is on by default', await page.$eval('#autoCaptureToggle', e => e.checked));
    // Watch the overlay and the hint until the photo is taken
    let sawOutline = false, sawHold = false, hintHold = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 12000 && !(await captured(page))) {
      const px = await page.evaluate(() => {
        const c = document.getElementById('cameraGridOverlay'); if (!c.width) return 0;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
      });
      if (px > 500) sawOutline = true;
      const hint = await page.$eval('#cameraHint', e => e.textContent);
      if (/Found \d+ of 25 windows/.test(hint)) { sawHold = true; hintHold = hint; }
      await sleep(80);
    }
    const tFire = Date.now() - t0;
    check('the 5x5 outline is drawn over the camera', sawOutline);
    check('the hint line reports the windows found while holding', sawHold, hintHold);
    check('the photo is taken by itself within 6 s of a steady card', (await captured(page)) && tFire < 6000, tFire + ' ms');
    const status = await page.$eval('#status', e => e.textContent);
    check('after the photo the page finds the windows in it', (await page.evaluate(() => !!currentGeometry && currentGeometry.ok)) || /Found \d+ of 25/.test(status), status);
    const dim = await page.evaluate(() => rawCapturedCanvas.width + 'x' + rawCapturedCanvas.height);
    check('the still is the center square at the stream height (480 px)', dim === '480x480', dim);
    check('the camera hint is hidden once a photo is showing', await page.$eval('#cameraHint', e => e.hidden));
    await sleep(2500);
    check('it does not take a second photo of the same card', await page.evaluate(() => document.getElementById('captureBtnText').textContent === 'Reset to Camera'));
    // Back to the camera: cooldown, then it can fire again
    await page.click('#captureBtn');
    check('Reset to Camera shows the live camera and hint again', !(await captured(page)) && !(await page.$eval('#cameraHint', e => e.hidden)));
    await sleep(900);
    check('no photo during the cooldown after Reset', !(await captured(page)));
    let again = true;
    await page.waitForFunction(() => isImageCaptured, { timeout: 9000 }).catch(() => { again = false; });
    check('a new photo is taken after the cooldown on a steady card', again);
    check('no page errors (steady scene)', errors.length === 0, errors.join(' | '));
  } finally { await browser.close(); }

  // ---- Switch off: nothing by itself, the shutter button still works ----
  ({ browser, page, errors } = await open('steady.y4m', 'b'));
  try {
    await page.evaluate(() => { const t = document.getElementById('autoCaptureToggle'); t.checked = false; t.dispatchEvent(new Event('change')); });
    check('the switch choice is remembered on this device', await page.evaluate(() => localStorage.getItem('bingoAutoCapture') === 'off'));
    await sleep(5000);
    check('with auto-capture off no photo is taken by itself', !(await captured(page)));
    await page.click('#captureBtn');
    await page.waitForFunction(() => isImageCaptured, { timeout: 5000 });
    check('the manual shutter button still takes the photo', await captured(page));
    check('no page errors (switch off)', errors.length === 0, errors.join(' | '));
    await page.reload({ waitUntil: 'load' });
    check('the switch stays off after reloading', !(await page.$eval('#autoCaptureToggle', e => e.checked)));
  } finally { await browser.close(); }

  // ---- Moving camera: never fires ----
  ({ browser, page, errors } = await open('moving.y4m', 'c'));
  try {
    await sleep(8000);
    check('a moving picture never fires the shutter', !(await captured(page)));
    check('the hint stays on the default text while moving', /Flash off|Hold steady/.test(await page.$eval('#cameraHint', e => e.textContent)));
    check('no page errors (moving)', errors.length === 0, errors.join(' | '));
  } finally { await browser.close(); }

  // ---- Wobbling camera (about 1.5% of the width): not steady ----
  ({ browser, page, errors } = await open('shaky.y4m', 'd'));
  try {
    await sleep(6000);
    check('a wobbling picture does not fire', !(await captured(page)));
  } finally { await browser.close(); }

  // ---- Steady picture without the card's windows: never fires ----
  ({ browser, page, errors } = await open('paper.y4m', 'e'));
  try {
    await sleep(7000);
    check('a steady picture with no number windows never fires', !(await captured(page)));
    check('the plain outline stays (no windows found)', await page.evaluate(() => document.getElementById('cameraGridOverlay').width > 0));
    check('no page errors (no card)', errors.length === 0, errors.join(' | '));
  } finally { await browser.close(); }

  const failed = results.filter(r => !r.ok).length;
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  require('fs').writeFileSync(path.join(camDir, 'live-capture-last-result.json'), JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
