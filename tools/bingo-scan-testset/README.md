# Bingo scan test set

Hand-labeled photos used to measure the card scanner (see `htdocs/Bingo/bingo-scan-redesign-spec.md`, section 10). Nothing in `tools/` is deployed.

- `photos/` holds the images. It is git-ignored because the photos show people and a venue; copy it between machines yourself (it is inside the OneDrive project folder).
- `labels.json` holds the correct numbers for each photo, tracked in git.

## Rules
- `split: "tune"` photos may be used while tuning detection settings.
- `split: "holdout"` photos are only run to check results. Never tune on them and never use them for model training.
- The 9 current photos all show one card (`crazy-1`). Add photos of other cards with a new `card` id so accuracy can be reported per card.
- `hardCells` lists numbers that are washed out by glare or tint in that photo.
- `labelStatus`: `checked` means the labels were verified against several photos. `needs-review` means they were read from a single photo; confirm them by eye, then change the value to `checked`. The benchmark should leave `needs-review` photos out of its headline scores.
- `source` names the original photo when the file is a crop (`*_crop.jpg`, `*_a/_b/_c.jpg`, `*_br.jpg`, `*_red.jpg`). Crops keep the card, its neighbors and some background; they are not tight crops, so detection still has to find the card. Originals are kept.
- The `unlabeled` section lists photos that are in `photos/` but not usable yet, with the reason.
- `profile`: `slider` is the supported format. `paper-grid` photos exist for the future paper profile (spec section 7.2) and are not scored until that profile is built.

## Running the benchmark
- **By hand:** open `htdocs/Bingo/scan/bench.html` from the site (or any web server), choose `labels.json` plus the photos, and press Run.
- **Automatically:** serve the repo root on `http://localhost` and open `htdocs/Bingo/scan/bench.html?auto=1`. The page then fetches this folder from `/tools/bingo-scan-testset/` and posts its results to `/bench-result` and `/bench-progress` on the same server (a small throwaway server is enough; nothing is stored by the repo).
- Add `&profiles=slider` to run only one profile.
- Saved runs go in `baselines/`. `0.2-current-pipeline.json` is the baseline for the original Tesseract + OpenCV scanner.

## Adding a photo
1. Put the file in `photos/`.
2. Add an entry to `labels.json` with the 25 values in row-major order (B-I-N-G-O columns, `"FREE"` at index 12).
3. Pick the `profile` (`slider`, or `manual` for formats without a profile yet) and a `split`.
