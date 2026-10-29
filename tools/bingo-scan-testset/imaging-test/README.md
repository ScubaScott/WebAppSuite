# Imaging and geometry unit tests

Node-only tests with synthetic images; no browser needed.

- `imaging-test.js` checks the numeric functions in `htdocs/Bingo/scan/imaging.js` (grayscale, blur, thresholds,
  morphology, connected regions, hole filling, color masks, homography solving and fitting, perspective warp).

      node tools/bingo-scan-testset/imaging-test/imaging-test.js htdocs/Bingo/scan/imaging.js

- `geometry-test.js` checks the window finder in `htdocs/Bingo/scan/geometry.js` on rendered slider cards: upright,
  tilted with perspective, closed shutters, clutter (a bright screen and loose squares), too few windows, a whole
  missing column (must be rejected as ambiguous), an empty picture, and manual corner placement.

      node tools/bingo-scan-testset/imaging-test/geometry-test.js htdocs/Bingo/scan

The canvas helpers (warp, overlay, crops) need a browser and are covered by `../engine-test/` and by the
detection-only benchmark (`bench.html?auto=1&geometry=1`, add `&sheet=1` for the crop sheets).
