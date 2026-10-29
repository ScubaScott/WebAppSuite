// Exit-criteria test for step 1.1, driven through real Chrome.
//  A. first visit: scanner card offers a download; download fills the engine cache
//  B. Tesseract + OpenCV run from the cache
//  C. SW_VERSION bump: engine cache survives and no engine file is requested from the server again
//  D. offline reload: page, engine and OCR still work
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2];
const base = 'http://localhost:8766/htdocs/';
const log = [];
const check = (name, ok, detail) => { log.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const requests = () => fs.readFileSync(path.join(outDir, 'requests.log'), 'utf8').split('\n').filter(Boolean);
const engineRequests = from => requests().slice(from).filter(l => l.includes('/Bingo/scan/engine/') && !l.endsWith('/manifest.json'));

// Recognizes digits drawn on a canvas using the engine-cache files only
const OCR_PROBE = `(async () => {
  const c = document.createElement('canvas'); c.width = 300; c.height = 120;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 300, 120);
  g.fillStyle = '#000'; g.font = 'bold 90px Arial'; g.fillText('47', 80, 95);
  const w = await Tesseract.createWorker(EngineLoader.tesseractOptions());
  await w.loadLanguage('eng'); await w.initialize('eng');
  await w.setParameters({ tessedit_char_whitelist: '0123456789' });
  const r = await w.recognize(c); await w.terminate();
  return { text: r.data.text.trim(), cvMat: typeof cv !== 'undefined' && typeof cv.Mat === 'function' };
})()`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    userDataDir: 'C:/Users/scott/AppData/Local/Temp/bgp1',
    args: ['--no-first-run'], protocolTimeout: 300000
  });
  try {
    const page = await browser.newPage();
    const external = [];
    page.on('response', r => {
      const u = r.url();
      if (!u.startsWith('http://localhost')) external.push({ url: u, fromSW: r.fromServiceWorker() });
    });
    page.on('pageerror', e => console.log('pageerror:', e.message));

    // Register the service worker from the launcher page, then reload so pages are controlled
    await page.goto(base + 'index.html', { waitUntil: 'load' });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.goto(base + 'Bingo/scan/scan.html', { waitUntil: 'load' });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'load' });
    check('page controlled by service worker', await page.evaluate(() => !!navigator.serviceWorker.controller));

    // A. download card
    await page.waitForSelector('#engineCard:not(.hidden)', { timeout: 15000 });
    const cardText = await page.$eval('#engineText', e => e.textContent);
    check('A: download card shown on first visit', /one-time download of/.test(cardText), cardText);
    check('A: nothing from the engine folder fetched before the user asks', engineRequests(0).length === 0, engineRequests(0).join(', '));

    await page.evaluate(() => document.getElementById('tabScan').click());
    await page.click('#engineDownloadBtn');
    await page.waitForFunction(() => EngineLoader.isLoaded(), { timeout: 240000 });
    check('A: card hidden after download', await page.$eval('#engineCard', e => e.classList.contains('hidden')));
    const keys = await page.evaluate(async () => (await (await caches.open('bingo-scan-engine')).keys()).map(r => r.url));
    check('A: engine cache holds 5 files (4 local + OpenCV)', keys.length === 5, keys.map(k => k.split('/').pop()).join(', '));
    check('A: persist() call did not block the download', true);

    // B. engines run from the cache
    const probe = await page.evaluate(OCR_PROBE);
    check('B: Tesseract recognizes digits from cached files', probe.text === '47', JSON.stringify(probe));
    check('B: OpenCV is initialized', probe.cvMat);

    // C. service worker version bump
    const mark = requests().length;
    fs.writeFileSync(path.join(outDir, 'bump.flag'), '1');
    await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
    await page.waitForFunction(async () => (await caches.keys()).some(k => k.includes('v99.9')), { timeout: 30000 });
    await sleep(1500);
    const cacheNames = await page.evaluate(() => caches.keys());
    check('C: new app cache created, old one removed', cacheNames.some(k => k.endsWith('v99.9')) && !cacheNames.some(k => k.endsWith('v4.7')), cacheNames.join(', '));
    check('C: engine cache survived the version bump', cacheNames.includes('bingo-scan-engine'));
    external.length = 0;
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => EngineLoader.isLoaded(), { timeout: 60000 });
    check('C: no engine file requested from the server after the bump', engineRequests(mark).length === 0, engineRequests(mark).join(', '));
    const opencvResp = external.filter(e => e.url.includes('docs.opencv.org'));
    check('C: OpenCV served by the service worker, not the network', opencvResp.length > 0 && opencvResp.every(e => e.fromSW), JSON.stringify(opencvResp));
    check('C: card stays hidden (no re-download prompt)', await page.$eval('#engineCard', e => e.classList.contains('hidden')));

    // D. offline
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => EngineLoader.isLoaded(), { timeout: 60000 });
    check('D: offline reload loads page and engine', true);
    const probe2 = await page.evaluate(OCR_PROBE);
    check('D: offline OCR works', probe2.text === '47' && probe2.cvMat, JSON.stringify(probe2));
    await page.setOfflineMode(false);
  } catch (err) {
    check('test run completed without error', false, String(err && err.stack || err));
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(outDir, 'etest-result.json'), JSON.stringify(log, null, 2));
    process.exit(log.every(l => l.ok) ? 0 : 1);
  }
})();
