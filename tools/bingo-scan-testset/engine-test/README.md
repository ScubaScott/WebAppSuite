# Engine cache test (step 1.1)

Drives a real Chrome through the scanner's download-once behavior and checks:
1. First visit shows the "Scanner download" card and fetches nothing from `engine/` until the user presses Download.
2. After the download, the engine cache holds exactly the four Tesseract files, Tesseract reads digits from them, and a leftover cache entry from the retired OpenCV is deleted.
3. Changing `SW_VERSION` (the test serves a bumped copy of `sw.js`, the real file is untouched) keeps the engine cache and requests no engine file from the server again.
4. With the network switched off, the page reloads and OCR still works.

`last-result.json` is the output of the last passing run (17 checks).

## Running it
1. In an empty folder outside the repo, run `npm install puppeteer-core@23` (set `PUPPETEER_SKIP_DOWNLOAD=1`; the test uses the installed Chrome).
2. Copy `server.js` and `engine-test.js` into that folder.
3. Start the server: `node server.js <repo root> <output folder> 8766`
4. Run: `node engine-test.js <output folder>`

Notes:
- The browser profile folder in `engine-test.js` must be a short path. Chrome nests deep folders inside it, and a long path fails with a Cache Storage "internal error" on Windows.
- The Chrome path in `engine-test.js` is for Windows; change it for other systems.
- The first run downloads about 10 MB (the Tesseract files served from the repo).

## End-to-end Scan page test
`e2e-scan-test.js` drives the real Scan page: it downloads the engine through the page's own button, uploads two
labeled photos, checks that the windows are found automatically, reads the numbers, compares the review grid with
`labels.json`, switches on Show detection, opens and applies the manual corner handles, reads again, and uploads a
picture with no card. It needs the same dev server as above plus the photos in `../photos/`
(`node e2e-scan-test.js <repo root> <output folder>`). `e2e-last-result.json` is the last passing run (25 checks).

## Phone-speed estimate
`throttle-bench.js <port> <rate> <output folder>` runs the benchmark page under Chrome's CPU throttling (a bench
server that writes `result.json`, like the one used for the baselines, must be listening). Chrome's throttle slows
the page but not the recognizer's worker thread, so multiply the worker's `recognizeMs + retryMs` by the rate by hand
(see section 10.1 of the spec).
