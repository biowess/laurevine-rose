<p align="center">
  <img src="Assets/brand/appicon-header.png" alt="Laurevine Rose application icon" width="750">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/HTML5-E34F26?style=flat&logo=html5&logoColor=white" alt="HTML5">
  <img src="https://img.shields.io/badge/CSS3-1572B6?style=flat&logo=css3&logoColor=white" alt="CSS3">
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black" alt="JavaScript (vanilla)">
  <img src="https://img.shields.io/badge/Electron-%5E44.9.0-2B2E3A?style=flat&logo=electron&logoColor=white" alt="Electron ^44.9.0">
  <img src="https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat&logo=python&logoColor=white" alt="Python 3.10+">
  <img src="https://img.shields.io/badge/FastAPI-%E2%89%A50.110-009688?style=flat" alt="FastAPI">
  <img src="https://img.shields.io/badge/python--pptx-%E2%89%A51.0-4B8BBE?style=flat" alt="python-pptx">
  <img src="https://img.shields.io/badge/Matplotlib-%E2%89%A53.8-11557C?style=flat" alt="Matplotlib">
  <img src="https://img.shields.io/badge/License-Custom%20(Source--Available)-lightgrey?style=flat" alt="License: Custom (Source-Available)">
</p>

<h1 align="center">Laurevine Rose</h1>
<p align="center"><em>A desktop research presentation editor with PowerPoint-grade fidelity and a built-in Scientific Figure Studio for publication-quality visualization.</em></p>

---

## Table of Contents

1. [Introduction](#introduction)
2. [At a Glance](#at-a-glance)
3. [Screenshots & Interface Tour](#screenshots--interface-tour)
4. [Features](#features)
   - [4.1 Interface Overview](#41-interface-overview)
   - [4.2 Slide Editing & Objects](#42-slide-editing--objects)
   - [4.3 Design System](#43-design-system)
   - [4.4 Tables](#44-tables)
   - [4.5 Symbol Library](#45-symbol-library)
   - [4.6 Headers, Footers & Slide Numbers](#46-headers-footers--slide-numbers)
   - [4.7 Scientific Figure Studio](#47-scientific-figure-studio)
   - [4.8 Review & Accessibility Checks](#48-review--accessibility-checks)
   - [4.9 Presenting](#49-presenting)
   - [4.10 Saving, Opening & Exporting](#410-saving-opening--exporting)
5. [Getting Started](#getting-started)
6. [Installation](#installation)
   - [6.1 Windows (.exe)](#61-windows-exe)
   - [6.4 Linux AppImage](#64-linux-appimage)
7. [Download Integrity (SHA-256)](#download-integrity-sha-256)
8. [System Requirements](#system-requirements)
9. [Technology Stack](#technology-stack)
10. [Architecture & Internal Workflow](#architecture--internal-workflow)
11. [Supported Formats & Compatibility](#supported-formats--compatibility)
12. [Frequently Asked Questions](#frequently-asked-questions)
13. [Troubleshooting](#troubleshooting)
14. [Known Limitations](#known-limitations)
15. [Privacy & Security](#privacy--security)
16. [Development & Testing](#development--testing)
17. [Contributing & Feature Requests](#contributing--feature-requests)
18. [License](#license)
19. [Contact](#contact)

---

## Introduction

**Laurevine Rose** is a desktop-oriented presentation editor purpose-built for researchers and scientists who need
PowerPoint-compatible output without leaving a scientific workflow. It combines a full slide editor (shapes, text,
tables, templates, and layouts) with a dedicated **Scientific Figure Studio** for building publication-quality plots,
custom Python/Matplotlib figures, multi-panel composite figures, and LaTeX/PGFPlots diagrams, all rendered at
high resolution and inserted directly onto the slide canvas.

The application runs as an Electron desktop shell around a local Python/FastAPI service. The editor itself is plain
HTML, CSS, and vanilla JavaScript (no frontend framework), communicating with the local backend over loopback
HTTP. Figure rendering, PowerPoint export, and LaTeX compilation are handled by isolated Python subprocesses on
the same machine, and nothing is uploaded to a remote server.

Laurevine Rose exports to native **PowerPoint (.pptx)** files that open in Microsoft PowerPoint, Apple Keynote,
Google Slides, or LibreOffice Impress with no dependency on Laurevine Rose, Python, or LaTeX. Project files
(**.rpe.json**) retain the full editable state, including raw figure data, Python source, and LaTeX source, so
figures can be revisited and re-rendered later.

---

## At a Glance

| | |
| :--- | :--- |
| **Application type** | Desktop presentation editor (Electron shell + local Python/FastAPI backend) |
| **Primary output** | Native PowerPoint `.pptx`, with optional PDF export |
| **Project file format** | `.rpe.json` (full editable source, including figure data and code) |
| **Distinguishing feature** | Scientific Figure Studio: structured plots, custom Python figures, multi-panel composites, and LaTeX/PGFPlots diagrams rendered and embedded as high-resolution images |
| **Distribution formats** | Windows `.exe`, Linux `.AppImage` |
| **Target architecture** | x86_64 (64-bit) |
| **Network behavior** | Local-only; the backend binds strictly to loopback addresses |
| **License** | Proprietary, source-available. Free to use, modify for private use only, no resale or redistribution without permission. See [License](#license) |

---

## Screenshots & Interface Tour

### Getting Started

<table>
<tr>
<td width="50%"><img src="Assets/screenshots/screenshot-01.png" alt="Laurevine Rose startup splash screen placeholder" width="100%"><br><sub><b>01</b>: Startup &amp; splash screen</sub></td>
<td width="50%"><img src="Assets/screenshots/screenshot-02.png" alt="Main slide editing workspace placeholder" width="100%"><br><sub><b>02</b>: Main editing workspace</sub></td>
</tr>
</table>

### Editing Ribbon & Core Tools

<table>
<tr>
<td width="33%"><img src="Assets/screenshots/screenshot-03.png" alt="Home ribbon text and font controls placeholder" width="100%"><br><sub><b>03</b>: Home ribbon: text &amp; font controls</sub></td>
<td width="33%"><img src="Assets/screenshots/screenshot-04.png" alt="Insert ribbon shapes and tables placeholder" width="100%"><br><sub><b>04</b>: Insert ribbon: shapes &amp; tables</sub></td>
<td width="33%"><img src="Assets/screenshots/screenshot-05.png" alt="Header, footer and slide number configuration placeholder" width="100%"><br><sub><b>05</b>: Header, footer &amp; slide numbers</sub></td>
</tr>
<tr>
<td width="33%"><img src="Assets/screenshots/screenshot-06.png" alt="Table range selection and formatting placeholder" width="100%"><br><sub><b>06</b>: Table range selection &amp; formatting</sub></td>
<td width="33%"><img src="Assets/screenshots/screenshot-07.png" alt="Symbol library placeholder" width="100%"><br><sub><b>07</b>: Symbol library (~360 symbols)</sub></td>
<td width="33%"><img src="Assets/screenshots/screenshot-08.png" alt="Slide layout gallery placeholder" width="100%"><br><sub><b>08</b>: Slide layout gallery</sub></td>
</tr>
</table>

### Design System

<table>
<tr>
<td width="33%"><img src="Assets/screenshots/screenshot-09.png" alt="Curated academic template gallery placeholder" width="100%"><br><sub><b>09</b>: Curated academic templates</sub></td>
<td width="33%"><img src="Assets/screenshots/screenshot-10.png" alt="Typography preset picker placeholder" width="100%"><br><sub><b>10</b>: Typography presets</sub></td>
<td width="33%"><img src="Assets/screenshots/screenshot-11.png" alt="Color palette picker placeholder" width="100%"><br><sub><b>11</b>: Color palette picker</sub></td>
</tr>
</table>

### Scientific Figure Studio

<table>
<tr>
<td width="33%"><img src="Assets/screenshots/screenshot-12.png" alt="Structured plots editor placeholder" width="100%"><br><sub><b>12</b>: Structured Plots editor</sub></td>
<td width="33%"><img src="Assets/screenshots/screenshot-13.png" alt="Data spreadsheet and CSV import placeholder" width="100%"><br><sub><b>13</b>: Data spreadsheet &amp; CSV import</sub></td>
<td width="33%"><img src="Assets/screenshots/screenshot-14.png" alt="Python Figure Studio code editor placeholder" width="100%"><br><sub><b>14</b>: Python Figure Studio</sub></td>
</tr>
<tr>
<td width="33%"><img src="Assets/screenshots/screenshot-15.png" alt="Multi-panel figure composer placeholder" width="100%"><br><sub><b>15</b>: Multi-Panel Composer</sub></td>
<td width="33%"><img src="Assets/screenshots/screenshot-16.png" alt="LaTeX and PGFPlots studio placeholder" width="100%"><br><sub><b>16</b>: LaTeX / PGFPlots Studio</sub></td>
<td width="33%"><img src="Assets/screenshots/screenshot-17.png" alt="Figure export and insert panel placeholder" width="100%"><br><sub><b>17</b>: Figure export &amp; insert panel</sub></td>
</tr>
</table>

### Presenting & Reviewing

<table>
<tr>
<td width="25%"><img src="Assets/screenshots/screenshot-18.png" alt="Presenter view placeholder" width="100%"><br><sub><b>18</b>: Presenter view</sub></td>
<td width="25%"><img src="Assets/screenshots/screenshot-19.png" alt="Research checks panel placeholder" width="100%"><br><sub><b>19</b>: Research checks</sub></td>
<td width="25%"><img src="Assets/screenshots/screenshot-20.png" alt="Slide sorter view placeholder" width="100%"><br><sub><b>20</b>: Slide sorter view</sub></td>
<td width="25%"><img src="Assets/screenshots/screenshot-21.png" alt="Accessibility check placeholder" width="100%"><br><sub><b>21</b>: Accessibility check</sub></td>
</tr>
</table>

### File Management & Export

<table>
<tr>
<td width="33%"><img src="Assets/screenshots/screenshot-22.png" alt="File backstage menu placeholder" width="100%"><br><sub><b>22</b>: File backstage (New / Open / Export)</sub></td>
<td width="33%"><img src="Assets/screenshots/screenshot-23.png" alt="PowerPoint export placeholder" width="100%"><br><sub><b>23</b>: PowerPoint (.pptx) export</sub></td>
<td width="33%"><img src="Assets/screenshots/screenshot-24.png" alt="PDF and project file export placeholder" width="100%"><br><sub><b>24</b>: PDF &amp; project file (.rpe.json) export</sub></td>
</tr>
</table>

---

## Features

### 4.1 Interface Overview

Laurevine Rose uses a ribbon-style interface similar to Microsoft Office. The main ribbon tabs are **File**
(backstage), **Home**, **Insert**, **Design**, **Figures**, **Present**, **Review**, and **View**. Selecting an
object on the canvas reveals additional contextual tabs: **Text Format**, **Picture Format**, **Shape Format**,
**Plot Tools**, and **Table Tools**. The editing canvas uses a fixed 1280×720 logical coordinate system (a 16:9
widescreen presentation canvas), and all edits flow through a single-source-of-truth document store with full
undo/redo support.

### 4.2 Slide Editing & Objects

- **Clipboard**: cut, copy, paste, paste as plain text, and a format painter for copying text/shape styling between
  objects.
- **Slides**: add new slides from the layout gallery (`Ctrl+M`) or change the layout of the current slide at any
  time; existing content is intelligently remapped into the new layout's placeholders rather than discarded.
- **Text formatting**: font family and size pickers, bold/italic/underline/strikethrough, subscript and superscript
  (`Ctrl+=` / `Ctrl+Shift+=`), font color and text highlight color, bullet and numbered lists, list indent/outdent,
  paragraph alignment (left/center/right/justify), and line/paragraph spacing presets.
- **Shapes and illustrations**: a shape gallery plus dedicated illustration shapes for annotations: callouts, block
  arrows, braces, and scale bars (useful for scientific figures and diagrams placed directly on the slide).
- **Arrange**: z-order controls (bring forward/send backward), alignment and distribution tools, grouping
  (`Ctrl+G`) and ungrouping (`Ctrl+Shift+G`).
- **Find & Replace**: text search and replace across the presentation (`Ctrl+F` / `Ctrl+H`), plus "select all",
  "select all text boxes", and "select all plots/figures" selection modes.
- **Pictures**: insert from device or as an image placeholder; replace picture, crop, and image corrections
  (brightness, contrast, saturation, grayscale, tint) with a one-click reset; alt text and caption support.
- **Links**: insert hyperlinks on text or objects.

### 4.3 Design System

- **Slide layouts**: a shared catalog of **26 layouts** (12 primary and 14 extended) covering common academic and
  scientific slide patterns, with live thumbnail previews. Applying a layout intelligently maps existing titles,
  kickers, body text, tables, and media into the new layout's placeholders while preserving any unmatched content.
- **Curated templates**: ten built-in academic/scientific presentation templates, each bundling a coordinated
  palette, typography preset, and layout set: **Clinical Blue**, **Computational Biology**, **Dark Auditorium**,
  **Data & Methods**, **Editorial Review**, **Field Biology**, **Hematology & Oncology**,
  **Molecular & Translational**, **Population Health**, and **Swiss Scientific Minimal**.
- **Typography presets**: ten template-linked presets plus four legacy presets, with semantic roles (title,
  subtitle, body, label/kicker/meta, caption/footnote). Switching presets rebinds these roles across the whole
  presentation in a single transaction without disturbing manually edited runs, geometry, or colors.
- **Color palettes**: ten template-linked palettes plus five legacy palettes, defining semantic roles for
  background, text, accents, supporting surfaces, table headers, and a six-color categorical chart palette. A
  built-in WCAG contrast check automatically falls back to a readable color when a role would otherwise produce
  low-contrast text.
- **Slide setup**: standard aspect-ratio presets plus a custom page-setup dialog, and landscape/portrait
  orientation toggle.

### 4.4 Tables

- Insert tables from a visual grid picker.
- **Rectangular range selection**: select arbitrary rectangular cell ranges via drag or an interactive selection
  handle, independent of the exported file (the handle never appears in exported output).
- Add/remove rows and columns, toggle a header row and banded row styling.
- Per-cell formatting: fill color, text alignment (including vertical alignment), bold, font size, and a
  "clear format" action.
- Full parity between the editor and the PowerPoint export for subscript, superscript, baseline offsets, and
  DrawingML cell borders, so tables look the same in Laurevine Rose and in PowerPoint.

### 4.5 Symbol Library

A built-in library of roughly **360 mathematical, Greek, arrow, and scientific symbols** organized into 9
categories, with fast search by character name, Unicode code point, or keyword. Symbols are inserted at the current
text caret without closing the symbol dialog or stealing editor focus, so multiple symbols can be inserted in quick
succession. Missing glyphs fall back automatically to a compatible font during PowerPoint and PDF export.

### 4.6 Headers, Footers & Slide Numbers

- Shared document-level header and footer text, editable inline with a double-click, with the ability to override
  either on individual slides.
- Dynamic slide numbering with a configurable starting index, automatic omission on title slides (configurable),
  and formatting options.
- On export, footers and slide numbers become native PowerPoint placeholders
  (`<p:ph type="ftr">` and `<p:ph type="sldNum">` with a `<a:fld type="slidenum">` field) positioned beneath user
  content in the shape tree, so manually placed objects always remain visually on top.
- PDF export bakes in the computed slide numbers as static text to avoid a known LibreOffice rendering limitation
  with PowerPoint's `firstSlideNum` attribute.

### 4.7 Scientific Figure Studio

The Figures tab and Insert ribbon expose four dedicated visualization tools. Every figure is rendered on the local
backend and inserted into the active slide as a high-resolution image, while its live configuration (data, code,
and settings) is kept in the project so it can be reopened and edited later.

#### Tool 1: Structured Plots

Six supported scientific plot types, each with graphical (no-code) controls:

| Plot type | Notable options |
| :--- | :--- |
| Line plot | Error bands, step curves |
| Scatter plot | Linear/polynomial fit lines, confidence intervals |
| Bar chart | Grouped and stacked bars |
| Histogram | Automatic or custom binning, kernel density estimate (KDE) overlay |
| Box plot | Quartiles, whiskers, outlier markers, notched boxes |
| Heatmap | Correlation matrices, annotated cell values |

Data can come from a built-in virtualized spreadsheet (supporting up to 50,000 rows), CSV drag-and-drop import with
automatic delimiter detection, or a short Python snippet that generates the dataset programmatically. Appearance
controls include custom color palettes, scientific chart themes, font family overrides, axis limits, and tick
formatting.

#### Tool 2: Python Figure Studio

A full code editor for unrestricted Matplotlib, Seaborn, NumPy, and SciPy scripts, executed in an isolated
subprocess. Press `Ctrl+Enter` (or the Run button) to render; standard output and tracebacks appear in a
collapsible drawer, and clicking an error line jumps to it in the editor. If a render fails, the previous
successful preview stays visible, dimmed, rather than disappearing. Scripts can be downloaded as standalone,
reproducible `.py` files with header comments.

#### Tool 3: Multi-Panel Figure Composer

Combines multiple plots into a single publication-style composite figure using six layouts: `2×2`, `1×2`, `2×1`,
`1×3`, `1+2` (one wide top panel over two bottom panels), and `2×3`. Features automatic subfigure labeling
(`A, B, C…` or `a, b, c…`, positioned inside or outside each panel), configurable panel spacing presets (Tight /
Normal / Wide), and deduplicated shared legends placed at the bottom or right. Each panel's own size, fonts, and
whitespace are preserved: panels are never shrunk to fit, and the canvas grows to accommodate them instead.

#### Tool 4: LaTeX / PGFPlots Studio

Author and compile TikZ diagrams, commutative diagrams, and PGFPlots charts using `pdflatex`, `xelatex` (for
OpenType/TrueType system fonts via `fontspec`), or `lualatex`. Compiled output is rasterized to a high-resolution
PNG via Poppler's `pdftoppm`. The compiler log view highlights errors with direct line-number jumps back into the source editor.
TeX shell escape is disabled, and the compiler rejects source that references absolute paths, parent-directory
traversal, or home-directory paths in `\input`, `\include`, or `\includegraphics`.

#### Pre-Flight Research Checks

A dedicated checks pass (also see [4.8](#48-review--accessibility-checks)) flags figures rendered below 200 DPI,
axis labels or annotations smaller than 8 pt, figures missing alternative text, figures whose source data or code
changed after the last successful render, and failed or placeholder renders.

### 4.8 Review & Accessibility Checks

- **Research checks**: scan the presentation for overflowing content, very small text, and missing figure
  captions.
- **Accessibility check**: a dedicated accessibility review pass.
- **Contrast verification**: computes real WCAG contrast ratios against the actual rendered backdrop, accounting
  for layering order, rotation, and alpha blending, rather than a shape's nominal fill color alone.
- **Overflow detection**: checks rotated bounding boxes and outlines against slide boundaries, with tolerance for
  intentional edge bleeds and decorative strips.

### 4.9 Presenting

- Start a slideshow from the beginning (`F5`) or from the current slide (`Shift+F5`).
- Presenter tools include a presenter view and a laser-pointer mode, plus a keyboard-shortcuts reference for
  presentation mode.

### 4.10 Saving, Opening & Exporting

| | Project file (`.rpe.json`) | PowerPoint (`.pptx`) | PDF (`.pdf`) |
| :--- | :--- | :--- | :--- |
| **Purpose** | Complete, editable project source | Final presentation for distribution & sharing | Ready-to-present document |
| **Figure representation** | Live record: raw data, Python/LaTeX source, settings | Static high-resolution PNG image | Static, flattened pages |
| **Re-editable in Laurevine Rose** | Yes, reopening restores live, editable figures | Figures become static pictures on re-import | Not applicable |
| **Opens without Laurevine Rose** | No | Yes, in PowerPoint, Keynote, Google Slides, LibreOffice Impress | Yes, in any PDF viewer |
| **Requires on recipient's machine** | Laurevine Rose | Nothing | Nothing |
| **Generated via** | `File → Save` / `File → Export → Project file (.json)` | `File → Export → PowerPoint (.pptx)` | `File → Export → PDF document (.pdf)`, requires LibreOffice on the host |

**Always keep your `.rpe.json` project file.** It is the only format that preserves editable figure data and
source code; the `.pptx` and `.pdf` exports are flattened, static deliverables.

---

## Getting Started

A typical first session:

1. **Install** Laurevine Rose using the package appropriate for your operating system (see
   [Installation](#installation)), or, for a source checkout, follow [Development & Testing](#development--testing).
2. **Launch the application.** The packaged app shows a splash screen while its local backend starts, then opens the
   main editing window. The status indicator confirms the backend is connected.
3. **Start from a template** on the **Design** tab, or begin from a blank presentation and apply a typography
   preset and color palette separately.
4. **Build your slides** using the **Home** and **Insert** ribbons: add text, shapes, tables, images, and new
   slides from the layout gallery.
5. **Add a scientific figure** from the **Insert** ribbon or the **Figures** tab: choose Structured Plots for a
   standard chart type, Python Figure Studio for a custom script, the Multi-Panel Composer for a composite figure,
   or the LaTeX/PGFPlots Studio for a TikZ or PGFPlots diagram. Configure it, preview it, and click **Insert into
   Slide**.
6. **Run Research Checks** (Review tab) before finalizing, to catch overflow, undersized text, and missing figure
   captions.
7. **Save your project** (`Ctrl+S`) to preserve the editable `.rpe.json` source, then **export** to PowerPoint
   (and, if needed, PDF) for distribution.

---

## Installation

> **Release links.** The canonical download location is the project's GitHub Releases page:
> **`https://github.com/biowess/laurevinerose/releases`**. The filenames below follow the project's own release
> naming convention for the current version; confirm the exact asset name on the Releases page before downloading,
> as it may be updated between releases.

All four distribution formats below are built for the **x86_64 (64-bit)** architecture.

| Format | Typical filename (current release) |
| :--- | :--- |
| Windows installer | `LaurevineRose-Setup-1.0.0-x86_64.exe` |
| Linux AppImage | `LaurevineRose-1.0.0-x86_64.AppImage` |
| Checksum manifest | `SHA256SUMS` |

Always download release Assets from the official GitHub Releases page above, not from third-party mirrors or
unofficial repackaged copies.

### 6.1 Windows (.exe)

1. Download `LaurevineRose-Setup-1.0.0-x86_64.exe` from the Releases page.
2. Run the installer and follow the on-screen prompts. Windows SmartScreen may warn about an unrecognized
   publisher for a new release. This is expected for an application that is not yet code-signed by a recognized
   certificate authority; verify the file's SHA-256 hash (see [Download Integrity](#download-integrity-sha-256))
   before proceeding if you want extra assurance.
3. Once installed, launch **Laurevine Rose** from the Start Menu or desktop shortcut created by the installer.

### 6.2 Linux AppImage

The AppImage is a portable, single-file build that does not require installation through a system package manager.

```bash
chmod +x LaurevineRose-1.0.0-x86_64.AppImage
./LaurevineRose-1.0.0-x86_64.AppImage
```

If your desktop environment does not support running AppImages out of the box, you may need a helper such as
`AppImageLauncher`. The AppImage is not guaranteed to run on every Linux distribution or desktop environment.
If it fails to launch, check the troubleshooting steps below.

### Upgrading and uninstalling

- **Windows:** re-run a newer installer to upgrade, or use "Add or remove programs" to uninstall.
- **AppImage:** replace the old `.AppImage` file with the new one; delete the file to uninstall. If you used
  `AppImageLauncher`, also remove the integrated menu entry through that tool.

---

## Download Integrity (SHA-256)

A **SHA-256 checksum** is a short fixed-length fingerprint of a file. If even a single byte of the file changes,
whether through corruption during download, a modified mirror, or tampering, the checksum changes completely. Comparing
the checksum of your downloaded file against the checksum published by the project lets you confirm that what you
received is exactly what was released, without having to trust the download itself.

Each release on the GitHub Releases page is expected to publish a `SHA256SUMS` manifest alongside the installers
listed above, containing one hash per release asset.

### Windows (PowerShell)

```powershell
Get-FileHash .\LaurevineRose-Setup-1.0.0-x86_64.exe -Algorithm SHA256
```

Compare the printed hash, character for character, against the matching line in `SHA256SUMS` on the Releases page.

### Linux

```bash
sha256sum LaurevineRose-1.0.0-x86_64.AppImage
```

If you have downloaded `SHA256SUMS` into the same directory as the release Assets, you can verify all of them at
once:

```bash
sha256sum -c SHA256SUMS
```

### If the hashes do not match

Computing a hash only tells you what the file currently contains. It does **not** by itself prove the file is
safe. Integrity is established by comparing the computed hash against the hash **independently published by the
project** (ideally read from the Releases page over a connection you trust, not copied from the same download you
are verifying). If the two values differ, do not run the file: delete it and download it again from the official
Releases page. If the mismatch persists across a fresh download, do not run the file and report the discrepancy.

Laurevine Rose release binaries are not currently digitally signed; SHA-256 verification against the
project-published manifest is the supported integrity check.

---

## System Requirements

| | Verified from repository | Notes |
| :--- | :--- | :--- |
| **Architecture** | x86_64 (64-bit) | All four distribution formats target x86_64; no ARM build is documented. |
| **Python (source/dev use only)** | 3.10 or later, tested through 3.14 | Stated in the project's own README; not required for packaged installers, which bundle their own runtime. |
| **Operating systems** | Windows, Linux | Matches the two packaged distribution formats. |
| **Optional: TeX Live** | `pdflatex`, `xelatex`, `lualatex`, `pgfplots` | Only required for the LaTeX/PGFPlots Studio; all other features work without it. |
| **Optional: LibreOffice** (`soffice`) | - | Only required for PDF export; native `.pptx` export does not need it. |

If TeX Live or LibreOffice are absent, the application starts normally and reports their absence in its runtime
self-check; all core slide editing, PowerPoint export, structured plots, and Python-based figures remain fully
functional.

---

## Technology Stack

| Technology | Role | Where it is used | Dependency type | Version (verified) | Docs |
| :--- | :--- | :--- | :--- | :--- | :--- |
| HTML5 / CSS3 | Editor UI markup and styling | `index.html`, `css/` | Runtime | - | [MDN](https://developer.mozilla.org/) |
| Vanilla JavaScript | Frontend application logic, canvas rendering, ribbon, dialogs | `js/` | Runtime | - | [MDN](https://developer.mozilla.org/docs/Web/JavaScript) |
| Electron | Desktop application shell; creates the app window and launches the local backend | `main.js`, `preload.js` | Runtime (desktop packaging) | `^44.9.0` | [electronjs.org](https://www.electronjs.org/) |
| Python | Backend language | `backend/`, `run.py` | Runtime | `>=3.10` | [python.org](https://www.python.org/) |
| FastAPI | Local HTTP API service exposed on loopback | `backend/server.py` | Runtime | `>=0.110.0,<1.0.0` | [fastapi.tiangolo.com](https://fastapi.tiangolo.com/) |
| Uvicorn | ASGI server hosting the FastAPI app | `run.py` | Runtime | `>=0.28.0,<1.0.0` | [uvicorn.org](https://www.uvicorn.org/) |
| Pydantic | Document and figure schema validation | `backend/models.py` | Runtime | `>=2.0.0,<3.0.0` | [docs.pydantic.dev](https://docs.pydantic.dev/) |
| python-pptx | Native PowerPoint (.pptx) file generation | `backend/exporter.py` | Runtime | `>=1.0.0,<2.0.0` | [python-pptx.readthedocs.io](https://python-pptx.readthedocs.io/) |
| Matplotlib | Chart and figure rendering engine | `backend/figures/` | Runtime | `>=3.8.0,<4.0.0` | [matplotlib.org](https://matplotlib.org/) |
| NumPy | Numerical computation for figure data | `backend/figures/` | Runtime | `>=1.26.0,<3.0.0` | [numpy.org](https://numpy.org/) |
| Pandas | Dataset and tabular data processing | `backend/figures/` | Runtime | `>=2.1.0,<4.0.0` | [pandas.pydata.org](https://pandas.pydata.org/) |
| SciPy | Statistical fitting and distributions for plots | `backend/figures/` | Runtime | `>=1.11.0,<2.0.0` | [scipy.org](https://scipy.org/) |
| Poppler (`pdftoppm`, `pdfinfo`) | Rasterizes compiled LaTeX PDF output to PNG | `backend/figures/` (LaTeX pipeline) | Optional runtime (system package) | - | [poppler.freedesktop.org](https://poppler.freedesktop.org/) |
| python-multipart | Parses multipart form data and CSV uploads | `backend/server.py` | Runtime | `>=0.0.9,<1.0.0` | [PyPI](https://pypi.org/project/python-multipart/) |
| TeX Live (`pdflatex`/`xelatex`/`lualatex`, `pgfplots`) | Compiles LaTeX/TikZ/PGFPlots figures | LaTeX/PGFPlots Studio | Optional runtime | - | [tug.org/texlive](https://www.tug.org/texlive/) |
| LibreOffice (`soffice`) | Converts exported presentations to PDF | PDF export pipeline | Optional runtime | - | [libreoffice.org](https://www.libreoffice.org/) |
| pytest | Automated backend and integration test suite | `tests/*.py` | Testing (dev) | `>=8.0.0,<10.0.0` | [docs.pytest.org](https://docs.pytest.org/) |
| httpx | HTTP client used by backend API tests | `tests/*.py` | Testing (dev) | `>=0.27.0,<1.0.0` | [python-httpx.org](https://www.python-httpx.org/) |
| Playwright | Browser automation for end-to-end checks | `tests/verify_browser.py` | Testing (dev) | `>=1.40.0,<2.0.0` | [playwright.dev](https://playwright.dev/) |
| Node.js | Runs frontend JavaScript unit-check scripts; Electron's runtime | `tests/test_*.js`, Electron shell | Runtime (desktop) / Testing (dev) | - | [nodejs.org](https://nodejs.org/) |
| PyInstaller | Bundles the Python backend into a standalone executable for packaging | `run.spec` | Build/packaging (dev) | - | [pyinstaller.org](https://pyinstaller.org/) |

*Only dependencies confirmed in `package.json`, `requirements.txt`, `requirements-dev.txt`, `pyproject.toml`, and
the corresponding source files are listed. Version ranges are copied directly from the project's own dependency
declarations rather than assumed.*

---

## Architecture & Internal Workflow

```
+-----------------------------------------------------------------------------------------+
|                         Electron Desktop Shell (main.js / preload.js)                   |
|  - Creates the application window, shows a splash screen while the backend starts       |
|  - Spawns and supervises the local Python backend process                               |
+--------------------------------------------+--------------------------------------------+
                                             |
+--------------------------------------------v--------------------------------------------+
|                          Frontend Editor (HTML / CSS / vanilla JS)                      |
|  - 1280x720 fixed logical coordinate system (16:9 canvas)                               |
|  - Single-source-of-truth document store with undo/redo                                 |
|  - Ribbon UI, canvas renderer, dialogs, Scientific Figure Studio UI                      |
+--------------------------------------------+--------------------------------------------+
                                             | HTTP on loopback (127.0.0.1), session-token authenticated
+--------------------------------------------v--------------------------------------------+
|                           Local FastAPI Service (run.py)                                |
|  - Endpoints: /api/figures/*, /api/presentation/export, /api/health, /api/session        |
|  - Loopback-only binding, host/origin checks, per-session token, job rate limiting       |
+---------------------+-------------------------------+-----------------------------------+
                      |                               |
       +--------------v---------------+ +-------------v-------------+
       |   Figure codegen & runner    | |   LaTeX compiler pipeline |
       |  - Matplotlib/Seaborn/NumPy  | |  - pdflatex/xelatex/lualatex
       |  - Isolated subprocesses     | |  - pdftoppm rasterization  |
       +--------------+---------------+ +-------------+-------------+
                      |                               |
                      +---------------+---------------+
                                      | High-resolution PNG / PDF artifacts
+-------------------------------------v---------------------------------------------------+
|                         Native PowerPoint Exporter (python-pptx)                        |
|  - backend/exporter.py generates native shape trees, fonts, and placeholders            |
|  - Figures embedded as high-resolution picture objects                                  |
+-------------------------------------------------------------------------------------------+
```

This diagram reflects the division of responsibility actually present in the source tree (Electron shell → vanilla
JS frontend → local FastAPI service → isolated figure/LaTeX subprocesses → python-pptx exporter); it omits
components that are not part of the implementation.

---

## Supported Formats & Compatibility

| Format | Direction | Status | Notes |
| :--- | :--- | :--- | :--- |
| `.rpe.json` (project file) | Save / Open | Fully implemented | Native project format; preserves live figure data and source code |
| `.pptx` (PowerPoint) | Export | Fully implemented | Native OpenXML generation via python-pptx; opens in PowerPoint, Keynote, Google Slides, LibreOffice Impress |
| `.pptx` (PowerPoint) | Import | Beta | Figures imported from a `.pptx` are treated as static pictures, not live, editable figure records |
| `.pdf` | Export | Fully implemented, requires LibreOffice | Converts the exported presentation to PDF via LibreOffice; native `.pptx` export does not require this step |
| `.csv` | Import | Fully implemented | Drag-and-drop import into the Structured Plots data grid, with automatic delimiter detection |
| `.py` (Python figure script) | Export | Fully implemented | Standalone, reproducible script download from Python Figure Studio |
| `.tex` / `.pdf` (LaTeX source/output) | Export | Fully implemented | Download the LaTeX source or compiled PDF from the LaTeX/PGFPlots Studio |

---

## Frequently Asked Questions

**Do I need Python or LaTeX installed to open a presentation exported from Laurevine Rose?**  
No. A `.pptx` exported from Laurevine Rose is a standard PowerPoint file that can be opened in compatible presentation software, such as Microsoft PowerPoint or LibreOffice Impress. Figures are embedded as static, high-resolution images. Python and an optional TeX distribution are only relevant to users creating or re-editing figures within Laurevine Rose.

**Why does a figure in my exported PowerPoint file look static when it was interactive-looking while editing?**  
By design. PowerPoint does not preserve live Matplotlib plots or LaTeX/PGFPlots figures as interactive objects. Laurevine Rose renders each figure to a high-resolution image during export. The editable figure data and source code are stored in the `.rpe.json` project file, which should be kept alongside the exported presentation.

**Can I edit a figure in a PowerPoint presentation exported from Laurevine Rose?**  
Yes, within the limitations of the exported format. You can move, resize, or replace the embedded figure image in compatible presentation software, but you cannot directly edit its underlying data or Python/LaTeX source. To regenerate or modify a figure, retain the original `.rpe.json` project file.

**Can I open an existing `.pptx` presentation in Laurevine Rose?**
Yes. Laurevine Rose supports importing existing PowerPoint presentations (`.pptx`), allowing you to bring your slides into the application and customize them. Import compatibility is currently limited, so complex layouts and certain elements may not be preserved perfectly.

**Does the LaTeX/PGFPlots Studio download or install TeX packages automatically?**  
No. Laurevine Rose does not run `pip`, `tlmgr`, or any package or font downloader on your behalf. If a required LaTeX package is missing, the compiler reports the error, and you can install the missing dependency through your own TeX distribution's package manager.

**Is my data sent anywhere when I render a plot or compile a LaTeX figure?**  
No. Figure rendering and LaTeX compilation run in local subprocesses on your machine. The local API server binds only to loopback addresses by default. See [Privacy & Security](#privacy--security) for more information.

**What happens if a Python figure script throws an error?**  
The previous successful render remains visible in a dimmed state instead of disappearing. Laurevine Rose displays the error traceback and lets you jump directly to the offending line in the code editor.

---

## Troubleshooting

- **A downloaded installer or AppImage will not run.** Re-download the file and verify its SHA-256 hash against
  the project's published `SHA256SUMS` (see [Download Integrity](#download-integrity-sha-256)) before trying
  again; a partial or corrupted download is the most common cause.
- **"This app can't run on your PC" / wrong architecture.** All current builds target x86_64; confirm your system
  is 64-bit and not ARM-based.
- **AppImage will not launch or shows a permissions error.** Ensure the file is marked executable
  (`chmod +x LaurevineRose-1.0.0-x86_64.AppImage`) and that your filesystem mount supports execution (some
  network or `noexec`-mounted filesystems block this).
- **The application window opens but shows a backend error.** This generally means the bundled local Python
  backend failed to start or bind to a loopback port; check that no other process is holding the port the
  application tried to use, and that your security software is not blocking loopback connections.
- **Hash mismatch after verification.** Do not run the file. Delete it, re-download from the official Releases
  page, and verify again. A persistent mismatch should be reported rather than worked around.
- **"LaTeX not found on PATH."** Install a TeX distribution providing `pdflatex`/`xelatex`/`lualatex` and
  `pgfplots`, and ensure its binaries are on your system `PATH`.
- **"LibreOffice not found" when exporting PDF.** Install LibreOffice; native `.pptx` export does not require it.

Avoid disabling your operating system's security protections (SmartScreen, Gatekeeper-equivalents, antivirus) as a
first response to an installation warning. Verify the file's checksum instead.

---

## Known Limitations

- **Not independently code-signed.** Release binaries are not currently digitally signed; integrity is established
  through the published SHA-256 checksums rather than a code-signing certificate chain.
- **The local backend is not sandboxed.** Python scripts and LaTeX documents run with the permissions of the user
  running the application. See [Privacy & Security](#privacy--security) for the full trust model and how to run
  untrusted scripts in an isolated environment.
- **Architecture coverage.** All four packaged distribution formats currently target x86_64 only; no ARM build is
  documented in this snapshot of the project.
- **Packaging configuration.** This repository includes a PyInstaller specification (`run.spec`) for bundling the Python backend. Refer to this file for the backend packaging configuration. The repository also supports packaging the application as a Linux AppImage. Dedicated `.deb` and `.rpm` packages are not provided.
- **Distribution compatibility is not exhaustively verified.** Broad compatibility across every
  derivative distribution is not independently confirmed.

---

## Privacy & Security

Laurevine Rose's local server is designed for single-user desktop use. The sections below summarize the trust
model documented in the project's own `docs/SECURITY.md`; nothing here describes a feature the code does not
implement.

**What the server does:**
- Binds strictly to loopback addresses (`127.0.0.1`, `::1`) by default; a non-loopback host is refused unless
  explicitly overridden by the person running it.
- Checks the `Host` header on incoming requests (blocking DNS-rebinding attacks) and enforces same-origin requests
  with no wildcard CORS.
- Issues a random per-session token on startup, required as an `X-RPE-Token` header on figure-related API calls, so
  that another website cannot silently trigger code execution through your browser.
- Enforces request size limits and a per-minute rate limit on job-starting endpoints (render, export, Python run,
  LaTeX compile).
- Runs Python scripts and LaTeX documents in an isolated child process with a scrubbed environment, a timeout,
  output size caps, and (on POSIX systems) CPU/memory/file-size resource limits.
- Disables LaTeX shell escape (`-no-shell-escape`) and pre-scans LaTeX source for references to absolute paths,
  parent-directory traversal, or home-directory paths before compiling.

**What it explicitly does not do:**
- It is **not a sandbox.** A script you run can read and write any file your user account can access, start other
  programs, and use the network; resource limits are POSIX-only and do not apply on Windows.
- It does not automatically install or download any package, font, or dependency.
- The session token and host/origin checks protect against other websites and browser-based drive-by requests.
  They do not protect against other software already running on your own machine.
- Presentation and `.rpe.json` files can contain embedded scripts; opening or importing a file never executes any
  script automatically. Scripts run only when you explicitly press Run, Compile, Insert, or Export.

For untrusted Python or LaTeX source, run the application inside a disposable container or virtual machine rather
than on your primary environment. No telemetry, analytics, or data-collection mechanism was found in the audited
source; this documentation does not claim the absence of all possible data collection beyond what the code
reviewed here implements.

---

## Development & Testing

> This section is for contributors building from source. It is separate from end-user installation above; most
> users should use a packaged release instead.

### Setting up a development environment

```bash
pip install -r requirements.txt
pip install -r requirements-dev.txt   # optional: needed for the test suite
```

### Verifying your environment

```bash
python -m backend.figures.selfcheck
# or, for machine-readable output:
python -m backend.figures.selfcheck --json
```

This inspects installed plotting libraries, available TeX engines, and LibreOffice, and reports what is present.

### Running the application from source

```bash
python run.py
# or, to auto-open a browser once the server is ready:
python run.py --open
```

If port 8000 is already in use, `run.py` automatically selects the next free port and prints the active URL.

### Running the Electron desktop shell from source

```bash
npm install
npm start
```

### Running the automated test suite

```bash
pytest -v
node tests/test_js_checks.js
```

Focused frontend suites are also available individually, for example:

```bash
node tests/test_typography.js
node tests/test_palettes.js
node tests/test_layouts.js
node tests/test_symbols.js
```

### Packaging from source

```bash
python scripts/download_fonts.py     # populate fonts/ for offline vector rendering
python scripts/make_zip.py [dist/output.zip]   # clean distribution archive
```

The AppImage build script that used to live at `scripts/build_appimage.py` has been removed from the repository.
The `.AppImage` release listed in [Installation](#installation) is now produced outside this script; there is
currently no bundled tooling in the source tree for building it yourself.

For acceptance-testing procedures and deeper architectural detail, see`docs/ARCHITECTURE.md`.

---

## Contributing & Feature Requests

Laurevine Rose is distributed under a custom, source-available license (see [License](#license)), not an
open-source one. You're welcome to read the source and modify it for your own private use, but the standard
open-source expectation of forking the project and distributing your own modified version does **not** apply
here. Reusing any part of the source, design, or interface in another project, including an open-source one,
needs written permission from the copyright holder first.

To report a bug, request a feature, or ask about a use case not covered by this license, contact the project
directly at **[biowess@proton.me](mailto:biowess@proton.me)**. No public issue tracker is referenced in this
documentation; please use the contact address above.

---

## License

Laurevine Rose is **proprietary software**. It is **not** distributed under a standard open-source license (such as
MIT, Apache-2.0, or GPL), and it is not a Creative Commons license either.

It's licensed to you under the **Laurevine Rose Software License Agreement**, a custom license written for this
project. The license covers Biowess's original work in Laurevine Rose: its source code, architecture, interface
and visual design, branding, name, artwork, and documentation. Third-party libraries, frameworks, fonts, and
runtimes bundled with the app stay under their own separate licenses.

In short, you're granted a free, worldwide, non-exclusive license to install, run, and use Laurevine Rose, read
its source, and modify it for your own private use. Without written permission from the copyright holder, you
may not:

- Sell, rent, lease, or charge for Laurevine Rose, or bundle it into a paid product or service.
- Redistribute it, modified or unmodified, under a different name or as your own work.
- Copy, extract, or incorporate its source code, design, interface, algorithms, or modules into another project,
  open-source or otherwise.
- Remove or alter its copyright and license notices.
- Use the Laurevine Rose name, logo, or artwork to identify any other product.

Presentations and other content you create with the app remain entirely yours; the license makes no claim over
your own work. See the [LICENSE](LICENSE.txt) file for the full terms, including how the license terminates on
a material violation and the warranty disclaimer.

Copyright © 2026 Biowess. All rights reserved in the Original Work as defined in the license.

---

## Contact

For questions, permissions requests, bug reports, or feature suggestions, contact:

**[biowess@proton.me](mailto:biowess@proton.me)**
