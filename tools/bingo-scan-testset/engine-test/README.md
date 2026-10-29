# Engine cache test (step 1.1)

Drives a real Chrome through the scanner's download-once behavior and checks:
1. First visit shows the "Scanner download" card and fetches nothing from `engine/` until the user presses Download.
2. After the download, the engine cache holds the files and Tesseract and OpenCV run from them.
3. Changing `SW_VERSION` (the test serves a bumped copy of `sw.js`, the real file is untouched) keeps the engine cache and requests no engine file from the server again.
4. With the network switched off, the page reloads and OCR still works.

`last-result.json` is the output of the last passing run (15 checks).

## Running it
1. In an empty folder outside the repo, run `npm install puppeteer-core@23` (set `PUPPETEER_SKIP_DOWNLOAD=1`; the test uses the installed Chrome).
2. Copy `server.js` and `engine-test.js` into that folder.
3. Start the server: `node server.js <repo root> <output folder> 8766`
4. Run: `node engine-test.js <output folder>`

Notes:
- The browser profile folder in `engine-test.js` must be a short path. Chrome nests deep folders inside it, and a long path fails with a Cache Storage "internal error" on Windows.
- The Chrome path in `engine-test.js` is for Windows; change it for other systems.
- The first run downloads about 20 MB (OpenCV comes from docs.opencv.org).
