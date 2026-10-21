"""Starter scripts for the Python Source tab (GET /api/figures/python/templates, docs/FIGURES_CONTRACT.md s4p).

Every template is self-contained (numpy + matplotlib, fixed random seed), creates its figure with
``plt.subplots(figsize=(w, h))`` and needs neither ``savefig`` nor ``show``. ``HEADER`` documents the output convention
and is the first thing in each template's source.
"""
from __future__ import annotations

from typing import Any, Dict, List

HEADER = """\
# Output convention (Laurevine Rose)
# - Build the figure with plt.subplots(figsize=(width_in, height_in)); the size is in inches.
# - The open pyplot figure with the LOWEST number is captured. Extra figures are reported, not exported.
# - No savefig or show call is needed: the app saves the figure itself. Keep it open (no plt.close()).
# - Only numpy and matplotlib are used here; any other import must already be installed.
"""

_BODIES: List[Dict[str, Any]] = [
    {"id": "line", "name": "Line plot", "sizeIn": [6.0, 4.0],
     "description": "One line with markers, axis labels and a grid.",
     "body": '''\
import numpy as np
import matplotlib.pyplot as plt

x = np.linspace(0, 10, 50)
y = np.sin(x) * np.exp(-x / 8)

fig, ax = plt.subplots(figsize=(6, 4), layout="constrained")
ax.plot(x, y, color="#1f5fa8", linewidth=1.8, marker="o", markersize=3, label="damped sine")
ax.set_xlabel("Time (s)")
ax.set_ylabel("Amplitude (a.u.)")
ax.grid(alpha=0.3)
ax.legend(frameon=False)
'''},
    {"id": "scatter", "name": "Scatter, multiple series", "sizeIn": [6.0, 4.0],
     "description": "Three point clouds with one colour and one legend entry per series.",
     "body": '''\
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(7)                      # fixed seed: the figure is reproducible
series = {"A": (0, 0, "#1f5fa8"), "B": (2, 1, "#d1495b"), "C": (-1, 2.5, "#2a9d8f")}

fig, ax = plt.subplots(figsize=(6, 4), layout="constrained")
for name, (cx, cy, color) in series.items():
    ax.scatter(rng.normal(cx, 0.6, 40), rng.normal(cy, 0.6, 40), s=18, color=color, alpha=0.8, label=name)
ax.set_xlabel("Feature 1")
ax.set_ylabel("Feature 2")
ax.legend(title="Group", frameon=False)
'''},
    {"id": "bar", "name": "Bar chart", "sizeIn": [5.0, 3.5],
     "description": "Bars with error bars and value labels.",
     "body": '''\
import numpy as np
import matplotlib.pyplot as plt

groups = ["Control", "Dose 1", "Dose 2", "Dose 3"]
means = np.array([3.1, 4.4, 5.8, 6.3])
errors = np.array([0.4, 0.5, 0.6, 0.5])

fig, ax = plt.subplots(figsize=(5, 3.5), layout="constrained")
bars = ax.bar(groups, means, yerr=errors, capsize=4, color="#1f5fa8", edgecolor="black", linewidth=0.6)
ax.bar_label(bars, fmt="%.1f", padding=6)
ax.set_ylabel("Response (a.u.)")
ax.set_ylim(0, 8)
'''},
    {"id": "hist", "name": "Histogram", "sizeIn": [5.0, 3.5],
     "description": "Distribution of one variable with a mean marker.",
     "body": '''\
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(11)
values = rng.normal(loc=50, scale=8, size=400)

fig, ax = plt.subplots(figsize=(5, 3.5), layout="constrained")
ax.hist(values, bins=20, color="#1f5fa8", edgecolor="white", linewidth=0.6)
ax.axvline(values.mean(), color="#d1495b", linestyle="--", linewidth=1.4, label=f"mean = {values.mean():.1f}")
ax.set_xlabel("Value")
ax.set_ylabel("Count")
ax.legend(frameon=False)
'''},
    {"id": "heatmap", "name": "Heatmap", "sizeIn": [5.0, 4.0],
     "description": "A correlation-style matrix with a colour bar and cell labels.",
     "body": '''\
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(3)
labels = ["a", "b", "c", "d", "e"]
m = np.corrcoef(rng.normal(size=(5, 30)))

fig, ax = plt.subplots(figsize=(5, 4), layout="constrained")
im = ax.imshow(m, cmap="RdBu_r", vmin=-1, vmax=1)
ax.set_xticks(range(len(labels)), labels)
ax.set_yticks(range(len(labels)), labels)
for i in range(len(labels)):
    for j in range(len(labels)):
        ax.text(j, i, f"{m[i, j]:.1f}", ha="center", va="center", fontsize=8)
fig.colorbar(im, ax=ax, label="Correlation")
'''},
    {"id": "two_panel", "name": "Two-panel figure", "sizeIn": [7.0, 3.2],
     "description": "Side-by-side panels sharing one figure, labelled (a) and (b).",
     "body": '''\
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(5)
x = np.linspace(0, 2 * np.pi, 100)

fig, (left, right) = plt.subplots(1, 2, figsize=(7, 3.2), layout="constrained")
left.plot(x, np.sin(x), color="#1f5fa8", label="sin")
left.plot(x, np.cos(x), color="#d1495b", label="cos")
left.set_xlabel("Angle (rad)")
left.set_ylabel("Value")
left.legend(frameon=False)
right.hist(rng.normal(size=300), bins=16, color="#2a9d8f", edgecolor="white", linewidth=0.6)
right.set_xlabel("Sample")
right.set_ylabel("Count")
for ax, tag in ((left, "(a)"), (right, "(b)")):
    ax.set_title(tag, loc="left", fontweight="bold")
'''},
]

TEMPLATES: List[Dict[str, Any]] = [
    {"id": t["id"], "name": t["name"], "description": t["description"], "sizeIn": t["sizeIn"],
     "source": HEADER + "\n" + t["body"]} for t in _BODIES]


def list_templates() -> Dict[str, Any]:
    """-> {templates: [{id, name, description, sizeIn, source}]}; sizeIn is the figsize the script itself sets."""
    return {"templates": [dict(t, sizeIn=list(t["sizeIn"])) for t in TEMPLATES]}


# ------------------------------------------------------------------ LaTeX (GET /api/figures/latex/templates, contract s4u)
_TEX: List[Dict[str, Any]] = [
    {"id": "line_plot", "name": "Line plot (pgfplots)",
     "description": "Standalone figure: a function and a data series with axis labels, grid and legend.",
     "source": r'''\documentclass[border=6pt]{standalone}
\usepackage{pgfplots}
\pgfplotsset{compat=1.16}
\begin{document}
\begin{tikzpicture}
  \begin{axis}[
      width=9cm, height=6cm, grid=major, grid style={gray!25},
      xlabel={Time (s)}, ylabel={Amplitude (V)},
      legend pos=north east, legend cell align=left]
    \addplot[blue!70!black, very thick, domain=0:10, samples=120] {sin(deg(x)) * exp(-x/8)};
    \addlegendentry{damped sine}
    \addplot[red!70!black, thick, mark=*, mark size=1.6pt] coordinates {
      (0,0) (1,0.74) (2,0.68) (3,0.10) (4,-0.46) (5,-0.51) (6,-0.13) (7,0.27) (8,0.36)};
    \addlegendentry{measured}
  \end{axis}
\end{tikzpicture}
\end{document}
'''},
    {"id": "scatter_fit", "name": "Scatter with linear fit (pgfplots)",
     "description": "Standalone figure: points from an inline table and a least-squares line computed by pgfplots.",
     "source": r'''\documentclass[border=6pt]{standalone}
\usepackage{pgfplots}
\usepackage{pgfplotstable}
\pgfplotsset{compat=1.16}
\pgfplotstableread[row sep=\\]{
  x    y    \\
  1.0  2.3  \\
  2.0  4.1  \\
  3.0  6.4  \\
  4.0  7.9  \\
  5.0  10.2 \\
  6.0  11.8 \\
  7.0  14.3 \\
  8.0  15.9 \\
}\data
\begin{document}
\begin{tikzpicture}
  \begin{axis}[
      width=9cm, height=6cm, grid=major, grid style={gray!25},
      xlabel={$x$}, ylabel={$y$}, legend pos=north west, legend cell align=left]
    \addplot[only marks, mark=*, mark size=2pt, blue!70!black]
      table[x=x, y=y] {\data};
    \addlegendentry{data}
    \addplot[no marks, thick, red!70!black]
      table[x=x, y={create col/linear regression={y=y}}] {\data};
    \addlegendentry{fit: $y = \pgfmathprintnumber[precision=2]{\pgfplotstableregressiona}\,x
      + \pgfmathprintnumber[precision=2]{\pgfplotstableregressionb}$}
  \end{axis}
\end{tikzpicture}
\end{document}
'''},
    {"id": "grouped_bar", "name": "Grouped bar chart (pgfplots)",
     "description": "Standalone figure: three groups with two series and a legend below the axis.",
     "source": r'''\documentclass[border=6pt]{standalone}
\usepackage{pgfplots}
\pgfplotsset{compat=1.16}
\begin{document}
\begin{tikzpicture}
  \begin{axis}[
      ybar, bar width=14pt, width=9cm, height=6cm,
      symbolic x coords={Control, Low dose, High dose}, xtick=data,
      ymin=0, ymajorgrids, grid style={gray!25}, enlarge x limits=0.25,
      ylabel={Response (a.u.)},
      legend style={at={(0.5,-0.18)}, anchor=north, legend columns=-1}]
    \addplot[fill=blue!60] coordinates {(Control,3.1) (Low dose,4.8) (High dose,6.2)};
    \addplot[fill=orange!80] coordinates {(Control,2.9) (Low dose,3.7) (High dose,4.1)};
    \legend{Treated, Untreated}
  \end{axis}
\end{tikzpicture}
\end{document}
'''},
    {"id": "document_math", "name": "Document with equations",
     "description": "A full article-class document: aligned equations, a matrix and an integral. Compiled exactly as written.",
     "source": r'''\documentclass[11pt]{article}
\usepackage[margin=2.5cm]{geometry}
\usepackage{amsmath,amssymb}
\begin{document}
\section*{Linear least squares}
Given $A \in \mathbb{R}^{m \times n}$ with full column rank and $b \in \mathbb{R}^m$, the minimiser of
$\lVert Ax - b \rVert_2^2$ satisfies the normal equations
\begin{align}
  A^{\mathsf T} A\,\hat{x} &= A^{\mathsf T} b, \\
  \hat{x} &= (A^{\mathsf T} A)^{-1} A^{\mathsf T} b.
\end{align}
For a straight-line fit through $(t_i, y_i)$ this reads
\[
  \begin{pmatrix} \sum 1 & \sum t_i \\ \sum t_i & \sum t_i^2 \end{pmatrix}
  \begin{pmatrix} a \\ b \end{pmatrix}
  =
  \begin{pmatrix} \sum y_i \\ \sum t_i y_i \end{pmatrix},
  \qquad
  \int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}.
\]
\end{document}
'''},
]


def list_latex_templates() -> Dict[str, Any]:
    """-> {templates: [{id, name, description, mode, engine, source}]}; every source is a complete document (mode 'document')."""
    return {"templates": [dict(t, mode="document", engine="pdflatex") for t in _TEX]}
