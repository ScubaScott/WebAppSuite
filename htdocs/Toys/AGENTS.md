# Toys - Sub-Application AI Agent Guidelines

This document defines the agent parameters, Bluetooth protocols, and architecture specific to the **Toys** (Lush Multi-Toy Remote) sub-application under `htdocs/Toys/`.

---

## 1. Sub-App Overview

Toys is a wireless Web Bluetooth controller specifically engineered to manage single or multiple Lovense devices (Lush, Hush, Domi, Edge, etc.) with low-latency UART telemetry, continuous vibration intensity control, momentary safety release, custom nicknames, and background auto-reconnect routines.

### Primary Files
- `index.html`: Main control panel, vibration intensity slider, device list, device pairing/renaming modals, settings modal with theme switcher, WinAmp graphic equalizer visualizer, and Web Bluetooth GATT communication loop.
- `style.css`: Sweet pastel pink design tokens, retro WinAmp dark graphite & green phosphor LCD theme tokens, responsive cards, touch-friendly pill buttons, toggle sliders, and status badges.
- `toys.html`: Backward compatibility redirect forwarding to `index.html`.

---

## 2. Theme System & Discretion Mode
- **Pink Theme (Original)**: Sweet, frilly pastel pink design tokens, romantic heart accents, and overt Lush controller terminology.
- **Music Theme (WinAmp / Discretion Mode)**: Retro WinAmp media player aesthetic engineered for discreet public usage. Features brushed dark graphite casings, phosphor green (`#00ff41`) LCD displays, beveled metallic controls, and an animated Graphic Equalizer (EQ) spectrum analyzer responding to intensity levels.
- **Discreet Terminology**: In Music mode, all UI controls and status badges dynamically transform into professional audio terminology (e.g., *Output Channels*, *Scan Audio Output*, *Master Volume / Gain*, *dB Presets*, *DSP Dynamic Sweep*, *Gyro Spatial EQ*).
- **Settings Modal & Persistence**: Triggered via the standard Suite Header gear button (`.suite-header__gear`). User selection is persisted in `localStorage` under `toys_theme`.

---

## 2. Hardware API & Bluetooth Communication

### Multi-Brand Protocol Architecture (`TOY_DRIVERS`)
The application implements an extensible driver registry (`TOY_DRIVERS`) enabling concurrent communication with multiple hardware manufacturers without cloud accounts or third-party web sockets:
- **Lovense**:
  - Scanning: Filter `namePrefix: 'LVS-'` with Gen 1 (`0000fff0...`), Gen 2 Nordic UART (`6e400001...`), and Gen 3 dynamic prefixes.
  - Command: Plaintext ASCII `Vibrate:<intensity>;` where intensity is 0 to 20.
- **We-Vibe**:
  - Scanning: Filter prefixes (`We-Vibe`, `WeVibe`, `Sync`, `Chorus`, `Nova`, `Verge`, `Rave`, `Bloom`, `Moxie`, `Melt`, `Pivot`, `Tango`, `Vector`) and service `f000bb03-0451-4000-b000-000000000000`.
  - Command: Fixed 8-byte array `[0x0f, 0x03, 0x00, (level << 4) | level, 0x00, 0x03, 0x00, 0x00]` scaled across 3–15 (`0x3` to `0xF`) with motor enable bitmask in byte 5 (`0x03` for active manual vibration mode to override hardware button presets). 8-bit variants (Vector, Moxie) map individual motor bytes `[0x0f, 0x03, 0x00, level, level, 0x03, 0x00, 0x00]`. Stop command: `[0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]`.
- **Satisfyer**:
  - Scanning: Filter prefixes (`Satisfyer`, `SF-`) and service `51361500-c5e7-47c7-8a6e-47ebc99d80e8`.
  - Command: Motor on/off byte on characteristic `51361501...` and motor speed byte (`0` to `100`) on characteristic `51361502...`.

### Brand Auto-Detection & Manual Protocol Override
- **Auto-Detection**: During GATT connection, the driver matches broadcasted device name and discovered service UUIDs against registered driver signatures (`matches()`).
- **Manual Brand Override**: Users can override or reassign the driver protocol at any time via the Configure dialog (`Auto-Detect`, `Lovense`, `We-Vibe`, `Satisfyer`), which persists in the device registry and immediately rebinds GATT handles if connected.
- **Brand Badges**: Device cards render visual brand pill badges styled for both Pink and WinAmp themes.

### Multi-Toy Channel Mixer & Multi-Motor Splitting
- **Multi-Track Mixer (`#channelMixerCard`)**: Direct channel strip representation for each connected and selected toy directly beneath the Master Intensity card.
- **Dynamic & Manual Motor Splitting**: Supports 1 or 2 independent motor channels per device. Detects multi-motor hardware (We-Vibe internal/external motors, Lovense Edge/Domi/Nora/Ose/Gemini/Flexer) automatically, with user override available in the device Config dialog (`1 Motor` or `2 Motors`).
- **Sync Toggling**: Each motor channel features an independent "Sync" toggle. When checked, the motor mirrors the Master intensity slider 1:1. When unchecked or when an individual slider is trimmed, sync is disengaged for that channel, preserving independent trimming against Master movements. Re-checking sync instantly re-locks the channel to the current Master level.
- **Quick Mute/Unmute**: Each channel card provides a dedicated mute button to immediately zero all motors for that device and detach sync, or restore prior intensity and re-engage sync.

### Slider Architecture & Touch Guard
- **Master Intensity Slider (`.master-slider`)**: Operates with instant jump-on-touch response across the track and optional momentary safety release to 0. Its track and thumb styles in the Pink theme are isolated into dedicated CSS rules to allow independent visual reshaping.
- **Parameter Sliders (`.param-slider` / `.param-custom-slider`)**: Settings sliders in the Random Pattern and Motion cards render a touch-safe custom component (`initCustomParamSliders()`). The track (`.param-custom-track`) is non-interactive with `touch-action: pan-y`, allowing smooth vertical page scrolling on mobile and completely eliminating track tap jumps. Only deliberate grabbing and dragging of the handle (`.param-custom-handle` with `setPointerCapture`) adjusts the parameter value.
- **Channel Mixer Sliders (`.mixer-slider`)**: Individual motor trimming faders styled for rapid touch control with real-time numeric readouts and theme-aware track highlights.
- **WinAmp Theme Preserved**: Under `[data-theme="music"]`, the classic WinAmp graphite and LCD slider aesthetic applies uniformly across all range controls.

### Command Transmission & Safety Mode
- **Mode**: Prefer `writeWithoutResponse` where supported by target TX characteristics to prevent GATT queue blocking and packet flooding; fall back to standard `writeValue`.
- **Queueing**: Coalesce rapid slider adjustments so only the latest intensity is transmitted once an in-flight packet finishes.
- **Momentary Safety Mode**: When enabled, releasing touch/pointer immediately restores slider value to `0` and broadcasts a stop command to all connected toys.

### Device Persistence & Auto-Reconnect
- **Device Registry**: Saved in `localStorage` under `lush_toy_registry` mapping persistent `deviceId` to friendly nicknames, original broadcast names, brand driver selection, and timestamp.
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
