// End-to-end test of scan contribution in real Chrome against a real PHP server and database:
// scan a photo, confirm the card, and check that the sample arrives in MySQL; plus the first-scan notice, the settings,
// the photo option, offline queueing, the export backup and the "collection is full" pause.
//
// Usage: node training-e2e-test.js   (settings come from environment variables, see README.md)
//   BASE, CAP_BASE, REPO, MARIADB, DBPORT, DBNAME, CHROME, PROFILE (a short folder path)
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const env = k => { if (!process.env[k]) { console.log('Missing environment variable ' + k); process.exit(2); } return process.env[k]; };
const BASE = env('BASE'), CAP_BASE = env('CAP_BASE'), REPO = env('REPO');
const MARIADB = env('MARIADB'), DBPORT = env('DBPORT'), DBNAME = env('DBNAME');
const CHROME = env('CHROME'), PROFILE = env('PROFILE');
const labels = JSON.parse(fs.readFileSync(path.join(REPO, 'tools/bingo-scan-testset/labels.json'), 'utf8')).photos;
const photoPath = n => path.join(REPO, 'tools/bingo-scan-testset/photos', n);

const sql = q => execFileSync(MARIADB, ['--no-defaults', '-h127.0.0.1', '-P' + DBPORT, '-uroot', DBNAME, '-N', '-B', '-e', q], { encoding: 'utf8' }).trim();
let failed = 0, checks = 0;
const t = (name, ok, detail) => { checks++; if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && detail !== '' ? ' :: ' + detail : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch(profileSuffix) {
  const dir = PROFILE + profileSuffix;
  fs.rmSync(dir, { recursive: true, force: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: dir, args: ['--no-first-run'], protocolTimeout: 300000 });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  return { browser, page, errors };
}

// Opens the Scan tab and downloads the engine through the page's own button
async function openScanner(page, base) {
  await page.goto(`${base}/Bingo/scan/scan.html`, { waitUntil: 'load' });
  await page.evaluate(() => document.getElementById('tabScan').click());
  await page.waitForSelector('#engineCard:not(.hidden)', { timeout: 20000 });
  await page.click('#engineDownloadBtn');
  await page.waitForFunction(() => EngineLoader.isLoaded(), { timeout: 240000 });
}

// Uploads a photo and reads it; returns the status text
async function scan(page, name) {
  await page.evaluate(() => document.getElementById('tabScan').click());
  await (await page.$('#fileInput')).uploadFile(photoPath(name));
  await page.waitForFunction(() => /Found \d+ of 25|Couldn't find/.test(document.getElementById('status').textContent), { timeout: 60000 });
  await page.click('#ocrBtn');
  await page.waitForFunction(() => /Read in/.test(document.getElementById('status').textContent), { timeout: 120000 });
}

const counts = page => page.evaluate(() => TrainingStore.counts());
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(250); } return false; };
const truth = name => labels[name].labels;

(async () => {
  sql('DELETE FROM bingo_scan_samples');
  let ctx = await launch('a');
  try {
    const { page, errors } = ctx;
    await openScanner(page, BASE);

    // ---- Defaults ----
    const s0 = await page.evaluate(() => TrainingStore.getSettings());
    t('defaults: contributing is on and the photo is not sent', s0.contribute === true && s0.includePhoto === false && s0.noticeSeen === false);
    t('settings card shows both switches in those positions', await page.evaluate(() => document.getElementById('contributeToggle').checked && !document.getElementById('includePhotoToggle').checked));
    t('settings card shows the counts', /Waiting to send: 0 · Sent: 0/.test(await page.$eval('#contributeStatus', e => e.textContent)));

    // ---- First scan: notice, then Apply sends the sample ----
    await scan(page, '20260721_195125.jpg');
    t('first scan: the notice is shown above Apply', await page.$eval('#contributeNotice', e => !e.classList.contains('hidden')));
    t('first scan: the notice says what is sent', /number crops.*not the whole photo/.test(await page.$eval('#contributeNotice', e => e.textContent)));
    await page.click('#contributeNoticeOk');
    t('first scan: OK hides the notice and remembers it', await page.$eval('#contributeNotice', e => e.classList.contains('hidden')) && (await page.evaluate(() => TrainingStore.getSettings())).noticeSeen === true);

    await page.click('#applyOCRBtn');
    t('apply: the sample reaches the database', await waitFor(() => sql('SELECT COUNT(*) FROM bingo_scan_samples') === '1'), 'rows: ' + sql('SELECT COUNT(*) FROM bingo_scan_samples'));
    const row = sql("SELECT profile, reader, app_version, status, uploaded_by IS NULL, photo IS NULL, LENGTH(sheet), HEX(SUBSTRING(sheet,1,3)) FROM bingo_scan_samples").split('\t');
    t('apply: profile, reader, app version and status are recorded', row[0] === 'slider' && /^tesseract@4\.1\.4/.test(row[1]) && row[2] === '2.1' && row[3] === 'new', row.join(' | '));
    t('apply: a guest sample has no username and no photo', row[4] === '1' && row[5] === '1');
    t('apply: the sheet is a real JPEG of a sensible size', row[7] === 'FFD8FF' && Number(row[6]) > 8000 && Number(row[6]) < 100 * 1024, row[6] + ' bytes');
    const cells = JSON.parse(sql('SELECT cells FROM bingo_scan_samples'));
    const want = truth('20260721_195125.jpg');
    t('apply: the 24 confirmed numbers are the card\'s numbers and FREE has no label', cells.length === 25 && cells[12].label === null && cells.every((c, i) => i === 12 || c.label === want[i]));
    t('apply: nothing was corrected by the user (the reader had them all right)', cells.every(c => c.corrected === false) && cells.every((c, i) => i === 12 || c.predicted === c.label));
    const meta = JSON.parse(sql('SELECT meta FROM bingo_scan_samples'));
    t('apply: the window geometry and versions are recorded', meta.geometry.windows >= 20 && meta.geometry.H.length === 9 && meta.versions.decoder && meta.versions.geometry && typeof meta.decoderScore === 'number', JSON.stringify(meta.versions));
    const c1 = await counts(page);
    t('apply: the local copy is deleted after upload and the sent count goes up', c1.queued === 0 && c1.uploaded === 1 && (await page.evaluate(async () => (await new Promise(r => { const q = indexedDB.open('bingo-scan-training'); q.onsuccess = () => { const tx = q.result.transaction('samples'); tx.objectStore('samples').count().onsuccess = e => r(e.target.result); }; }))) === 0));
    t('apply: the settings card shows Sent: 1', await waitFor(async () => /Sent: 1/.test(await page.$eval('#contributeStatus', e => e.textContent))));

    // ---- A scan the user corrects: corrected cells are flagged ----
    await scan(page, '20260721_195121.jpg');
    t('second scan: the notice is not shown again', await page.$eval('#contributeNotice', e => e.classList.contains('hidden')));
    const want2 = truth('20260721_195121.jpg');
    const read2 = await page.evaluate(() => scannedGridData.slice());
    const wrongBefore = read2.filter((v, i) => i !== 12 && v !== want2[i]).length;
    await page.evaluate(w => { w.forEach((v, i) => { if (i !== 12) scannedGridData[i] = v; }); }, want2);   // the user fixes the card
    await page.click('#applyOCRBtn');
    t('corrected scan: it arrives', await waitFor(() => sql('SELECT COUNT(*) FROM bingo_scan_samples') === '2'));
    const cells2 = JSON.parse(sql("SELECT cells FROM bingo_scan_samples ORDER BY created_at DESC LIMIT 1"));
    const flagged = cells2.filter(c => c.corrected).length;
    t('corrected scan: labels are the corrected card', cells2.every((c, i) => i === 12 || c.label === want2[i]));
    t('corrected scan: the cells the user changed are flagged corrected', flagged === wrongBefore && flagged > 0, `${flagged} flagged, ${wrongBefore} were wrong or empty before`);

    // ---- Include the full photo ----
    await page.evaluate(() => { const t = document.getElementById('includePhotoToggle'); t.checked = true; t.dispatchEvent(new Event('change')); });
    t('photo option: switching it on is remembered', (await page.evaluate(() => TrainingStore.getSettings())).includePhoto === true);
    await scan(page, '20260721_195119.jpg');
    await page.click('#applyOCRBtn');
    t('photo option: the sample arrives with a photo', await waitFor(() => sql('SELECT COUNT(*) FROM bingo_scan_samples') === '3'));
    const ph = sql("SELECT HEX(SUBSTRING(photo,1,3)), LENGTH(photo) FROM bingo_scan_samples WHERE photo IS NOT NULL").split('\t');
    t('photo option: it is a JPEG under 300 KB', ph[0] === 'FFD8FF' && Number(ph[1]) > 20000 && Number(ph[1]) <= 300 * 1024, ph.join(' | '));
    await page.evaluate(() => { const t = document.getElementById('includePhotoToggle'); t.checked = false; t.dispatchEvent(new Event('change')); });

    // ---- Offline: waits in the queue, goes out when the connection returns ----
    await scan(page, '20260721_195123.jpg');
    await page.setOfflineMode(true);
    await page.click('#applyOCRBtn');
    await sleep(1500);
    const cOff = await counts(page);
    t('offline: the sample waits in the queue and nothing is sent', cOff.queued === 1 && sql('SELECT COUNT(*) FROM bingo_scan_samples') === '3', JSON.stringify(cOff));
    t('offline: the settings card says it will be sent when back online', await waitFor(async () => /offline/i.test(await page.$eval('#contributeStatus', e => e.textContent))));
    await page.setOfflineMode(false);
    t('offline: when the connection returns the queued sample is sent', await waitFor(() => sql('SELECT COUNT(*) FROM bingo_scan_samples') === '4', 30000) && (await counts(page)).queued === 0);

    // ---- Contribute off: nothing is recorded ----
    await page.evaluate(() => { const t = document.getElementById('contributeToggle'); t.checked = false; t.dispatchEvent(new Event('change')); });
    t('switch off: the photo option is disabled too', await page.$eval('#includePhotoToggle', e => e.disabled));
    await scan(page, '20260721_195831.jpg');
    t('switch off: the notice is not shown', await page.$eval('#contributeNotice', e => e.classList.contains('hidden')));
    await page.click('#applyOCRBtn');
    await sleep(2500);
    t('switch off: Apply records and sends nothing', sql('SELECT COUNT(*) FROM bingo_scan_samples') === '4' && (await counts(page)).queued === 0);
    await page.evaluate(() => { const t = document.getElementById('contributeToggle'); t.checked = true; t.dispatchEvent(new Event('change')); });

    // ---- A scan with almost nothing confirmed is not worth keeping ----
    await scan(page, '20260721_195833.jpg');
    await page.evaluate(() => { for (let i = 0; i < 25; i++) if (i !== 12 && i > 4) scannedGridData[i] = null; });   // only 5 numbers left
    await page.click('#applyOCRBtn');
    await sleep(2000);
    t('thin scan: fewer than 8 confirmed numbers is not recorded', sql('SELECT COUNT(*) FROM bingo_scan_samples') === '4');

    // ---- Export backup: the saved file is exactly what the server accepts ----
    // The test browser cancels every file download (even a 5-byte one), so the download link the app creates is
    // intercepted and its file name and contents are read directly; the browser's own save step is not exercised here.
    await scan(page, '20260721_195838.jpg');
    await page.setOfflineMode(true);
    await page.click('#applyOCRBtn');
    await waitFor(async () => (await counts(page)).queued === 1);
    t('export: the Save waiting samples button is enabled when something waits', await waitFor(async () => !(await page.$eval('#contributeExportBtn', e => e.disabled))));
    await page.evaluate(() => {
      navigator.canShare = undefined;     // use the download path rather than the phone share sheet
      const original = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) { window.__exportName = this.download; window.__exportText = fetch(this.href).then(r => r.text()); return; }
        return original.call(this);
      };
      document.getElementById('tabScan').click();   // Apply switched to the card editor; the settings card is on the Scan tab
    });
    await page.click('#contributeExportBtn');
    await waitFor(() => page.evaluate(() => !!window.__exportName));
    const exportName = await page.evaluate(() => window.__exportName);
    t('export: the file is named bingo-scan-samples-YYYYMMDD.json', /^bingo-scan-samples-\d{8}\.json$/.test(exportName || ''), exportName);
    const exported = exportName ? JSON.parse(await page.evaluate(() => window.__exportText)) : null;
    t('export: it holds the waiting sample with its crops as base64', exported && exported.samples.length === 1 && exported.samples[0].sheet.length > 10000 && exported.samples[0].cells.length === 25);
    await page.setOfflineMode(false);
    await waitFor(async () => (await counts(page)).queued === 0, 30000);   // the live queue also sends it
    sql('DELETE FROM bingo_scan_samples');
    const post = await fetch(`${BASE}/api/training`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exported.samples[0]) });
    t('export: the saved sample can be sent to the server as it is (201)', post.status === 201, post.status + ' ' + (await post.text()).slice(0, 100));
    t('export: Clear exported removes the local copies', await page.evaluate(async () => { await TrainingStore.clearExported(); return (await TrainingStore.counts()).exported === 0; }));

    t('no script errors on the page', errors.length === 0, errors.join(' | '));
  } catch (err) {
    t('first browser session completed', false, String(err && err.stack || err));
  } finally {
    await ctx.browser.close();
  }

  // ---------- A second session against the server with the tiny storage cap ----------
  sql('DELETE FROM bingo_scan_samples');
  ctx = await launch('b');
  try {
    const { page, errors } = ctx;
    await openScanner(page, CAP_BASE);
    await scan(page, '20260721_195125.jpg');
    await page.click('#applyOCRBtn');
    t('full server: the first sample is accepted', await waitFor(() => sql('SELECT COUNT(*) FROM bingo_scan_samples') === '1'));
    await scan(page, '20260721_195119.jpg');
    await page.click('#applyOCRBtn');
    t('full server: the second is refused and pauses sending', await waitFor(async () => !!(await counts(page)).blocked, 30000), JSON.stringify(await counts(page)));
    const cFull = await counts(page);
    t('full server: the sample stays on the device', cFull.queued === 1 && sql('SELECT COUNT(*) FROM bingo_scan_samples') === '1');
    t('full server: the settings card explains the pause', await waitFor(async () => /paused because the collection is full/.test(await page.$eval('#contributeStatus', e => e.textContent))));
    await page.evaluate(() => TrainingStore.drain());
    await sleep(1500);
    t('full server: pressing Send now does not hammer a full server', sql('SELECT COUNT(*) FROM bingo_scan_samples') === '1' && (await counts(page)).queued === 1);
    t('full server: no script errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    t('second browser session completed', false, String(err && err.stack || err));
  } finally {
    await ctx.browser.close();
  }

  console.log(`\n${checks} checks, ${failed ? failed + ' FAILED' : 'all passed'}`);
  process.exit(failed ? 1 : 0);
})();
