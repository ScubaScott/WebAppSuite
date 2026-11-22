// Tests for the custom theme helpers in js/shared.js: keys, parsing and the generated CSS background.
// Run from htdocs/ScoreBoard: node --test tests/theme.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCOREBOARD_THEMES, customThemeKey, parseCustomTheme, customBackground } from '../js/shared.js';

/** Every lightness percentage found in the hsl() colors of a CSS value. */
const lightnesses = (css) => [...css.matchAll(/hsl\(\d+ \d+% (\d+)%\)/g)].map((match) => Number(match[1]));

test('a custom key round-trips, with or without a photo', () => {
    assert.equal(customThemeKey('#1E3A8A'), 'custom-1e3a8a');
    assert.equal(customThemeKey('#1e3a8a', '7f3c9a2b'), 'custom-1e3a8a-p7f3c9a2b');
    assert.deepEqual(parseCustomTheme('custom-1e3a8a'), { color: '#1e3a8a', photoId: null });
    assert.deepEqual(parseCustomTheme('custom-1e3a8a-p7f3c9a2b'), { color: '#1e3a8a', photoId: '7f3c9a2b' });
});

test('the color may be given without a hash or with spaces around it', () => {
    assert.equal(customThemeKey('FFAA00'), 'custom-ffaa00');
    assert.equal(customThemeKey('  #ffaa00 '), 'custom-ffaa00');
});

test('a bad color or photo id gives no key', () => {
    ['', null, undefined, 'zzzzzz', '#12345', '#1234567', 'red'].forEach((color) => {
        assert.equal(customThemeKey(color), null, String(color));
    });
    ['ABCDEF12', '1234567', '123456789', 'g1234567'].forEach((photoId) => {
        assert.equal(customThemeKey('#1e3a8a', photoId), null, photoId);
    });
});

test('a custom key is a safe theme name of at most 64 characters', () => {
    const key = customThemeKey('#1e3a8a', '7f3c9a2b');
    assert.ok(key.length <= 64);
    assert.match(key, /^[A-Za-z0-9._-]+$/);
});

test('only well-formed custom keys are read', () => {
    ['saber-dark', 'EdenPrarie.png', 'custom-1E3A8A', 'custom-1e3a8', 'custom-1e3a8a-p123', 'custom-1e3a8a-7f3c9a2b',
        'custom-1e3a8a-p7f3c9a2b-x', '../custom-1e3a8a', '', null, undefined, 42].forEach((value) => {
        assert.equal(parseCustomTheme(value), null, String(value));
    });
});

test('no catalog theme uses the reserved custom prefix', () => {
    Object.keys(SCOREBOARD_THEMES).forEach((key) => assert.ok(!key.startsWith('custom-'), key));
});

test('the background is a layered gradient, never a flat fill or a url', () => {
    const { image, color } = customBackground('#1e3a8a');
    assert.equal(image.match(/radial-gradient/g).length, 2);
    assert.match(image, /repeating-linear-gradient/);
    assert.match(image, /linear-gradient\(160deg/);
    assert.doesNotMatch(image, /url\(|;|"|'|</);
    assert.match(color, /^hsl\(\d+ \d+% \d+%\)$/);
});

test('hue and saturation follow the chosen color', () => {
    assert.match(customBackground('#ff0000').image, /linear-gradient\(160deg, hsl\(0 100% 38%\)/);
    assert.match(customBackground('#0000ff').image, /linear-gradient\(160deg, hsl\(240 100% 38%\)/);
    assert.match(customBackground('#00ff00').image, /linear-gradient\(160deg, hsl\(120 100% 38%\)/);
});

test('light and dark colors are held to a readable range', () => {
    // The base lightness is 18% to 38%; the gradient stops add 16 and subtract 12 or 14 around it
    ['#ffffff', '#ffff00', '#000000', '#1e3a8a', '#fb923c'].forEach((hex) => {
        const { image, color } = customBackground(hex);
        const all = [...lightnesses(image), ...lightnesses(color)];
        assert.ok(Math.max(...all) <= 54, `${hex} too light`);
        assert.ok(Math.min(...all) >= 4, `${hex} too dark`);
    });
    assert.match(customBackground('#ffffff').image, /linear-gradient\(160deg, hsl\(0 0% 38%\)/);
    assert.match(customBackground('#000000').image, /linear-gradient\(160deg, hsl\(0 0% 18%\)/);
});
