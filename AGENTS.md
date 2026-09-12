# WebAppSuite - Repository AI Agent Guidelines

This is the overarching AI agent configuration for the entire `WebAppSuite` repository. All AI agents working in this repository must adhere to these project-wide parameters and conventions.

---

## 1. Project Overview & Architecture

`WebAppSuite` is a collection of standalone, lightweight, mobile-responsive web utilities hosted under the `htdocs/` directory.

### Core Stack
- **Languages**: Semantic HTML5, Vanilla CSS3, Modern JavaScript (ES6+).
- **Dependencies**: Zero heavy build chains or frontend frameworks (no React, Angular, Vue, or Tailwind) unless explicitly requested by the user. Keep it pure, fast, and dependency-free.
- **PWA & Caching Strategy**: The root suite includes a Progressive Web App service worker (`sw.js`) and web app manifest (`manifest.json`). All pages should operate on cache, but must always implement a **network-first cache checking strategy** to ensure users always receive the latest updates when online.
- **Styling & CSS Separation**: All pages should use a separate CSS file for all styles (avoiding hardcoded inline styles), organized with CSS custom properties (variables) to support themes.
- **Navigation**: Every sub-application under `htdocs/` must feature a prominent back link (`← Back to Apps` or `Back to Apps`) leading back to the root launcher (`../index.html` or `../`).

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

### UI & Styling Guidelines
- **Visual Excellence**: Modern, polished dark-mode aesthetics with high contrast, legible typography, and clean layout cards.
- **Mobile-First & Touch-Friendly**: All controls, buttons, and inputs must have adequate touch targets (minimum 44x44px where possible) with smooth active/tap states.
- **Resilience**: Graceful error handling for device APIs (e.g., Web Audio, Wake Lock, Geolocation, Camera/MediaDevices). Always provide user-friendly fallbacks when hardware APIs are unsupported or permissions are denied.

---

## 3. Sub-App Directory Structure & Scoped Agents

Each sub-application folder under `htdocs/` contains its own dedicated `AGENTS.md` defining app-specific parameters and business rules:

| Directory | Application | Scoped Agent File | Description |
| :--- | :--- | :--- | :--- |
| `htdocs/BagScore/` | Cornhole Scorekeeper | `htdocs/BagScore/AGENTS.md` | Cancellation scoring, 21-pt target, board/hole visual targets |
| `htdocs/Bingo/` | Bingo Number Tracker | `htdocs/Bingo/AGENTS.md` | Ball caller, uniform button grids, speech synthesis, card creator |
| `htdocs/DriverScore/` | DriveScore Pro | `htdocs/DriverScore/AGENTS.md` | Telematics tracking, accelerometer/turn penalties, vehicle garage |
| `htdocs/FarkleScore/` | Farkle 10,000 | `htdocs/FarkleScore/AGENTS.md` | 10k dice scoring, combo calculations, multi-player standings |
| `htdocs/HarleyVinDecoder/` | Harley VIN Decoder | `htdocs/HarleyVinDecoder/AGENTS.md` | 17-digit VIN parsing, checksum validation, OCR image preprocessing |
| `htdocs/ScoreKeeper/` | ScoreKeeper Multi-Sport | `htdocs/ScoreKeeper/AGENTS.md` | Multi-sport scoreboard, game timer, active games viewer & sync |

When modifying any specific sub-app, always refer to and follow both this root `AGENTS.md` and the app-specific `AGENTS.md`.
