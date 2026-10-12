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

### Random Pattern Engine
- **Engine Mechanics**: Generates continuous autonomous intensity shifts by calculating smooth ramps from the current level to a randomly selected `nextTarget` within configurable `[min, max]` bounds at a defined `rampRate` (units/second).
- **Hold Interval & Minimum Jump**: Once `nextTarget` is attained, pauses for a randomized duration between `0` and `holdMax` seconds before selecting a new target that differs by at least `minJump` units.
- **Manual Priority & Override**: Touching the manual slider temporarily pauses the pattern in `'manual'` state. Releasing contact resumes the pattern smoothly from the released intensity, overriding momentary release to 0. Presets and Emergency Stop immediately disengage pattern mode.
- **Collapsible UI**: The pattern configuration panel automatically collapses into a compact header when the pattern is toggled off, and expands upon activation.
- **Configuration Persistence**: Pattern parameters (`rampRate`, `min`, `max`, `minJump`, `holdMax`) are persisted under `lush_pattern_settings` in `localStorage`. The active run toggle is always initialized to `off` upon reload for safety.

### Motion Control Engine (Accelerometer & Vehicle Tilt)
- **Engine Mechanics**: Interfaces with `DeviceMotionEvent` and `DeviceOrientationEvent` to translate live phone movement and vehicular dynamics into continuous 0–20 Lovense vibration commands.
- **Mode 1 (Any G-Force)**: Omnidirectional linear acceleration magnitude $\sqrt{a_x^2 + a_y^2 + a_z^2}$ with peak-rise and exponential decay filter. Bumps, tremors, and shakes translate directly into vibration bursts.
- **Mode 2 (Angle & Acceleration / Vehicle Mode)**: Designed for phone mounts inside moving vehicles. Combines planar turning/cornering and acceleration/braking G-forces with pitch and roll tilt deviation relative to a calibrated resting orientation.
- **Zero Baseline**: Captures resting orientation ($pitch_0, roll_0$) and gravity vector to establish 0-intensity resting equilibrium in vehicle holders.
- **Sensitivity Multiplier (0 to 20)**: Scaled slider where 0 suppresses minor motion to 0 intensity and 20 produces high intensity on subtle movement.
- **Road & Engine Noise Filter (0 to 10)**: Dynamic vibration filter specifically designed for vehicle mode. Combines a G-force noise floor gate, tilt jitter deadband, and adaptive low-pass smoothing to filter out rough road texture, chassis rumble, and engine idling vibrations while transmitting true vehicular turns and acceleration.
- **Collapsible Card**: Starts collapsed by default on page load to conserve vertical space. Header tap toggles expansion state independently of tracking status.
- **Configuration Persistence**: Mode, multiplier, noise filter level, and baseline calibration are persisted under `lush_motion_settings` in `localStorage`. Tracking toggle is initialized to `off` upon reload.

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
