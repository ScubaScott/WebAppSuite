/**
 * ScoreBoard theme selector: the background-image dropdown in Settings.
 * The catalog of themes lives in scoreboard-shared.js; this file lists the images and applies the choice.
 */

const IMAGE_LIST_KEY = 'scoreboard_discovered_bgimages';
const DEFAULT_IMAGES = ['EdenPrarie.png', 'MinnesotaStars.png', 'NewPrague.png', 'chill.png', 'saber.png'];
const IMAGE_PATTERN = /^[A-Za-z0-9._-]+\.(png|jpe?g|webp|svg|gif)$/i;

const byId = (id) => document.getElementById(id);
const sortImages = (names) => Array.from(new Set(names))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

/** Human-readable label for an image file name. */
export function formatImageLabel(filename) {
    const base = filename.replace(/\.[^/.]+$/, '');
    const words = base.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * @param {{getTheme: function(): string, setTheme: function(string): void}} options
 */
export function createThemeSelector({ getTheme, setTheme }) {
    const catalog = window.ScoreBoardShared.SCOREBOARD_THEMES;
    let images = [...DEFAULT_IMAGES];

    // Images found on an earlier visit are available immediately, even offline
    try {
        const cached = JSON.parse(localStorage.getItem(IMAGE_LIST_KEY) || '[]');
        if (Array.isArray(cached)) images = sortImages([...images, ...cached.filter((name) => IMAGE_PATTERN.test(name))]);
    } catch (error) {
        // Use the default list
    }

    const dropdown = () => byId('theme-dropdown');
    const trigger = () => byId('theme-dropdown-trigger');

    /** The image file and label for a theme key or a bare image name. */
    function describe(theme) {
        if (catalog[theme]) return { image: catalog[theme].image, label: catalog[theme].label || formatImageLabel(catalog[theme].image) };
        if (IMAGE_PATTERN.test(theme)) return { image: theme, label: formatImageLabel(theme) };
        return { image: 'saber.png', label: 'Saber' };
    }

    /** Update the closed button and the highlighted option. */
    function update() {
        const thumb = byId('theme-trigger-thumb');
        const label = byId('theme-trigger-label');
        if (!thumb || !label) return;
        const current = describe(getTheme());
        thumb.style.backgroundImage = `url('media/bgimages/${encodeURIComponent(current.image)}')`;
        label.textContent = current.label;
        document.querySelectorAll('.theme-dropdown-item').forEach((item) => {
            const active = item.dataset.value === current.image || item.dataset.value === getTheme();
            item.classList.toggle('active', active);
            item.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }

    function close() {
        const box = dropdown();
        if (box) box.classList.remove('open');
        if (trigger()) trigger().setAttribute('aria-expanded', 'false');
    }

    function choose(image) {
        setTheme(image);
        update();
        close();
    }

    /** Draw one option per available image. */
    function render() {
        const menu = byId('theme-dropdown-menu');
        if (!menu) return;
        menu.innerHTML = '';
        images.forEach((image) => {
            const item = document.createElement('div');
            item.className = 'theme-dropdown-item';
            item.setAttribute('role', 'option');
            item.setAttribute('tabindex', '0');
            item.dataset.value = image;

            const left = document.createElement('div');
            left.className = 'theme-item-left';
            const thumb = document.createElement('div');
            thumb.className = 'theme-item-thumb';
            thumb.style.backgroundImage = `url('media/bgimages/${encodeURIComponent(image)}')`;
            const info = document.createElement('div');
            info.className = 'theme-item-info';
            const name = document.createElement('span');
            name.className = 'theme-item-name';
            name.textContent = formatImageLabel(image);
            const file = document.createElement('span');
            file.className = 'theme-item-filename';
            file.textContent = image;
            info.append(name, file);
            left.append(thumb, info);

            const check = document.createElement('span');
            check.className = 'theme-item-check';
            check.textContent = '✓';
            item.append(left, check);

            item.addEventListener('click', (event) => { event.stopPropagation(); choose(image); });
            item.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    choose(image);
                }
            });
            menu.appendChild(item);
        });
        update();
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
                render();
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
