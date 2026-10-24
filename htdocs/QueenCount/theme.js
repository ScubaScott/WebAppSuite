// QueenCount theme loader: applies the saved theme to <html data-theme> before first paint.
// Exposes `QCTheme` for the settings modal. The choice is a per-device preference kept in localStorage.
(function () {
  const KEY = 'queencount.theme';
  const DEFAULT_THEME = 'queen';
  // id, label and the browser toolbar color for each theme
  const THEMES = [
    { id: 'queen', label: '\u2665 Queen of Hearts', color: '#3d0710' },
    { id: 'dark', label: '\uD83C\uDF19 Dark', color: '#0e0a18' }
  ];

  // Saved theme id, or the default when nothing valid is stored or storage is blocked
  function get() {
    try {
      const v = localStorage.getItem(KEY);
      if (THEMES.some(t => t.id === v)) return v;
    } catch (e) { /* storage unavailable: use default */ }
    return DEFAULT_THEME;
  }

  // Sets the theme attribute and the browser toolbar color
  function apply(id) {
    const t = THEMES.find(x => x.id === id) || THEMES[0];
    document.documentElement.setAttribute('data-theme', t.id);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t.color);
  }

  // Applies and saves a theme choice
  function set(id) {
    try { localStorage.setItem(KEY, id); } catch (e) { /* choice still applies for this visit */ }
    apply(id);
  }

  apply(get());
  window.QCTheme = { THEMES, get, set };
})();
