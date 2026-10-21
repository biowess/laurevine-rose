"""CSV import, type inference and plot-mapping validation (docs/FIGURES_CONTRACT.md s3b, s4).

The parser never edits the user's text: it returns the decoded text untouched as ``originalText`` and builds the
working dataset separately. Nothing is coerced silently - every cell that could not be read as the type its
column was given is listed in ``report``.
"""
from __future__ import annotations

import codecs
import csv
import io
import math
import re
from collections import Counter
from itertools import islice
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np

from backend.figures.models import MAX_CELLS, MAX_COLUMNS, MAX_NAME_CHARS, MAX_ROWS, PLOT_TYPES

MAX_BYTES = 5 * 1024 * 1024       # largest file accepted by parse_csv
NUMBER_THRESHOLD = 0.9            # a column is numeric only if >= 90% of its non-empty cells parse as numbers
DELIMITERS = (",", ";", "\t", "|")
PREVIEW_ROWS = 10
REPORT_ITEM_LIMIT = 100           # cap on listed cells/rows per report section (totals are always exact)
MANY_GROUPS = 20

_SNIFF_CHARS = 200_000
_SNIFF_RECORDS = 100
_HEADER_PROBE_ROWS = 200

_NUM = re.compile(r"^[+-]?(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")
_NUM_COMMA = re.compile(r"^[+-]?(?:0|[1-9]\d*),\d+(?:[eE][+-]?\d+)?$")
_INT = re.compile(r"^[+-]?(?:0|[1-9]\d*)$")


class _CsvFailure(Exception):
    pass


def _issue(level: str, code: str, message: str, **extra: Any) -> Dict[str, Any]:
    d: Dict[str, Any] = {"level": level, "code": code, "message": message}
    d.update(extra)
    return d


# ------------------------------------------------------------------ numbers
def _parse_number(s: str, decimal_comma: bool = False) -> Optional[Union[int, float]]:
    """Strict number parser. Returns None for anything that is not a plain finite number.

    Leading zeros ("007") are NOT numbers (they are usually IDs/zip codes); thousands separators, units,
    percent signs, NaN/Inf and Unicode minus signs are rejected rather than guessed at.
    """
    t = s.strip()
    if not t:
        return None
    if _NUM.match(t):
        text = t
    elif decimal_comma and _NUM_COMMA.match(t):
        text = t.replace(",", ".")
    else:
        return None
    if _INT.match(text) and len(text) <= 16:
        v = int(text)
        if abs(v) <= 2 ** 53:
            return v
    try:
        f = float(text)
    except ValueError:
        return None
    return f if math.isfinite(f) else None


# ----------------------------------------------------------------- decoding
def _decode(data: bytes) -> Tuple[str, str, List[Dict[str, Any]]]:
    warnings: List[Dict[str, Any]] = []
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        try:
            return data.decode("utf-16"), "utf-16", warnings
        except UnicodeDecodeError:
            raise _CsvFailure("binary")
    if b"\x00" in data[:8192]:
        raise _CsvFailure("binary")
    try:
        text = data.decode("utf-8-sig")
        return text, ("utf-8-sig" if data.startswith(codecs.BOM_UTF8) else "utf-8"), warnings
    except UnicodeDecodeError:
        warnings.append(_issue(
            "warning", "encoding_fallback",
            "The file is not valid UTF-8, so it was read as Latin-1 (ISO-8859-1); "
            "accented or special characters may look wrong. Re-save the file as UTF-8 if they do."))
        return data.decode("latin-1"), "latin-1", warnings


# ----------------------------------------------------------------- sniffing
def _sniff_delimiter(text: str) -> str:
    truncated = len(text) > _SNIFF_CHARS
    sample = text[:_SNIFF_CHARS]
    best: Optional[Tuple[float, int, int]] = None
    best_delim = ","
    for pri, d in enumerate(DELIMITERS):
        try:
            recs = list(islice(csv.reader(io.StringIO(sample, newline=""), delimiter=d), _SNIFF_RECORDS))
        except csv.Error:
            continue
        if truncated and len(recs) < _SNIFF_RECORDS:
            recs = recs[:-1]  # the sample ended mid-record
        counts = [len(r) for r in recs if r]
        if not counts:
            continue
        modal, n_modal = Counter(counts).most_common(1)[0]
        if modal < 2:
            continue
        score = (n_modal / len(counts), modal, -pri)
        if best is None or score > best:
            best, best_delim = score, d
    return best_delim


def _read_records(text: str, delimiter: str, limit: int) -> Tuple[List[List[str]], int, Optional[int]]:
    """Return (records, skipped blank rows, line of a quoting problem or None)."""
    def run(strict: bool):
        reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter, strict=strict)
        recs: List[List[str]] = []
        blank = 0
        try:
            for rec in reader:
                if not rec or all(not c.strip() for c in rec):
                    blank += 1
                    continue
                recs.append(rec)
                if len(recs) >= limit:
                    break
        except csv.Error as exc:
            return recs, blank, reader.line_num, exc
        return recs, blank, None, None

    recs, blank, line, exc = run(True)
    if exc is None:
        return recs, blank, None
    recs, blank, _, exc2 = run(False)
    if exc2 is not None:
        raise _CsvFailure(str(exc2))
    return recs, blank, line


def _detect_header(records: List[List[str]], decimal_comma: bool) -> bool:
    first, rest = records[0], records[1:1 + _HEADER_PROBE_ROWS]
    header_votes = data_votes = 0
    for c, cell in enumerate(first):
        col = [r[c].strip() for r in rest if c < len(r) and r[c].strip()]
        if not col:
            continue
        numeric = sum(1 for v in col if _parse_number(v, decimal_comma) is not None)
        if numeric / len(col) < NUMBER_THRESHOLD:
            continue
        f = cell.strip()
        if f and _parse_number(f, decimal_comma) is None:
            header_votes += 1
        elif f:
            data_votes += 1
    if header_votes != data_votes:
        return header_votes > data_votes
    cells = [c.strip() for c in first]
    return (all(cells) and len(set(cells)) == len(cells)
            and all(_parse_number(c, decimal_comma) is None for c in cells))


def _column_names(raw: List[str], warnings: List[Dict[str, Any]]) -> List[str]:
    names: List[str] = []
    seen = set()
    for i, cell in enumerate(raw):
        base = cell.strip()
        why = None
        if not base:
            base, why = f"Column {i + 1}", "was empty"
        elif len(base) > MAX_NAME_CHARS:
            base, why = base[:MAX_NAME_CHARS], f"was longer than {MAX_NAME_CHARS} characters"
        name, n = base, 2
        while name in seen:
            name = f"{base} ({n})"
            n += 1
        if name != base and why is None:
            why = "was already used by an earlier column"
        if why:
            warnings.append(_issue("warning", "column_renamed",
                                   f"Column {i + 1}'s header {why}; it is called '{name}'.", column=name))
        seen.add(name)
        names.append(name)
    return names


def _empty_result(text: str, encoding: Optional[str], errors, warnings=None, delimiter: str = ",") -> Dict[str, Any]:
    return {
        "columns": [], "rows": [], "warnings": warnings or [], "errors": errors, "preview": [],
        "delimiter": delimiter, "hasHeader": False, "encoding": encoding, "originalText": text,
        "report": {"rowCount": 0, "columnCount": 0, "truncated": False, "columns": [], "emptyColumns": [],
                   "invalidNumeric": [], "invalidNumericTotal": 0, "raggedRows": [], "raggedTotal": 0},
    }


# ------------------------------------------------------------------- parse
def parse_csv(data: Union[bytes, str], *, delimiter: Optional[str] = None, has_header: Optional[bool] = None,
              max_rows: int = MAX_ROWS, max_bytes: int = MAX_BYTES) -> Dict[str, Any]:
    """Parse CSV bytes/text into a dataset plus a full report of everything that was not clean.

    Returns {columns:[{name,type}], rows, warnings, errors, preview, delimiter, hasHeader, encoding,
    originalText, report}. ``columns``/``rows`` are directly usable as a ``Dataset``. ``delimiter`` and
    ``has_header`` override sniffing/detection (None = automatic).
    """
    if isinstance(data, str):
        if len(data) > max_bytes or len(data.encode("utf-8")) > max_bytes:
            return _empty_result("", None, [_too_large(max_bytes)])
        text, encoding, warnings = data, "text", []
    else:
        if len(data) > max_bytes:
            return _empty_result("", None, [_too_large(max_bytes)])
        try:
            text, encoding, warnings = _decode(bytes(data))
        except _CsvFailure:
            return _empty_result("", None, [_issue(
                "error", "binary_file", "This does not look like a text file. Export your data as CSV and try again.")])

    if not text.strip():
        return _empty_result(text, encoding, [_issue(
            "error", "empty_file", "The file is empty." if not text else "The file contains only blank space; there is no data.")],
            warnings)

    delim = delimiter if delimiter in DELIMITERS else _sniff_delimiter(text)
    try:
        records, blank, quote_line = _read_records(text, delim, max_rows + 2)
    except _CsvFailure as exc:
        return _empty_result(text, encoding, [_issue(
            "error", "malformed_csv", f"The file could not be read as CSV: {exc}.")], warnings, delim)
    if quote_line is not None:
        warnings.append(_issue(
            "warning", "quote_problem",
            f"Some quotation marks are malformed (for example a quote that is never closed), near line {quote_line}. "
            "Rows around there may be merged or misread - check them."))
    if not records:
        return _empty_result(text, encoding, [_issue("error", "empty_file", "The file contains no data.")], warnings, delim)

    decimal_comma = delim != ","
    header = bool(has_header) if has_header is not None else _detect_header(records, decimal_comma)
    ncols = len(records[0])
    preview = [[c[:200] for c in r] for r in records[:PREVIEW_ROWS]]
    if ncols > MAX_COLUMNS:
        res = _empty_result(text, encoding, [_issue(
            "error", "too_many_columns", f"The file has {ncols} columns; the limit is {MAX_COLUMNS}.")], warnings, delim)
        res["preview"], res["hasHeader"] = preview, header
        return res

    names = _column_names(records[0], warnings) if header else [f"Column {i + 1}" for i in range(ncols)]
    body = records[1:] if header else records
    truncated = False
    cap = min(max_rows, MAX_CELLS // ncols)
    if len(body) > cap:
        body, truncated = body[:cap], True
        limit_txt = f"{cap:,} rows" if cap == max_rows else f"{MAX_CELLS:,} cells ({cap:,} rows of {ncols} columns)"
        warnings.append(_issue(
            "warning", "row_cap" if cap == max_rows else "cell_cap",
            f"The file has more than the limit of {limit_txt}; only the first {cap:,} rows were loaded."))
    if blank:
        warnings.append(_issue("info", "blank_rows", f"{blank} blank row{'s were' if blank != 1 else ' was'} skipped."))
    if not body:
        warnings.append(_issue("warning", "no_data_rows", "The file has a header but no data rows."))

    ragged: List[Dict[str, Any]] = []
    ragged_total = 0
    raw_cols: List[List[str]] = [[] for _ in range(ncols)]
    for r, rec in enumerate(body):
        n = len(rec)
        if n != ncols:
            ragged_total += 1
            if len(ragged) < REPORT_ITEM_LIMIT:
                ragged.append({"row": r, "cells": n, "expected": ncols})
            rec = rec[:ncols] + [""] * (ncols - n)
        for c in range(ncols):
            raw_cols[c].append(rec[c])
    if ragged_total:
        f = ragged[0]
        warnings.append(_issue(
            "warning", "ragged_rows",
            f"{ragged_total} row{'s have' if ragged_total != 1 else ' has'} a different number of cells than "
            f"the {'header' if header else 'first row'} ({ncols}); short rows were padded with empty cells and "
            f"extra cells were dropped. First: row {f['row'] + 1} has {f['cells']} cells."))

    columns, values, col_report = [], [], []
    invalid_all: List[Dict[str, Any]] = []
    invalid_total = 0
    empty_cols: List[str] = []
    for c, name in enumerate(names):
        cells = raw_cols[c]
        non_empty = [(i, v) for i, v in enumerate(cells) if v.strip()]
        parsed = [(i, v, _parse_number(v, decimal_comma)) for i, v in non_empty]
        n_num = sum(1 for _, _, p in parsed if p is not None)
        numeric = bool(non_empty) and n_num / len(non_empty) >= NUMBER_THRESHOLD
        invalid = [(i, v) for i, v, p in parsed if p is None] if numeric else []
        if numeric:
            col_vals: List[Any] = [None] * len(cells)
            for i, _, p in parsed:
                col_vals[i] = p
            if any("," in v and p is not None for _, v, p in parsed):
                warnings.append(_issue("info", "decimal_comma",
                                       f"Column '{name}' uses decimal commas (e.g. 1,5); they were read as 1.5.", column=name))
        else:
            col_vals = [v if v.strip() else None for v in cells]
        columns.append({"name": name, "type": "number" if numeric else "text"})
        values.append(col_vals)
        col_report.append({"name": name, "type": columns[-1]["type"], "nonEmpty": len(non_empty),
                           "missing": len(cells) - len(non_empty), "numeric": n_num, "invalid": len(invalid)})
        if body and not non_empty:
            empty_cols.append(name)
            warnings.append(_issue("warning", "empty_column", f"Column '{name}' has no values.", column=name))
        if invalid:
            invalid_total += len(invalid)
            for i, v in invalid:
                if len(invalid_all) < REPORT_ITEM_LIMIT:
                    invalid_all.append({"row": i, "col": c, "column": name, "value": v[:100]})
            i0, v0 = invalid[0]
            warnings.append(_issue(
                "warning", "invalid_numeric",
                f"Column '{name}' is numeric, but {len(invalid)} cell{'s are' if len(invalid) != 1 else ' is'} not a "
                f"number (first: row {i0 + 1}, \"{v0[:40]}\"); {'those cells were' if len(invalid) != 1 else 'that cell was'} "
                "left empty.", column=name))
        elif non_empty and not numeric and n_num:
            warnings.append(_issue(
                "warning", "mixed_column",
                f"Column '{name}' mixes numbers and text ({n_num} of {len(non_empty)} cells are numbers), "
                "so it is treated as text.", column=name))

    rows = [list(r) for r in zip(*values)] if body else []
    return {
        "columns": columns, "rows": rows, "warnings": warnings, "errors": [], "preview": preview,
        "delimiter": delim, "hasHeader": header, "encoding": encoding, "originalText": text,
        "report": {"rowCount": len(rows), "columnCount": ncols, "truncated": truncated, "columns": col_report,
                   "emptyColumns": empty_cols, "invalidNumeric": invalid_all, "invalidNumericTotal": invalid_total,
                   "raggedRows": ragged, "raggedTotal": ragged_total},
    }


def _too_large(max_bytes: int) -> Dict[str, Any]:
    return _issue("error", "file_too_large",
                  f"The file is larger than the {max_bytes / (1024 * 1024):g} MB limit. Remove columns or rows and try again.")


# --------------------------------------------------------- dataset helpers
def _norm_dataset(dataset: Any) -> Tuple[List[str], List[str], List[List[Any]]]:
    if hasattr(dataset, "model_dump"):
        dataset = dataset.model_dump()
    cols = dataset.get("columns", [])
    names = [c["name"] for c in cols]
    types = [c.get("type", "number") for c in cols]
    return names, types, dataset.get("rows", [])


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def to_matrix(dataset: Any, columns: Optional[Sequence[str]] = None) -> np.ndarray:
    """rows x columns float64 array (null -> NaN). Default columns: every numeric column.

    Raises ValueError with a plain-English message if a named column is missing or is text.
    """
    names, types, rows = _norm_dataset(dataset)
    if columns is None:
        columns = [n for n, t in zip(names, types) if t == "number"]
    idx = []
    for n in columns:
        if n not in names:
            raise ValueError(f"Column '{n}' is not in the dataset.")
        i = names.index(n)
        if types[i] != "number":
            raise ValueError(f"Column '{n}' is text; it needs numbers to be used in a matrix.")
        idx.append(i)
    mat = np.full((len(rows), len(idx)), np.nan, dtype=np.float64)
    for r, row in enumerate(rows):
        for j, i in enumerate(idx):
            v = row[i]
            if _is_num(v):
                mat[r, j] = float(v)
    return mat


def correlation_ready_columns(dataset: Any, min_valid: int = 3) -> List[str]:
    """Numeric columns that can enter a correlation: >= min_valid values and not constant."""
    names, types, _ = _norm_dataset(dataset)
    numeric = [n for n, t in zip(names, types) if t == "number"]
    mat = to_matrix(dataset, numeric)
    ready = []
    for j, n in enumerate(numeric):
        v = mat[:, j]
        v = v[~np.isnan(v)]
        if len(v) >= min_valid and float(np.ptp(v)) > 0:
            ready.append(n)
    return ready


# -------------------------------------------------------------- validation
# role -> (needed type 'number'|'any', required) ; None = the plot type does not use that role
_RULES: Dict[str, Dict[str, Optional[Tuple[str, bool]]]] = {
    "line":    {"x": ("number", False), "y": ("number", True), "group": ("any", False), "yErr": ("number", False)},
    "scatter": {"x": ("number", True),  "y": ("number", True), "group": ("any", False), "yErr": ("number", False)},
    "bar":     {"x": ("any", False),    "y": ("number", True), "group": ("any", False), "yErr": ("number", False)},
    "hist":    {"x": None,              "y": ("number", True), "group": ("any", False), "yErr": None},
    "box":     {"x": ("any", False),    "y": ("number", True), "group": ("any", False), "yErr": None},
    "heatmap": {"x": ("any", False),    "y": ("number", False), "group": None,         "yErr": None},
}
_NOUN = {"line": "line plot", "scatter": "scatter plot", "bar": "bar chart", "hist": "histogram",
         "box": "box plot", "heatmap": "heatmap"}
_ROLE = {"x": "the X axis", "y": "the Y axis", "group": "grouping", "yErr": "error bars"}
_ROLE_OVERRIDE = {("hist", "y"): "the values", ("box", "y"): "the values", ("heatmap", "y"): "the cells"}


def validate_dataset(dataset: Any, plotType: str, mapping: Any) -> List[Dict[str, Any]]:
    """Plain-English problems for drawing ``plotType`` from ``dataset`` with ``mapping``.

    Each item is {level:'error'|'warning'|'info', code, column?, message}. Any 'error' means the plot cannot be drawn.
    """
    issues: List[Dict[str, Any]] = []
    if plotType not in _RULES or plotType not in PLOT_TYPES:
        return [_issue("error", "unknown_plot_type", f"'{plotType}' is not a plot type this app can draw.")]
    names, types, rows = _norm_dataset(dataset)
    if not names:
        return [_issue("error", "no_columns", "The dataset has no columns.")]
    if not rows:
        issues.append(_issue("error", "no_rows", "The dataset has no data rows."))
    noun = _NOUN[plotType]
    tmap = dict(zip(names, types))

    def get(key: str) -> Any:
        return mapping.get(key) if isinstance(mapping, dict) else getattr(mapping, key, None)

    y_raw = get("y") or []
    roles = {"x": [get("x")] if get("x") else [], "y": [y_raw] if isinstance(y_raw, str) else list(y_raw),
             "group": [get("group")] if get("group") else [], "yErr": [get("yErr")] if get("yErr") else []}

    for role, cols in roles.items():
        rule = _RULES[plotType][role]
        label = _ROLE_OVERRIDE.get((plotType, role), _ROLE[role])
        if rule is None:
            for n in cols:
                issues.append(_issue("info", "mapping_unused",
                                     f"Column '{n}' is set for {_ROLE[role]}, but a {noun} does not use it.", column=n))
            continue
        need, required = rule
        if plotType == "heatmap" and role == "y":
            pool = cols or [n for n in names if tmap[n] == "number"]
            if len(pool) < 2 or sum(1 for n in pool if tmap.get(n) == "number") < 2:
                have = sum(1 for n in pool if tmap.get(n) == "number")
                issues.append(_issue("error", "too_few_numeric_columns",
                                     f"A heatmap needs at least two numeric columns; {'this selection has' if cols else 'this dataset has'} "
                                     f"{'none' if not have else have}."))
        elif required and not cols:
            issues.append(_issue("error", "mapping_missing", f"A {noun} needs a column for {_ROLE[role]}."))
            continue
        for n in cols:
            if n not in tmap:
                issues.append(_issue("error", "column_missing", f"Column '{n}' is not in the dataset.", column=n))
                continue
            i = names.index(n)
            cells = [r[i] for r in rows]
            if need == "number" and tmap[n] != "number":
                looks = sum(1 for v in cells if isinstance(v, str) and _parse_number(v, True) is not None)
                filled = sum(1 for v in cells if v is not None)
                hint = f" Only {looks} of {filled} values look like numbers." if looks else ""
                issues.append(_issue("error", "column_not_numeric",
                                     f"Column '{n}' is text; {noun} needs numbers for {label}.{hint}", column=n))
                continue
            filled = [v for v in cells if v is not None]
            if rows and not filled:
                issues.append(_issue("error", "column_empty", f"Column '{n}' has no values to plot.", column=n))
                continue
            if rows and len(filled) < len(cells):
                miss = len(cells) - len(filled)
                issues.append(_issue("warning", "missing_values",
                                     f"Column '{n}' has {miss} empty cell{'s' if miss != 1 else ''} out of {len(cells)}; "
                                     "they will be skipped.", column=n))
            if role == "group":
                distinct = len(set(filled))
                if distinct > MANY_GROUPS:
                    issues.append(_issue("warning", "many_groups",
                                         f"Column '{n}' has {distinct} distinct values, so there would be {distinct} groups. "
                                         "Pick a column with fewer categories.", column=n))
    return issues


NOTES_MAX_ROWS = 20000


def column_notes(columns: Sequence[Dict[str, Any]], rows: Sequence[Sequence[Any]], plot_type: str) -> Dict[str, Dict[str, str]]:
    """Why a column cannot take a role in ``plot_type``: ``{column: {role: message}}`` (roles the plot uses; only blocked
    ones appear). Messages are the `validate_dataset` error messages for that single column and role; very long tables are
    checked on their first NOTES_MAX_ROWS rows."""
    if plot_type not in _RULES or plot_type not in PLOT_TYPES:
        return {}
    roles = [r for r in ("x", "y", "group", "yErr") if _RULES[plot_type][r] is not None]
    out: Dict[str, Dict[str, str]] = {}
    for i, col in enumerate(columns):
        slim = {"columns": [{"name": col["name"], "type": col["type"]}], "rows": [[r[i]] for r in list(rows)[:NOTES_MAX_ROWS]]}
        for role in roles:
            mapping = {role: [col["name"]] if role == "y" else col["name"]}
            msgs = [m["message"] for m in validate_dataset(slim, plot_type, mapping)
                    if m["level"] == "error" and m.get("column") == col["name"]]
            if msgs:
                out.setdefault(col["name"], {})[role] = msgs[0]
    return out
