# Imaging module unit tests

Checks the numeric functions in `htdocs/Bingo/scan/imaging.js` (grayscale, blur, thresholds, morphology,
connected regions, color masks, homography, perspective warp) with small synthetic images. Needs only Node.

    node tools/bingo-scan-testset/imaging-test/imaging-test.js htdocs/Bingo/scan/imaging.js

The canvas helpers at the bottom of `imaging.js` need a browser and are covered by `../engine-test/`.
