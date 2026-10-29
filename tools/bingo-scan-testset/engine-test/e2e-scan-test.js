// End-to-end test of the Scan page in real Chrome: download the engine, upload a photo, find the windows,
// read the numbers, and compare the review grid with the labels. Also covers Show detection and manual corners.
// Usage: node e2e-scan-test.js <repo root> <outDir>   (a dev server for the repo must be listening on 8766)
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const [repo, outDir] = [process.argv[2], process.argv[3]];
const base = 'http://localhost:8766/htdocs/Bingo/scan/scan.html';
const labels = JSON.parse(fs.readFileSync(path.join(repo, 'tools/bingo-scan-testset/labels.json'), 'utf8')).photos;
const log = [];
const check = (name, ok, detail) => { log.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
    userDataDir: 'C:/Users/scott/AppData/Local/Temp/bge2e', args: ['--no-first-run', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], protocolTimeout: 300000
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base, { waitUntil: 'load' });

    // Engine download through the page's own button
    await page.evaluate(() => document.getElementById('tabScan').click());
    await page.waitForSelector('#engineCard:not(.hidden)', { timeout: 15000 });
    await page.click('#engineDownloadBtn');
    await page.waitForFunction(() => EngineLoader.isLoaded(), { timeout: 240000 });
    check('engine downloads and loads', true);
    check('old tuning panel is gone', await page.evaluate(() => !document.querySelector('.tuning-details') && !document.getElementById('threshMode')));

    // Show detection starts off
    check('detection card hidden until switched on', await page.$eval('#detectionCard', e => e.classList.contains('hidden')));

    for (const name of ['20260721_195125.jpg', '20260721_195119.jpg']) {
      const photo = path.join(repo, 'tools/bingo-scan-testset/photos', name);
      const want = labels[name].labels;
      const input = await page.$('#fileInput');
      await input.uploadFile(photo);
      await page.waitForFunction(() => /Found \d+ of 25|Couldn't find/.test(document.getElementById('status').textContent), { timeout: 60000 });
      const status = await page.$eval('#status', e => e.textContent);
      check(`${name}: windows found automatically`, /Found (2\d) of 25/.test(status), status);
      check(`${name}: geometry kept for reading`, await page.evaluate(() => !!currentGeometry && currentGeometry.ok));

      await page.click('#ocrBtn');
      await page.waitForFunction(() => /Read in/.test(document.getElementById('status').textContent) || /OCR failed/.test(document.getElementById('status').textContent), { timeout: 120000 });
      const done = await page.$eval('#status', e => e.textContent);
      const seconds = Number((done.match(/Read in ([0-9.]+) s/) || [])[1]);
      check(`${name}: reading finishes`, /Read in/.test(done), done);
      check(`${name}: reading takes under 5 s`, seconds < 5, seconds + ' s');
      const grid = await page.evaluate(() => scannedGridData.slice());
      let correct = 0, wrong = 0;
      grid.forEach((v, i) => { if (i === 12) return; if (v === want[i]) correct++; else if (v !== null && v !== '') wrong++; });
      check(`${name}: review grid has at least 17 of 24 numbers right`, correct >= 17, `${correct} correct, ${wrong} wrong`);
      check(`${name}: FREE space stays in the center`, grid[12] === 'FREE');
      check(`${name}: review grid is drawn`, (await page.$$('#scannedGridElements .editor-cell')).length === 25);

      if (name === '20260721_195125.jpg') {
        // Show detection draws the overlay
        await page.evaluate(() => { const t = document.getElementById('showDetectionToggle'); t.checked = true; t.dispatchEvent(new Event('change')); });
        const visible = await page.$eval('#detectionCard', e => !e.classList.contains('hidden'));
        const size = await page.$eval('#detectionCanvas', c => [c.width, c.height]);
        check('Show detection draws the detection view', visible && size[0] > 200 && size[1] > 200, size.join('x'));
        check('detection summary names the profile and windows', /slider: |Profile slider/.test(await page.$eval('#detectionSummary', e => e.textContent)));

        // Manual crop: modal opens with handles on the detected corner windows; apply keeps reading possible
        await page.evaluate(() => document.getElementById('manualCropBtn').click());
        await page.waitForSelector('#manualCropModal:not(.hidden)');
        const title = await page.$eval('#manualCropModal h3', e => e.textContent);
        check('manual crop asks for the corner windows', /corner/i.test(title), title);
        const corners = await page.evaluate(() => JSON.parse(JSON.stringify(currentCorners)));
        check('handles start on the detected window centers (inside the photo)', corners.tl.x > 0 && corners.br.x < 1848 && corners.tl.y < corners.bl.y);
        await page.evaluate(() => document.getElementById('applyCropBtn').click());
        const afterApply = await page.$eval('#status', e => e.textContent);
        check('applying manual corners succeeds', /Card cropped/.test(afterApply), afterApply);
        await page.click('#ocrBtn');
        await page.waitForFunction(() => /Read in/.test(document.getElementById('status').textContent), { timeout: 120000 });
        const gridManual = await page.evaluate(() => scannedGridData.slice());
        const correctManual = gridManual.filter((v, i) => i !== 12 && v === want[i]).length;
        check('reading after manual corners still works', correctManual >= 15, correctManual + ' correct');
      }
    }

    // A picture without a card: windows not found, user is told what to do
    const blank = path.join(outDir, 'blank.png');
    await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 600; c.height = 800;
      const g = c.getContext('2d'); g.fillStyle = '#303030'; g.fillRect(0, 0, 600, 800);
      window.__blankDataUrl = c.toDataURL('image/png');
    });
    const dataUrl = await page.evaluate(() => window.__blankDataUrl);
    fs.writeFileSync(blank, Buffer.from(dataUrl.split(',')[1], 'base64'));
    await (await page.$('#fileInput')).uploadFile(blank);
    await page.waitForFunction(() => /Couldn't find/.test(document.getElementById('status').textContent), { timeout: 60000 });
    check('photo without a card: tells the user to place the corners', /Manual Crop/.test(await page.$eval('#status', e => e.textContent)));
    check('page scripts raised no errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    check('test run completed without error', false, String(err && err.stack || err));
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(outDir, 'e2e-result.json'), JSON.stringify(log, null, 2));
    process.exit(log.every(l => l.ok) ? 0 : 1);
  }
})();
