# WebAppSuite - Repository AI Agent Guidelines

This is the overarching AI agent configuration for the entire `WebAppSuite` repository. All AI agents working in this repository must adhere to these project-wide parameters and conventions.

---

## 1. Project Overview & Architecture

`WebAppSuite` is a collection of standalone, lightweight, mobile-responsive web utilities hosted under the `htdocs/` directory.

### Core Stack
- **Languages**: Semantic HTML5, Vanilla CSS3, Modern JavaScript (ES6+).
- **Dependencies**: Zero heavy build chains or frontend frameworks (no React, Angular, Vue, or Tailwind) unless explicitly requested by the user. Keep it pure, fast, and dependency-free.
- **PWA & Caching Strategy**: The root suite includes a Progressive Web App service worker (`sw.js`) and web app manifest (`manifest.json`). All pages should operate on cache, but must always implement a **network-first cache checking strategy** to ensure users always receive the latest updates when online.
  - **Exception - engine files**: large, versioned, immutable assets under a sub-app's `engine/` folder (OCR/ML libraries and models, e.g. `Bingo/scan/engine/`) are **cache-first** from a dedicated cache (`bingo-scan-engine`) whose name has no version, so `sw.js` cleanup never deletes it. They are downloaded once by the sub-app's engine loader, never cache-busted (no query strings), and replaced only by shipping a differently named file that the network-first `engine/manifest.json` lists. A server `.htaccess` inside the `engine/` folder marks them immutable.
  - **Exception - dev tooling**: the top-level `tools/` folder may hold developer-only scripts (for example Python for model training) and test photos. It is never deployed (the deploy workflow publishes only `htdocs/`).
- **Styling & CSS Separation**: All pages should use a separate CSS file for all styles (avoiding hardcoded inline styles), organized with CSS custom properties (variables) to support themes.
- **Navigation**: Every sub-application under `htdocs/` must feature a prominent back link (`← Back to Apps` or `Back to Apps`) leading back to the root launcher (`../index.html` or `../`). sub pages, of sub pages, should not have this feature. 

---

## 2. Universal Coding Standards & Rules

### Mandatory Commenting Policy
- **Current Functionality Only**: Always include and update inline comments to make code easy to troubleshoot.
- **No Historical Explanations**: Never include comments about why a change was made between versions (e.g., do NOT write `// changed in v1.2 because...` or `// refactored from old method`).
- **Clarity**: All comments should directly document what the code is currently doing and how components/functions interact.

### Mandatory Versioning Protocol
- **Version Constant**: Every application script or page must define a 2-part version constant (e.g., `const APP_VERSION = "1.1";`).
- **Increment Rule**: Every change must increment that pages decimal portion by `0.1` (e.g., `1.0` -> `1.1` -> `1.2`).
- **Footer Display**: Every rendered page (`.html`, etc.) must display this version number in a footer at the bottom of the page in a small font (e.g., `<footer class="app-footer"><small>v1.1</small></footer>`).
  - **Anchored to the bottom**: the footer is a direct child of `<body>`, subdued and transparent. Link `media/suite-footer.css` (before the page's own stylesheet, and listed in `APP_SHELL` in `sw.js`): it makes `<body>` a full-height flex column and pushes the footer to the bottom edge when the content is short; when the content is long the footer simply follows it. The page's main wrapper must not use `min-height: calc(100vh - ...)`; use `flex: 1 0 auto` (and `width: 100%` if it has a `max-width` and `margin: 0 auto`).

### UI & Styling Guidelines
- **Visual Excellence**: Modern, polished dark-mode aesthetics with high contrast, legible typography, and clean layout cards.
- **Mobile-First & Touch-Friendly**: All controls, buttons, and inputs must have adequate touch targets (minimum 44x44px where possible) with smooth active/tap states.
- **Resilience**: Graceful error handling for device APIs (e.g., Web Audio, Wake Lock, Geolocation, Camera/MediaDevices). Always provide user-friendly fallbacks when hardware APIs are unsupported or permissions are denied.
- **No Browser Dialogs (Mandatory)**: Never use the browser's built-in `alert()`, `confirm()` or `prompt()` dialogs (they show "<site name> says..." and cannot be styled). Every message, confirmation and text prompt must be a custom dialog (for example a themed `<dialog>`) that shows exactly the wording we choose, styled to match the app's theme, with touch-friendly buttons (minimum 44x44px) and a clearly labeled default action. Destructive confirmations name the action on the button (for example "Delete game"), not a generic "OK". When touching a file that still contains a native dialog call, replace it.
  - **Shared component**: link `media/suite-dialog.css` and `media/suite-dialog.js` (add both to `APP_SHELL` in `sw.js`) and call `SuiteDialog.alert(message, { title, okLabel })`, `await SuiteDialog.confirm(message, { title, confirmLabel, cancelLabel, danger, defaultCancel })` (resolves true/false) or `await SuiteDialog.prompt(message, { title, value, placeholder, confirmLabel })` (resolves the text, or null if cancelled). Text is shown as plain text, never as HTML; a `\n` starts a new paragraph. The box takes its colors from the page's `--surface`, `--text`, `--muted`, `--border`, `--accent`, `--on-accent` and `--danger` tokens (or `--sd-*` overrides). Use `danger: true` for destructive actions and `defaultCancel: true` when Enter should not confirm. Tested by `tools/suite-dialog-test.js`.

### Suite Header Protocol
- **Shared Component**: All primary sub-application index pages must link `../media/suite-header.css` and render a standard top-line header (`<header class="suite-header">`) directly under `<body>`.
- **Layout & Structure**:
  - **Left**: `.suite-header__back` linking to `../index.html` with arrow SVG, full label "Back to Apps" (hidden <= 420px), and compact label "Apps" (shown <= 420px).
  - **Center**: Single-word `<h1>` title (`.suite-header__title`).
  - **Right**: 44x44px settings gear button (`.suite-header__gear`) on apps with settings modals, or empty spacer (`.suite-header__spacer`) on apps without settings to preserve symmetrical title centering.
- **Scroll Behavior**: Normal document flow / static positioning (sits at top of page and scrolls off with content).
- **Theming**: Configured via CSS custom properties on `:root` or `[data-theme]`:
  `--hdr-bg`, `--hdr-fg`, `--hdr-muted`, `--hdr-accent`, `--hdr-border`, `--hdr-height`, `--hdr-font`.

---

## 3. Sub-App Directory Structure & Scoped Agents

Each sub-application folder under `htdocs/` contains its own dedicated `AGENTS.md` defining app-specific parameters and business rules:

| Directory | Application | Scoped Agent File | Description |
| :--- | :--- | :--- | :--- |
| `htdocs/BagScore/` | Cornhole Scorekeeper | `htdocs/BagScore/AGENTS.md` | Cancellation scoring, 21-pt target, board/hole visual targets |
| `htdocs/Bingo/` | Bingo Number Tracker | `htdocs/Bingo/AGENTS.md` | Ball caller, uniform button grids, speech synthesis, card creator |
| `htdocs/Dominoes/` | Dominoes Score Keeper | `htdocs/Dominoes/AGENTS.md` | Low-score-wins domino rounds, 0\|0 blank value, line chart, camera pip scanner |
| `htdocs/DriverScore/` | DriveScore Pro | `htdocs/DriverScore/AGENTS.md` | Telematics tracking, accelerometer/turn penalties, vehicle garage |
| `htdocs/FarkleScore/` | Farkle 10,000 | `htdocs/FarkleScore/AGENTS.md` | 10k dice scoring, combo calculations, multi-player standings |
| `htdocs/HarleyVinDecoder/` | Harley VIN Decoder | `htdocs/HarleyVinDecoder/AGENTS.md` | 17-digit VIN parsing, checksum validation, OCR image preprocessing |
| `htdocs/QueenCount/` | QueenCount | `htdocs/QueenCount/AGENTS.md` | Head count guessing game, $1 pot, closest guess wins, IndexedDB history |
| `htdocs/ScoreBoard/` | ScoreBoard Multi-Sport | `htdocs/ScoreBoard/AGENTS.md` | Multi-sport scoreboard, game timer, active games viewer & sync |
| `htdocs/Toys/` | Toys Lovense Controller | `htdocs/Toys/AGENTS.md` | Bluetooth remote, multi-toy vibration manager, special group restricted |

When modifying any specific sub-app, always refer to and follow both this root `AGENTS.md` and the app-specific `AGENTS.md`.
