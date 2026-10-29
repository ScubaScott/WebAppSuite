// Card profiles version identifier
const PROFILES_VERSION = '1.3';

// Card profiles describe how the scanner finds the 5x5 number grid on one physical card format.
// geometry.js reads these plain objects; adding a format means adding an object here (plus test photos).
//
// Fields:
//   anchor         what the detector looks for: 'window' (bright number windows) or 'corners' (user-placed)
//   detectMaxDim   longest side, in pixels, of the copy of the photo used for detection
//   maskModes      ways of separating windows from the card, tried in order; the first result that meets
//                  `goodEnough` ends the search, otherwise the best-scoring one wins. Modes: 'local:CH:F:C' compares
//                  channel CH (b, g, r or min of R,G,B) with the average of a neighborhood F x the picture's long
//                  side wide and needs it to be brighter by C; 'min-otsu2' uses a global threshold chosen among the brighter pixels only.
//   blob           limits for a bright blob to count as a window (area as a fraction of the picture,
//                  width/height ratio, minimum fill of its bounding box)
//   areaBand       accepted window area relative to the reference window area (min, max)
//   lattice        grid rules: windows needed, largest average error as a fraction of the window spacing,
//                  how far from its predicted spot a neighbor may sit (fraction of spacing)
//   cell           canonical cell crop: size in pixels, edge inset (fraction of the measured window per side;
//                  the measured window is the bright interior, so the inset stays small to keep two-digit numbers whole),
//                  default window width and height as fractions of the cell spacing, used when they cannot be measured
//                  (manual corners); the slider values are the medians measured on the test photos (0.466 x 0.54)
//   checks         per-cell checks: closed-shutter tint and glare
const CardProfiles = {
    slider: {
        id: 'slider',
        label: 'Slider card',
        anchor: 'window',
        detectMaxDim: 1400,
        maskModes: ['local:b:0.06:25', 'local:b:0.10:25', 'local:b:0.16:25', 'local:min:0.06:12', 'local:min:0.10:12', 'min-otsu2'],
        blob: { minAreaFrac: 0.00015, maxAreaFrac: 0.012, aspect: [0.6, 1.6], minFill: 0.6, maxHoleFrac: 0.004 },
        areaBand: [0.4, 2.5],
        lattice: { minWindows: 16, maxError: 0.08, neighborTol: 0.35, goodEnough: { windows: 22, error: 0.05 } },
        cell: { size: { w: 72, h: 80 }, aspect: 0.9, inset: 0.02, windowFrac: 0.466, windowFracY: 0.54 },
        checks: { shutterTint: true, glare: true }
    },

    // Always available: the user places four handles on the centers of the four corner windows
    manual: {
        id: 'manual',
        label: 'Manual',
        anchor: 'corners',
        cell: { size: { w: 72, h: 80 }, aspect: 0.9, inset: 0.02, windowFrac: 0.466, windowFracY: 0.54 },
        checks: { shutterTint: true, glare: true }
    },

    // Profiles tried automatically, in order of preference (manual is never auto-selected)
    autoOrder: ['slider']
};
