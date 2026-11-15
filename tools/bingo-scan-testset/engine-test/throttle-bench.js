// Runs the benchmark page in Chrome with CPU throttling to approximate a slower phone.
// Usage: node throttle-bench.js <port> <rate> <outDir>   (a bench server must already be listening on <port>)
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const [port, rate, outDir] = [process.argv[2], Number(process.argv[3]), process.argv[4]];
(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
    userDataDir: 'C:/Users/scott/AppData/Local/Temp/bgth' + rate, args: ['--no-first-run'], protocolTimeout: 900000
  });
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  // Also throttle every worker the page starts (Tesseract runs in one)
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  browser.on('targetcreated', async target => {
    try {
      if (target.type() === 'worker' || target.type() === 'other') {
        const s = await target.createCDPSession();
        await s.send('Emulation.setCPUThrottlingRate', { rate }).catch(() => {});
      }
    } catch (e) { /* not all targets accept it */ }
  });
  await page.goto(`http://localhost:${port}/htdocs/Bingo/scan/bench.html?auto=1&profiles=slider`, { waitUntil: 'load' });
  const result = path.join(outDir, 'result.json');
  const started = Date.now();
  while (!fs.existsSync(result) || fs.statSync(result).size === 0) {
    if (Date.now() - started > 800000) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 2000));
  }
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
