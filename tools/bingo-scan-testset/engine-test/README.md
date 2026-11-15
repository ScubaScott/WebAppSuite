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
(`node e2e-scan-test.js <repo root> <output folder>`). `e2e-last-result.json` is the last passing run (35 checks, including a photo the decoder improves from 17 to 22 correct).

## Guided capture and review screen (steps 1.7 and 1.8)
`live-capture-test.js <repo root> <fake camera folder>` runs the Scan page with Chrome's fake camera playing a video file and checks the outline, the hint line, auto-capture of a steady card (about 1 s), no capture for a moving, wobbling or windowless picture, the Auto-capture switch, the cooldown after Reset, and the manual shutter. Make the four videos first with `python make-fake-camera.py <photo> <out.y4m> steady|moving|shaky` (steady, moving and shaky from `20260721_195125.jpg`, plus a steady one named `paper.y4m` from `20251109_162316_a.jpg`). Last passing run: `live-capture-last-result.json` (27 checks).

`review-ui-test.js <repo root> <output folder>` runs the review screen in a phone-sized window: cell states and the summary line against a real photo, settling cells, the profile chip and its two overrides, covered cells, picker suggestions, and Retake / Adjust corners for a photo with no card. Last passing run: `review-ui-last-result.json` (28 checks).

Both need the same dev server as above. These tests use a fresh browser profile folder per run; delete it between runs if the engine card must show again (`e2e-scan-test.js` and `engine-test.js` expect a first visit).

## Phone-speed estimate
`throttle-bench.js <port> <rate> <output folder>` runs the benchmark page under Chrome's CPU throttling (a bench
server that writes `result.json`, like the one used for the baselines, must be listening). Chrome's throttle slows
the page but not the recognizer's worker thread, so multiply the worker's `recognizeMs + retryMs` by the rate by hand
(see section 10.1 of the spec).
