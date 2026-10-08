# Toys - Sub-Application AI Agent Guidelines

This document defines the agent parameters, Bluetooth protocols, and architecture specific to the **Toys** (Lush Multi-Toy Remote) sub-application under `htdocs/Toys/`.

---

## 1. Sub-App Overview

Toys is a wireless Web Bluetooth controller specifically engineered to manage single or multiple Lovense devices (Lush, Hush, Domi, Edge, etc.) with low-latency UART telemetry, continuous vibration intensity control, momentary safety release, custom nicknames, and background auto-reconnect routines.

### Primary Files
- `index.html`: Main control panel, vibration intensity slider, device list, device pairing/renaming modals, and Web Bluetooth GATT communication loop.
- `style.css`: Sweet, pastel pink & frilly design tokens, responsive cards, touch-friendly pill buttons, toggle sliders, and status badges.
- `toys.html`: Backward compatibility redirect forwarding to `index.html`.

---

## 2. Hardware API & Bluetooth Communication

### Web Bluetooth Protocol (Lovense GATT)
- **Scanning Filters**: Filter by `namePrefix: 'LVS-'` with primary and dynamic GATT service UUIDs covering Generation 1 (`0000fff0...`), Generation 2 Nordic UART (`6e400001...`), and dynamic Generation 3 UUIDs.
- **Command Transmission**:
  - Format: `Vibrate:<intensity>;` where `<intensity>` is an integer between `0` and `20`.
  - Mode: Prefer `writeWithoutResponse` where supported by the TX characteristic to prevent GATT queue blocking and packet flooding; fall back to standard `writeValue`.
  - Queueing: Coalesce rapid slider adjustments so only the latest intensity is transmitted once an in-flight packet finishes.
- **Momentary Safety Mode**:
  - When enabled, releasing touch/pointer immediately restores slider value to `0` and broadcasts `Vibrate:0;`.

### Device Persistence & Auto-Reconnect
- **Device Registry**: Saved in `localStorage` under `lush_toy_registry` mapping persistent `deviceId` to friendly nicknames, original broadcast names, and timestamp.
- **Auto-Reconnect**: Periodic 5-second polling routine that inspects `navigator.bluetooth.getDevices()` to seamlessly reconnect paired toys without requiring manual browser prompts on every reload.

---

## 3. Access Control & Group Authorization

- **Group Restriction**: Configured in `suite_app_access` with `app_id = 'toys'` and `min_group_id = 2` (`special`).
- **Launcher Visibility**: The app card carries `data-app-id="toys"` and the `hidden` attribute in `htdocs/index.html`. Only signed-in users with `special` or `admin` group rank see the card rendered on the suite launcher.
- **Cosmetic Protection Note**: Group restrictions control launcher card visibility. Direct URL navigation remains open unless server-side gating is explicitly implemented.

---

## 4. Coding & Maintenance Guidelines

- Adhere to root `AGENTS.md` rules:
  - Document all current functions and Bluetooth event handlers with clear inline comments documenting current functionality.
  - Increment the 2-part version constant (`APP_VERSION`) by `0.1` upon every functional edit and update the footer version element.
- Ensure all interactive controls have minimum touch targets of 44x44px.
