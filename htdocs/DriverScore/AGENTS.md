# DriverScore - Sub-Application AI Agent Guidelines

This document defines the agent parameters, telematics models, and architecture specific to the **DriverScore** (DriveScore Pro) sub-application under `htdocs/DriverScore/`.

---

## 1. Sub-App Overview

DriveScore Pro is a mobile telematics tracker that measures driving performance in real-time. It records trip metrics, detects harsh events (hard acceleration, heavy braking, aggressive turns), calculates a trip score out of 100, and manages vehicle and driver garage profiles.

### Primary Files
- `index.html`: Real-time telematics HUD, circular trip score gauge, penalty visual alerts, and trip controls.
- `VehicleSettings.html`: Vehicle garage and driver profile management (add, edit, remove vehicles and drivers).
- `style.css`: Dashboard gauges, dark automotive HUD themes, animated penalty indicators, and forms.

---

## 2. Telematics & Scoring Parameters

### Scoring Model
- **Base Score**: Every trip starts at `100` points.
- **Penalty Deductions**:
  - **Left Turn Penalty** (`#piTurnLeft`): Triggered by excessive lateral acceleration turning left.
  - **Right Turn Penalty** (`#piTurnRight`): Triggered by excessive lateral acceleration turning right.
  - **Harsh Braking**: Sudden longitudinal deceleration above threshold.
  - **Harsh Acceleration**: Rapid longitudinal acceleration above threshold.
  - **Speed Exceedance**: Speeding above configured vehicle or road speed limit.
- **Score Color Transition**: Dynamic color shifts based on score health (e.g., green 90-100, yellow 70-89, red <70).

### Sensor & Hardware APIs
- **Wake Lock API (`navigator.wakeLock`)**: Keep screen awake during active trips when requested by `#chkWakeLock`. Always handle release and reconnection on visibility change.
- **Device Motion & Orientation**: Monitor accelerometer events with low-pass filtering to isolate vehicle motion from road bumps and vibrations.
- **Geolocation API**: Track speed, distance traveled, and trip duration via GPS coordinates.

---

## 3. Storage & Profile Data Models

- **Profiles in `localStorage`**:
  - Store drivers list (`drivers`: `[{ id, name, ... }]`).
  - Store vehicles garage list (`vehicles`: `[{ id, make, model, year, type, ... }]`).
  - Active trip logs and historical trip scores.
- Ensure `VehicleSettings.html` and `index.html` share uniform keys and data contracts for selected driver (`ddlDriver`) and selected vehicle (`ddlVehicle`).

---

## 4. Coding & Maintenance Guidelines

- Adhere to root `AGENTS.md` rules:
  - Document telematics thresholds, calculations, and event handlers with clear inline comments.
  - Increment the 2-part version constant (`APP_VERSION`) by `0.1` upon every functional edit and update the footer version element.
- Ensure sensor permission prompts and HTTPS/localhost requirements are handled gracefully without application freezes.
