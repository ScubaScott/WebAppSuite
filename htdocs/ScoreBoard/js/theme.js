/**
 * ScoreBoard theme selector: the background dropdown in the New Game / Edit Match dialog.
 * The catalog of themes and the custom theme helpers live in shared.js, the custom photos in
 * custom-photos.js; this file lists the choices and applies the pick through the setTheme callback.
 */

import { SCOREBOARD_THEMES, customThemeKey, parseCustomTheme, customBackground } from './shared.js';
import { getPhotoUrl, listPhotos, deletePhoto } from './custom-photos.js';

const IMAGE_LIST_KEY = 'scoreboard_discovered_bgimages';
const DEFAULT_IMAGES = ['EdenPrarie.png', 'MinnesotaStars.png', 'NewPrague.png', 'chill.png', 'saber.png'];
const IMAGE_PATTERN = /^[A-Za-z0-9._-]+\.(png|jpe?g|webp|svg|gif)$/i;
const FALLBACK_CUSTOM_COLOR = '#1e3a8a';

const byId = (id) => document.getElementById(id);
const sortImages = (names) => Array.from(new Set(names))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

/** Human-readable label for an image file name. */
function formatImageLabel(filename) {
    const base = filename.replace(/\.[^/.]+$/, '');
    const words = base.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

// Counts thumbnail paints, so a photo that loads late never lands on a thumbnail that has moved on
let paintCounter = 0;

/** Paints a custom look on an element: the color gradient at once, then the photo when it loads. */
function paintCustomThumb(element, color, photoId) {
    const paintId = String(++paintCounter);
    element.dataset.paintId = paintId;
    const look = customBackground(color);
    element.style.backgroundImage = look.image;
    if (!photoId) return;
    getPhotoUrl(photoId).then((url) => {
        if (url && element.dataset.paintId === paintId) {
            element.style.backgroundImage = `url("${url}"), ${look.image}`;
        }
    });
}

/** Paints a built-in background image on an element. */
function paintImageThumb(element, image) {
    element.dataset.paintId = '';
    element.style.backgroundImage = `url('media/bgimages/${encodeURIComponent(image)}')`;
}

/**
 * @param {{
 *   getTheme: function(): string,
 *   setTheme: function(string): void,
 *   getSeedColor: function(): string
 * }} options `getSeedColor` gives the color a new custom theme starts with ('#rrggbb').
 */
export function createThemeSelector({ getTheme, setTheme, getSeedColor }) {
    const catalog = SCOREBOARD_THEMES;
    let images = [...DEFAULT_IMAGES];
    // Custom photos saved on this device, newest first: [{ id, color, name }]
    let photos = [];

    // Images found on an earlier visit are available immediately, even offline
    try {
        const cached = JSON.parse(localStorage.getItem(IMAGE_LIST_KEY) || '[]');
        if (Array.isArray(cached)) images = sortImages([...images, ...cached.filter((name) => IMAGE_PATTERN.test(name))]);
    } catch (error) {
        // Use the default list
    }

    const dropdown = () => byId('theme-dropdown');
    const trigger = () => byId('theme-dropdown-trigger');

    /** The image file and label for a catalog key or a bare image name. */
    function describe(theme) {
        if (catalog[theme]) return { image: catalog[theme].image, label: catalog[theme].label || formatImageLabel(catalog[theme].image) };
        if (IMAGE_PATTERN.test(theme)) return { image: theme, label: formatImageLabel(theme) };
        return { image: 'saber.png', label: 'Saber' };
    }

    /** The color a custom theme would use now: the current custom color, else the seed color. */
    function currentCustomColor() {
        const custom = parseCustomTheme(getTheme());
        return custom ? custom.color : (customThemeKey(getSeedColor()) ? getSeedColor() : FALLBACK_CUSTOM_COLOR);
    }

    /** The value of the menu item that matches the current theme (or null for a built-in image). */
    function activeCustomValue() {
        const custom = parseCustomTheme(getTheme());
        if (!custom) return null;
        return custom.photoId ? `photo:${custom.photoId}` : 'custom';
    }

    /** Update the closed button and the highlighted option. */
    function update() {
        const thumb = byId('theme-trigger-thumb');
        const label = byId('theme-trigger-label');
        if (!thumb || !label) return;

        const custom = parseCustomTheme(getTheme());
        if (custom) {
            paintCustomThumb(thumb, custom.color, custom.photoId);
            const photo = custom.photoId ? photos.find((entry) => entry.id === custom.photoId) : null;
            label.textContent = photo ? `My background: ${photo.name}` : (custom.photoId ? 'My background' : 'Custom color');
        } else {
            const current = describe(getTheme());
            paintImageThumb(thumb, current.image);
            label.textContent = current.label;
        }

        const activeCustom = activeCustomValue();
        document.querySelectorAll('.theme-dropdown-item').forEach((item) => {
            const active = activeCustom
                ? item.dataset.value === activeCustom
                : (item.dataset.value === describe(getTheme()).image || item.dataset.value === getTheme());
            item.classList.toggle('active', active);
            item.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }

    function close() {
        const box = dropdown();
        if (box) box.classList.remove('open');
        if (trigger()) trigger().setAttribute('aria-expanded', 'false');
    }

    function choose(theme) {
        setTheme(theme);
        update();
        close();
    }

    /**
     * Builds one option.
     * @param {{value: string, paint: function(HTMLElement): void, name: string, detail: string,
     *   onChoose: function(): void, onRemove?: function(): void, removeLabel?: string}} spec
     */
    function makeItem({ value, paint, name, detail, onChoose, onRemove, removeLabel }) {
        const item = document.createElement('div');
        item.className = 'theme-dropdown-item';
        item.setAttribute('role', 'option');
        item.setAttribute('tabindex', '0');
        item.dataset.value = value;

        const left = document.createElement('div');
        left.className = 'theme-item-left';
        const thumb = document.createElement('div');
        thumb.className = 'theme-item-thumb';
        paint(thumb);
        const info = document.createElement('div');
        info.className = 'theme-item-info';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'theme-item-name';
        nameSpan.textContent = name;
        const detailSpan = document.createElement('span');
        detailSpan.className = 'theme-item-filename';
        detailSpan.textContent = detail;
        info.append(nameSpan, detailSpan);
        left.append(thumb, info);

        const check = document.createElement('span');
        check.className = 'theme-item-check';
        check.textContent = '✓';
        item.append(left, check);

        if (onRemove) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'theme-item-remove';
            remove.textContent = '🗑';
            remove.setAttribute('aria-label', removeLabel || 'Delete');
            remove.addEventListener('click', (event) => { event.stopPropagation(); onRemove(); });
            item.appendChild(remove);
        }

        item.addEventListener('click', (event) => { event.stopPropagation(); onChoose(); });
        item.addEventListener('keydown', (event) => {
            if (event.target === item && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                onChoose();
            }
        });
        return item;
    }

    /** Delete a saved photo after confirmation; a game using it falls back to its color. */
    async function removePhoto(photo) {
        const ok = await SuiteDialog.confirm(
            `Delete the photo "${photo.name}" from this device? Games that use it will show their color instead.`,
            { title: 'Delete photo?', confirmLabel: 'Delete photo', danger: true, defaultCancel: true }
        );
        if (!ok) return;
        await deletePhoto(photo.id);
        const custom = parseCustomTheme(getTheme());
        if (custom && custom.photoId === photo.id) setTheme(customThemeKey(custom.color));
        photos = photos.filter((entry) => entry.id !== photo.id);
        draw();
    }

    /** Draw the options: custom color, saved photos, then one per built-in image. */
    function draw() {
        const menu = byId('theme-dropdown-menu');
        if (!menu) return;
        menu.innerHTML = '';

        menu.appendChild(makeItem({
            value: 'custom',
            paint: (thumb) => paintCustomThumb(thumb, currentCustomColor(), null),
            name: 'Custom color',
            detail: 'Pick any color',
            onChoose: () => choose(customThemeKey(currentCustomColor()))
        }));

        photos.forEach((photo) => {
            menu.appendChild(makeItem({
                value: `photo:${photo.id}`,
                paint: (thumb) => paintCustomThumb(thumb, photo.color, photo.id),
                name: `My background: ${photo.name}`,
                detail: 'Photo on this device',
                onChoose: () => choose(customThemeKey(photo.color, photo.id)),
                onRemove: () => removePhoto(photo),
                removeLabel: `Delete photo ${photo.name}`
            }));
        });

        images.forEach((image) => {
            menu.appendChild(makeItem({
                value: image,
                paint: (thumb) => paintImageThumb(thumb, image),
                name: formatImageLabel(image),
                detail: image,
                onChoose: () => choose(image)
            }));
        });
        update();
    }

    /** Read the photos saved on this device, then redraw. */
    async function refreshPhotos() {
        photos = await listPhotos();
        draw();
    }

    /** Draw the options now and load the saved photos in the background. */
    function render() {
        draw();
        refreshPhotos();
    }

    /** Ask the server for the images in media/bgimages and add any new ones. */
    async function discover() {
        try {
            const response = await fetch('media/bgimages/list.php', { cache: 'no-cache' });
            if (!response.ok) return;
            const data = await response.json();
            if (data && Array.isArray(data.images) && data.images.length > 0) {
                images = sortImages([...images, ...data.images.filter((name) => IMAGE_PATTERN.test(name))]);
                try { localStorage.setItem(IMAGE_LIST_KEY, JSON.stringify(images)); } catch (error) { /* storage full */ }
                draw();
            }
        } catch (error) {
            // Keep the default or cached list when the server cannot be reached
        }
    }

    if (trigger()) {
        trigger().addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const open = dropdown().classList.toggle('open');
            trigger().setAttribute('aria-expanded', open ? 'true' : 'false');
        });
    }
    // Clicking anywhere else closes the menu
    document.addEventListener('click', (event) => {
        if (dropdown() && !dropdown().contains(event.target)) close();
    });

    return { render, update, discover, close };
}
