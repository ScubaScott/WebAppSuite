// Review screen and failure handling on the real Scan page in Chrome (phone-sized window): cell states, summary line,
// profile chip and its override, picking a number settles a cell, covered cells, "Couldn't find the windows" with
// Retake and Adjust corners, touch target sizes.
// Usage: node review-ui-test.js <repo root> <outDir>   (a dev server for the repo must be listening on 8766)
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const [repo, outDir] = [process.argv[2], process.argv[3]];
const base = 'http://localhost:8766/htdocs/Bingo/scan/scan.html';
const photos = path.join(repo, 'tools/bingo-scan-testset/photos');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };

// What the page shows for the 24 numbered cells: counts by state class, read from the DOM
const domCounts = page => page.evaluate(() => {
  const cells = Array.from(document.querySelectorAll('#scannedGridElements .editor-cell:not(.editor-col-header):not(.free)'));
  const has = c => cells.filter(e => e.classList.contains(c)).length;
  return { total: cells.length, check: has('cell-check'), missing: has('cell-missing'), covered: has('cell-covered'), edited: has('cell-edited'), summary: document.getElementById('reviewSummary').textContent };
});

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
    userDataDir: 'C:/Users/scott/AppData/Local/Temp/bgrev',
    args: ['--no-first-run', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], protocolTimeout: 300000,
    defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base, { waitUntil: 'load' });
    await page.evaluate(() => document.getElementById('tabScan').click());
    await page.waitForSelector('#engineCard:not(.hidden)', { timeout: 15000 });
    await page.click('#engineDownloadBtn');
    await page.waitForFunction(() => EngineLoader.isLoaded(), { timeout: 240000 });

    // ---- A real photo with some cells to check ----
    const upload = async name => { await (await page.$('#fileInput')).uploadFile(path.join(photos, name)); await page.waitForFunction(() => /Found \d+ of 25|Couldn't find/.test(document.getElementById('status').textContent), { timeout: 60000 }); };
    await upload('20260721_195121.jpg');
    await page.click('#ocrBtn');
    await page.waitForFunction(() => /Read in/.test(document.getElementById('status').textContent), { timeout: 120000 });
    let c = await domCounts(page);
    check('24 numbered cells are drawn', c.total === 24, JSON.stringify(c));
    check('the summary line reads "N read · M to check"', /^\d+ read · \d+ to check$/.test(c.summary), c.summary);
    const [read, toCheck] = c.summary.match(/\d+/g).map(Number);
    check('summary adds up to 24', read + toCheck === 24, c.summary);
    check('to-check count equals the amber + red + hatched cells shown', toCheck === c.check + c.missing + c.covered, `${toCheck} vs ${c.check}+${c.missing}+${c.covered}`);
    check('this photo has cells flagged as check or missing', c.check + c.missing > 0, JSON.stringify(c));

    const chip = await page.$eval('#profileChip', e => ({ text: e.textContent, hidden: e.classList.contains('hidden'), h: e.getBoundingClientRect().height }));
    check('the profile chip names the slider format', !chip.hidden && /^Slider card/.test(chip.text), chip.text);
    check('the profile chip is at least 44 px tall', chip.h >= 44, chip.h + ' px');
    const cellBox = await page.$eval('#scannedGridElements .editor-cell:not(.free)', e => { const r = e.getBoundingClientRect(); return [r.width, r.height]; });
    check('review cells are square and at least 44 px', cellBox[0] >= 44 && Math.abs(cellBox[0] - cellBox[1]) < 1.5, cellBox.join('x'));
    await page.screenshot({ path: path.join(outDir, 'review-phone.png'), fullPage: false, clip: await page.$eval('#bingoOutputSection', e => { const r = e.getBoundingClientRect(); return { x: 0, y: r.top + window.scrollY, width: 390, height: r.height }; }) }).catch(() => {});

    // Picking a number settles a flagged cell: it stops being amber, the summary moves one to "read"
    const target = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('#scannedGridElements .editor-cell'));
      const i = cells.findIndex(e => e.classList.contains('cell-check'));
      return i;
    });
    if (target >= 0) {
      const before = await domCounts(page);
      await page.evaluate(i => document.querySelectorAll('#scannedGridElements .editor-cell')[i].click(), target);
      await page.waitForSelector('#scannedPickerEl:not(.hidden)');
      // Choose the number it already has: confirming a reading is a deliberate act too
      await page.evaluate(() => document.querySelector('#scannedPickerEl .editor-pick-btn.current').click());
      const after = await domCounts(page);
      check('confirming a flagged cell removes its amber state', after.check === before.check - 1, `${before.check} -> ${after.check}`);
      check('the summary line updates after the user settles a cell', after.summary !== before.summary && Number(after.summary.match(/\d+/)[0]) === Number(before.summary.match(/\d+/)[0]) + 1, `${before.summary} -> ${after.summary}`);
    } else check('a flagged cell exists to confirm', false);

    const miss = await page.evaluate(() => Array.from(document.querySelectorAll('#scannedGridElements .editor-cell')).findIndex(e => e.classList.contains('cell-missing')));
    if (miss >= 0) {
      const before = await domCounts(page);
      await page.evaluate(i => document.querySelectorAll('#scannedGridElements .editor-cell')[i].click(), miss);
      await page.waitForSelector('#scannedPickerEl:not(.hidden)');
      await page.evaluate(() => Array.from(document.querySelectorAll('#scannedPickerEl .editor-pick-btn:not(.used)'))[0].click());
      const after = await domCounts(page);
      check('filling a missing cell by hand clears its red state', after.missing === before.missing - 1, `${before.missing} -> ${after.missing}`);
    }

    // ---- Profile chip override: slider -> hand-placed corners ----
    await page.click('#profileChip');
    await page.waitForFunction(() => !document.getElementById('manualCropModal').classList.contains('hidden'), { timeout: 5000 });
    check('tapping the chip opens the corner placement', true);
    await page.click('#applyCropBtn');
    await page.waitForFunction(() => document.getElementById('manualCropModal').classList.contains('hidden'));
    check('hand-placed corners become the geometry', await page.evaluate(() => currentGeometry && currentGeometry.profileId === 'manual'));
    await page.click('#ocrBtn');
    await page.waitForFunction(() => /Read in/.test(document.getElementById('status').textContent) && /^Manual/.test(document.getElementById('profileChip').textContent), { timeout: 120000 });
    check('after reading with corners the chip says Manual', /^Manual/.test(await page.$eval('#profileChip', e => e.textContent)), await page.$eval('#profileChip', e => e.textContent));
    // Manual -> automatic again
    await page.click('#profileChip');
    await page.waitForFunction(() => /Found \d+ of 25/.test(document.getElementById('status').textContent) && currentGeometry && currentGeometry.profileId === 'slider', { timeout: 60000 });
    check('tapping the Manual chip goes back to finding the windows automatically', true);

    // ---- Covered cells and the other states on a synthetic card ----
    await page.evaluate(() => {
      const cells = [];
      for (let i = 0; i < 25; i++) if (i !== 12) cells.push({ index: i, value: 1 + (i % 5) * 15 + Math.floor(i / 5), score: 0.95, kind: 'exact', changedByDecoder: false, covered: false, glare: false });
      cells[0].covered = true; cells[0].value = null;
      cells[1].value = null; cells[1].alternatives = [16, 21];
      cells[2].glare = true;
      const grid = [0, 1, 2, 3, 4].map(r => [0, 1, 2, 3, 4].map(cc => r === 2 && cc === 2 ? 'FREE' : (cells.find(x => x.index === r * 5 + cc) || {}).value));
      drawBingoGrid(grid, { decoded: { cells }, profileChip: { label: 'Slider card', hint: '', onTap: () => {} } });
    });
    c = await domCounts(page);
    check('a closed shutter is shown as covered', c.covered === 1, JSON.stringify(c));
    const closedText = await page.evaluate(() => getComputedStyle(document.querySelector('.cell-covered'), '::before').content);
    check('a covered cell says Closed', /Closed/.test(closedText), closedText);
    check('glare shows as check, empty as missing', c.check === 1 && c.missing === 1, JSON.stringify(c));
    check('synthetic summary: 21 read · 3 to check', c.summary === '21 read · 3 to check', c.summary);
    // The picker of an empty cell highlights what the scan thought it could be
    await page.evaluate(() => document.querySelectorAll('#scannedGridElements .editor-cell')[1].click());
    const picker = await page.evaluate(() => ({ label: document.querySelector('#scannedPickerEl .editor-picker-label').textContent, suggested: Array.from(document.querySelectorAll('#scannedPickerEl .editor-pick-btn.suggested')).map(b => b.textContent) }));
    check('the picker of an unread cell highlights the suggested numbers', picker.suggested.join(',') === '16,21' && /maybe 16 or 21/.test(picker.label), JSON.stringify(picker));
    // A grid drawn without scan information (older call) still works and shows no summary
    await page.evaluate(() => drawBingoGrid([[1, 16, 31, 46, 61], [2, 17, 32, 47, 62], [3, 18, 'FREE', 48, 63], [4, 19, 33, 49, 64], [5, 20, 34, 50, 65]]));
    c = await domCounts(page);
    check('a grid without scan information has no states and no summary', c.check + c.missing + c.covered === 0 && c.summary === '', JSON.stringify(c));
    check('the chip stays hidden without a profile', await page.$eval('#profileChip', e => e.classList.contains('hidden')));

    // ---- Windows not found: Retake / Adjust corners ----
    await page.evaluate(() => { document.getElementById('captureBtn').click(); });
    await upload('20251109_162316_a.jpg');
    const status = await page.$eval('#status', e => e.textContent);
    check('a photo without the card says it could not find the windows', /Couldn't find the windows/.test(status), status);
    check('Retake and Adjust corners are offered', await page.$eval('#detectFail', e => !e.classList.contains('hidden')) && (await page.$$eval('#detectFail button', b => b.map(x => x.textContent))).join('|') === 'Retake|Adjust corners');
    const btnH = await page.$$eval('#detectFail button', b => b.map(x => x.getBoundingClientRect().height));
    check('both buttons are at least 44 px tall', btnH.every(h => h >= 44), btnH.join(','));
    await page.click('#adjustCornersBtn');
    check('Adjust corners opens the corner handles', await page.$eval('#manualCropModal', e => !e.classList.contains('hidden')));
    await page.click('#cancelCropBtn');
    await page.click('#retakeBtn');
    check('Retake goes back to the live camera and hides the buttons', await page.evaluate(() => !isImageCaptured && document.getElementById('detectFail').classList.contains('hidden')));
    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally { await browser.close(); }

  const failed = results.filter(r => !r.ok).length;
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  fs.writeFileSync(path.join(outDir, 'review-ui-last-result.json'), JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
