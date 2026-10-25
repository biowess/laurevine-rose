# Scientific Figure Studio — User Guide

A task-based guide for authoring, editing, and inserting publication-quality scientific figures into research presentations.

---

## Table of Contents
1. [Overview & The Four Tools](#overview--the-four-tools)
2. [Tool 1: Structured Plots](#tool-1-structured-plots)
3. [Tool 2: Python Figure Studio](#tool-2-python-figure-studio)
4. [Tool 3: Multi-Panel Figure Composer](#tool-3-multi-panel-figure-composer)
5. [Tool 4: LaTeX / PGFPlots Studio](#tool-4-latex--pgfplots-studio)
6. [Managing Projects vs Exporting Presentations](#managing-projects-vs-exporting-presentations)
7. [Pre-Flight Research Checks](#pre-flight-research-checks)

---

## Overview & The Four Tools

Scientific Figure Studio integrates four specialized visualization workflows directly into the presentation editor:

| Tool | Typical Use Case | Engine / Backend |
| :--- | :--- | :--- |
| **Structured Plots** | Standard scientific plots with interactive controls and spreadsheet data | Code generation → Matplotlib |
| **Python Figure Studio** | Custom Matplotlib/Seaborn scripts, custom transforms, advanced styling | Isolated Python subprocess |
| **Multi-Panel Composer** | Multi-panel figures with subfigure labels (A, B, C) and shared legends | GridSpec script assembly |
| **LaTeX / PGFPlots** | Publication-grade mathematical diagrams, TikZ networks, PGFPlots charts | pdflatex / xelatex / lualatex |

All figures are compiled on the local backend and inserted into the presentation as high-resolution images linked to their live source models.

---

## Tool 1: Structured Plots

Use Structured Plots to quickly build publication charts with graphical controls, data mapping, and custom styles.

### Step-by-Step Task: Create a Plot
1. On the ribbon, click **Insert** → **Plot** (or **Figures** tab → **New Plot**).
2. Choose one of the six supported plot types:
   - **Line Plot**: Time series, trend curves, confidence intervals, error bars.
   - **Scatter Plot**: Correlations, multi-variable groupings, regression lines.
   - **Bar Chart**: Categorical comparisons, grouped bars, stacked bars, error bars.
   - **Histogram**: Frequency distributions, kernel density estimations (KDE), bin adjustments.
   - **Box Plot**: Multi-group quartiles, median, whiskers, outlier highlights.
   - **Heatmap**: Correlation matrices, 2D density maps, custom colormaps, annotations.
3. Supply your data via the **Data** tab:
   - **Sample Data**: Select a built-in scientific dataset (e.g., Iris, Palmer Penguins, Brain-Body Weights).
   - **CSV Import**: Click **Import CSV...** to upload a local file. The CSV wizard automatically parses separators and validates column types.
   - **Spreadsheet Grid**: Directly edit cell values, insert/remove rows and columns, or paste data from Excel/Google Sheets.
   - **Python Data Generator**: Click **Python Data** to write a Python snippet that generates a dictionary or pandas DataFrame.
4. Configure mappings and appearance in the **Plot Options** tab:
   - Assign columns to X, Y, Hue, or Category axes.
   - Set titles, axis labels, limits, scale (linear or logarithmic), and tick orientations.
   - Customize color palettes, markers, line widths, and font sizes.
5. In the **Export & Insert** tab:
   - Choose dimensions (width/height in inches) and DPI (default: 300 DPI for print, up to 1200 DPI).
   - Click **Insert into Slide**. The figure is rendered at high resolution and placed onto the active slide.

---

## Tool 2: Python Figure Studio

Use Python Figure Studio when you need full control over Matplotlib, Seaborn, NumPy, or SciPy code.

### Step-by-Step Task: Author a Custom Script
1. On the ribbon, click **Insert** → **Python Plot**.
2. Select a template from the **Templates** dropdown (e.g., *Publication Line Chart*, *Contour Map*, *Violin Distribution*) or start from scratch.
3. Edit your plotting script in the integrated code editor:
   - Full Python syntax highlighting, automatic indentation, and bracket matching.
   - Matplotlib's `plt.figure(figsize=(w, h))` is automatically sized according to your export settings.
4. Run and preview:
   - Click **Run** or press `Ctrl + Enter`.
   - The script runs in an isolated Python interpreter with a 30-second timeout.
   - Standard output and error messages appear in the collapsible console output drawer below the preview.
   - If an error occurs, the previous successful preview remains visible in dimmed state, and clicking an error line jumps directly to the line in the code editor.
5. Standalone Script Export:
   - Click **Export Script** to download a self-contained `.py` file containing header metadata and instructions to run locally.
6. Click **Insert into Slide** to render the final image at full DPI and place it on your slide.

---

## Tool 3: Multi-Panel Figure Composer

Combine multiple subplots into a single unified figure grid with publication subfigure labels and aligned axes.

### Step-by-Step Task: Compose a Multi-Panel Figure
1. On the ribbon, click **Insert** → **Multi-Panel Figure**.
2. Select a composite layout from the layout picker:
   - `2x2`: Standard 4-panel grid.
   - `1x2`: Two horizontal side-by-side panels.
   - `2x1`: Two vertical stacked panels.
   - `1x3`: Three horizontal panels in a row.
   - `1+2`: One prominent top panel spanning across, two bottom subplots.
   - `2x3`: Six-panel grid (2 rows, 3 columns).
3. Assign plots to panels:
   - Click any vacant slot to assign an existing figure from your project or create a new subpanel plot.
4. Configure layout controls:
   - **Subpanel Labels**: Choose `A, B, C...`, `a, b, c...`, or `None`. Customize font, font size, weight, and position relative to each subpanel's bounding box.
   - **Panel Spacing**: Select `Tight`, `Normal`, or `Wide` spacing between columns and rows.
   - **Shared Legend**: Consolidate identical legends across panels into a single legend placed at the `Bottom` or `Right`.
5. Preview the composite figure, inspect alignment, and click **Insert into Slide**.

---

## Tool 4: LaTeX / PGFPlots Studio

Compile standalone LaTeX snippets, TikZ diagrams, and PGFPlots charts directly into crisp, vector-accurate slide figures.

### Step-by-Step Task: Compile LaTeX Source
1. On the ribbon, click **Insert** → **LaTeX / PGFPlots**.
2. Select a starter template (e.g., *PGFPlots Scatter with Axis*, *TikZ Neural Network*, *Commutative Diagram*) or paste your TeX code.
3. Select your compiler engine:
   - **pdflatex**: Standard LaTeX compiler for portable documents.
   - **xelatex**: Unicode and system TrueType/OpenType font support via `fontspec`.
   - **lualatex**: Modern LuaTeX engine with extended TeX memory and Lua scripting.
4. Click **Compile** (`Ctrl + Enter`).
   - The engine compiles the document, produces a PDF, and rasterizes it to high-resolution PNG using Poppler's `pdftoppm`.
   - If compilation warnings or errors occur, the log viewer highlights the offending lines with line-number jumps.
5. Export & Insert:
   - Download the standalone `.tex` document or `.pdf` file.
   - Click **Insert into Slide** to place the figure onto your presentation.

---

## Managing Projects vs Exporting Presentations

Understanding the difference between `.rpe.json` project files and exported PowerPoint (`.pptx`) presentations:

### 1. Project Files (`.rpe.json`) — Keep for Editing
- **Format**: JSON file containing the canonical presentation model, slide geometries, full data tables, Python scripts, LaTeX code, and embedded figure assets.
- **Workflow**:
  - Save locally: `File` → `Save` (`Ctrl + S`).
  - Download project: `File` → `Export` → `Project file (.json)`.
  - Reopen anytime: `File` → `Open` → `Open project file...`.
- **Key Invariant**: Reopening an `.rpe.json` file restores live figures with their full underlying configurations and source code.

### 2. PowerPoint Presentations (`.pptx`) — Share & Present
- **Format**: Standard OpenXML presentation file (`.pptx`).
- **Workflow**: `File` → `Export` → `PowerPoint (.pptx)`.
- **Display Guarantee**: All scientific figures are exported as native high-resolution PowerPoint pictures (`PNG`).
- **No Dependencies Required**: Recipients opening the `.pptx` presentation in Microsoft PowerPoint, Apple Keynote, LibreOffice Impress, or Google Slides do **not** need Python, Matplotlib, LaTeX, or any local tools installed.
- **Re-import Note**: PowerPoint presentations imported back into the editor treat figures as static pictures. Keep your `.rpe.json` file to maintain editable source code.

### 3. PDF Presentations (`.pdf`)
- **Workflow**: `File` → `Export` → `PDF (.pdf)`.
- Converts the exported PowerPoint deck to a ready-to-present PDF using the local LibreOffice engine.

---

## Pre-Flight Research Checks

Before presenting or exporting your deck, run pre-flight research checks:
1. Click **Checks** on the ribbon (or open the Research Checks pane).
2. The validator automatically inspects:
   - **Figure Resolution**: Flags figures rendered at under 200 DPI.
   - **Readability**: Warns if axis tick labels or annotations are smaller than 8 pt.
   - **Accessibility**: Verifies that every figure has descriptive alternative text.
   - **Stale Renders**: Detects figures whose underlying data or code was modified after the last successful render.
   - **Failed Renders**: Detects placeholder figures or failed compiles.

### Multi-panel figures: panel sizes
Every panel keeps the size, fonts and whitespace it has on its own (set a panel's width / height after selecting it). Nothing is shrunk to fit: the canvas grows to hold the panels, and the Width / Height in "Size and export" are only the minimum canvas. Panels of different sizes are aligned in their row / column (Align panels) and are never stretched. On the slide a multi-panel figure is a PNG picture, so its text is not editable there; export PDF to keep text and lines as vectors.
