# HarleyVinDecoder - Sub-Application AI Agent Guidelines

This document defines the agent parameters, VIN decoding standards, and architecture specific to the **HarleyVinDecoder** sub-application under `htdocs/HarleyVinDecoder/`.

---

## 1. Sub-App Overview

HarleyVinDecoder decodes 17-character Harley-Davidson Vehicle Identification Numbers (VINs) and includes an integrated client-side OCR scanner for capturing VINs from motorcycle frame neck stickers, stampings, or photo gallery uploads.

### Primary Files
- `index.html`: Complete single-page application containing the VIN input, OCR camera/gallery tools, image editor (rotate, crop, contrast), and real-time specification breakdown tables.
- `style.css`: Dark automotive styling, spec table cards, check-digit validation indicators, and OCR control panels.

---

## 2. Harley-Davidson VIN Standard Parameters

The decoder strictly implements the standard 17-character ISO 3779 VIN structure for Harley-Davidson motorcycles:

| Position | Length | Component | Description / Valid Values |
| :--- | :--- | :--- | :--- |
| **1 – 3** | 3 chars | **WMI** | World Manufacturer Identifier (e.g., `1HD` = USA Domestic, `5HD` = International / Europe, `932` = Brazil, `MEG` = India, `MLH` = Thailand). |
| **4** | 1 char | **Weight Class** | Motorcycle category (Heavyweight, Middleweight, Lightweight, Sidecar). |
| **5 – 6** | 2 chars | **Model Designation** | Model series (Touring, Softail, Dyna, Sportster, V-Rod, Street, Trike, CVO, Pan America). |
| **7** | 1 char | **Engine Code** | Displacement and engine family (Shovelhead, Evolution, Twin Cam 88/96/103/110, Milwaukee-Eight 107/114/117/121, Revolution Max). |
| **8** | 1 char | **Introduction Period** | Regular introduction, mid-year intro, or special calibration. |
| **9** | 1 char | **Check Digit** | Mathematical checksum verification (`0`–`9` or `X`). |
| **10** | 1 char | **Model Year** | Standard year encoding (1981–present using letters `A`–`Y` and digits `1`–`9`). |
| **11** | 1 char | **Assembly Plant** | Production plant code (e.g., `Y` / `1` = York, PA; `K` = Kansas City, MO; `T` = Tomahawk, WI; `M` = Manaus, Brazil; `B` = Bawal, India; `R` = Rayong, Thailand). |
| **12 – 17** | 6 chars | **Sequential Serial** | 6-digit unique manufacturing sequence number. |

### Check Digit Validation Algorithm
- Must use official ISO 3779 weights: `[8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2]`.
- Map letter values using standard VIN transliteration tables (A=1, B=2, ..., Z=9; I, O, Q prohibited).
- Sum products, modulo 11: remainder 10 produces check digit `X`.
- Display clear PASS / FAIL checksum indicator badges in the UI.

---

## 3. OCR & Image Preprocessing Parameters

- **Image Capture**: Supports direct camera video/capture (`capture="environment"`) and image file uploads.
- **Client-Side Processing**: Allows rotating (90° increments), canvas crop area selection, and high-contrast threshold filters to enhance embossed or laser-etched frame stampings.
- **Robust Text Extraction**: Strip whitespace, hyphens, and non-alphanumeric characters. Auto-correct common OCR confusions (e.g. `O` vs `0`, `I` vs `1`, `S` vs `5`, `Z` vs `2`) when resolving valid VIN characters.

---

## 4. Coding & Maintenance Guidelines

- Follow root `AGENTS.md` rules:
  - Document reference tables and decoding logic with clear inline comments.
  - Increment the 2-part version constant (`APP_VERSION`) by `0.1` upon every functional edit and update the footer version element.
- Guard against invalid or unrecognized codes: if a model or engine code is unknown, display "Unknown / Unregistered Code" without breaking other decoded fields or crashing the script.
