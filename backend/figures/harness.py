"""Child-process entry point for backend.figures.runner (docs/FIGURES_CONTRACT.md s4a, s7).

Started as ``python -I -u harness.py spec.json`` with the work directory as cwd. It applies the resource limits, runs the
user's script with ``__name__ == "__main__"`` under the Agg backend, picks one figure, saves it and writes
``result.json`` (path given in the spec). It must stay standalone: the isolated interpreter cannot import ``backend``.
Exit code: 0 when a figure was saved, 1 otherwise; the parent trusts ``result.json``, not the exit code.
"""
import builtins
import json
import linecache
import math
import os
import sys
import traceback

SCRIPT = "script.py"          # name the user's code is compiled under (tracebacks, linecache)


def _limit_resources(limits):
    """Best effort: not every platform supports every limit. Soft == hard so the script cannot raise them again."""
    try:
        import resource
    except ImportError:           # Windows
        return
    wanted = (("RLIMIT_CPU", limits.get("cpu_seconds")), ("RLIMIT_AS", limits.get("address_space")),
              ("RLIMIT_FSIZE", limits.get("file_size")), ("RLIMIT_CORE", 0))
    for name, value in wanted:
        res = getattr(resource, name, None)
        if res is None or value is None:
            continue
        try:
            hard = resource.getrlimit(res)[1]
            if hard != resource.RLIM_INFINITY:
                value = min(value, hard)
            resource.setrlimit(res, (value, value))
        except (ValueError, OSError):
            pass


def _column(tb):
    """1-based column of the failing expression in a traceback entry (None when the interpreter cannot tell)."""
    try:
        col = list(tb.tb_frame.f_code.co_positions())[tb.tb_lasti // 2][2]
        return None if col is None else col + 1
    except Exception:
        return None


def _fail(result, exc):
    """Record an exception raised by (or while importing for) the user's script; echo the traceback to stderr."""
    tb = exc.__traceback__
    while tb is not None and tb.tb_frame.f_globals is globals():      # hide the harness's own frames
        tb = tb.tb_next
    line, column, frame = None, None, tb
    while frame is not None:
        if frame.tb_frame.f_code.co_filename == SCRIPT:
            line = frame.tb_lineno                                      # innermost frame inside the user's script
            column = _column(frame)
        frame = frame.tb_next
    if isinstance(exc, SyntaxError) and exc.filename == SCRIPT:
        line, column = exc.lineno, exc.offset
    text = "".join(traceback.format_exception(type(exc), exc, tb))
    sys.stderr.write(text)
    detail = str(exc)
    message = f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__
    if isinstance(exc, MemoryError):
        message += " (the script reached the memory limit)"
    result["traceback"] = {"line": line, "column": column, "message": message, "text": text}
    if isinstance(exc, ModuleNotFoundError) and exc.name:
        result.update(
            status="missing_dependency", missing_module=exc.name,
            message=(f"Python module '{exc.name}' is not installed. Laurevine Rose never installs packages "
                     "automatically; install the package that provides it into the Python environment running "
                     "the server, then run again."))
    else:
        result.update(status="error", message=message)


def _size_problem(fig, dpi, lim):
    """None if the figure fits the contract limits (s5), else a readable reason. Checked BEFORE rendering."""
    w, h = (float(v) for v in fig.get_size_inches())
    lo, hi, eps = lim["min_side_in"], lim["max_side_in"], 1e-9
    if not (lo - eps <= w <= hi + eps and lo - eps <= h <= hi + eps):
        return f"Figure size {w:.2f} x {h:.2f} in is outside the allowed {lo:g}-{hi:g} in per side."
    wpx, hpx = round(w * dpi), round(h * dpi)
    if wpx > lim["max_px_side"] or hpx > lim["max_px_side"]:
        return (f"Figure would be {wpx} x {hpx} px at {dpi} dpi; the limit is {lim['max_px_side']} px per side. "
                "Reduce figsize or dpi.")
    if wpx * hpx > lim["max_megapixels"] * 1_000_000:
        return (f"Figure would be {wpx * hpx / 1e6:.0f} megapixels at {dpi} dpi; the limit is "
                f"{lim['max_megapixels']} MP. Reduce figsize or dpi.")
    return None


def _cell(v):
    """JSON-safe cell: numbers stay numbers (NaN/inf -> None), None stays None, everything else becomes text."""
    if hasattr(v, "item") and not isinstance(v, (str, bytes)):
        try:
            v = v.item()                                   # numpy scalar -> Python scalar
        except (ValueError, TypeError):
            pass
    if v is None or (isinstance(v, float) and v != v):
        return None
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, (int, float)):
        return v if math.isfinite(v) else None
    return str(v)


def table_from(obj):
    """Turn ``{name: [values]}`` (also numpy arrays, pandas DataFrame/Series values) into ``(columns, rows)``.
    Raises ValueError with a readable message when the shape is not a table of equal-length columns."""
    if hasattr(obj, "columns") and hasattr(obj, "to_dict"):             # pandas DataFrame
        obj = {str(c): obj[c].tolist() for c in obj.columns}
    if not isinstance(obj, dict) or not obj:
        raise ValueError("`data` must be a dict of named lists, e.g. data = {\"x\": [1, 2, 3], \"y\": [2, 4, 8]}.")
    cols = {}
    for name, vals in obj.items():
        if hasattr(vals, "tolist"):
            vals = vals.tolist()
        if isinstance(vals, (str, bytes, dict)) or not hasattr(vals, "__iter__"):
            raise ValueError(f"Column {str(name)!r} must be a list of values, not {type(vals).__name__}.")
        cols[str(name)] = [_cell(v) for v in vals]
    if len(cols) != len(obj):
        raise ValueError("Column names must be unique once converted to text.")
    n = {len(v) for v in cols.values()}
    if len(n) != 1:
        raise ValueError("All columns must have the same length (found " + ", ".join(f"{k}: {len(v)}" for k, v in cols.items()) + ").")
    kinds = []
    for vals in cols.values():
        present = [v for v in vals if v is not None]
        kinds.append("text" if any(isinstance(v, str) for v in present) else "number")
    out_cols = [{"name": k, "type": t} for k, t in zip(cols, kinds)]
    nrows = n.pop()
    rows = []
    for i in range(nrows):
        rows.append([(None if v is None else (str(v) if t == "text" else v))
                     for v, t in zip((c[i] for c in cols.values()), kinds)])
    return out_cols, rows


def _run_data(result):
    """Data-only mode: run the script, then read its variable ``data``. No figure, no image."""
    with open(SCRIPT, encoding="utf-8") as fh:
        source = fh.read()
    linecache.cache[SCRIPT] = (len(source), None, source.splitlines(True), SCRIPT)
    sys.path.insert(0, os.getcwd())
    sys.argv = [SCRIPT]
    scope = {"__name__": "__main__", "__file__": os.path.abspath(SCRIPT), "__builtins__": builtins}
    try:
        exec(compile(source, SCRIPT, "exec"), scope)
    except SystemExit as exc:
        if exc.code not in (None, 0):
            result.update(status="error", message=f"The script called sys.exit({exc.code!r}).")
            return
    except BaseException as exc:
        _fail(result, exc)
        return
    if "data" not in scope:
        result.update(status="error", message="The script must define a variable named `data`, e.g. data = {\"x\": [1, 2, 3]}.")
        return
    try:
        columns, rows = table_from(scope["data"])
    except ValueError as exc:
        result.update(status="error", message=str(exc))
        return
    result.update(status="ok", message="", data={"columns": columns, "rows": rows})


def _run(spec, result):
    os.environ["MPLBACKEND"] = "Agg"
    if spec.get("mode") == "data":
        _run_data(result)
        return
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ModuleNotFoundError as exc:
        _fail(result, exc)
        return
    plt.show = lambda *args, **kwargs: None            # a script's plt.show() must not block or warn

    with open(SCRIPT, encoding="utf-8") as fh:
        source = fh.read()
    linecache.cache[SCRIPT] = (len(source), None, source.splitlines(True), SCRIPT)   # tracebacks survive os.chdir
    sys.path.insert(0, os.getcwd())                    # like `python script.py`: sibling files are importable
    sys.argv = [SCRIPT]
    scope = {"__name__": "__main__", "__file__": os.path.abspath(SCRIPT), "__builtins__": builtins}
    try:
        exec(compile(source, SCRIPT, "exec"), scope)
    except SystemExit as exc:
        if exc.code not in (None, 0):
            if isinstance(exc.code, str):
                sys.stderr.write(exc.code + "\n")
            result.update(status="error", message=f"The script called sys.exit({exc.code!r}).")
    except BaseException as exc:
        _fail(result, exc)
    nums = plt.get_fignums()                           # sorted ascending
    result["figures_found"] = len(nums)
    if result["message"]:                              # the script failed; nothing is rendered
        return
    if not nums:
        result.update(status="no_figure", message=(
            "The script finished but no figure is open. Create one with plt.subplots() or plt.figure() and don't "
            "close it with plt.close() before the script ends (figures made with matplotlib.figure.Figure() "
            "directly are not tracked by pyplot)."))
        return

    chosen = nums[0]                                   # documented rule: the lowest figure number
    if len(nums) > 1:
        result["warnings"].append(f"{len(nums)} figures created; showing figure #{chosen}")
    fig = plt.figure(chosen)
    dpi = spec["dpi"]
    if not matplotlib.colors.is_color_like(spec["facecolor"]):
        result.update(status="error", message=f"Invalid facecolor {spec['facecolor']!r}.")
        return
    if spec.get("size_in"):                            # the caller's "override script size" (contract s4p)
        fig.set_size_inches(*spec["size_in"])
    problem = _size_problem(fig, dpi, spec["limits"])
    if problem:
        result.update(status="error", message=problem)
        return
    if matplotlib.rcParams["savefig.bbox"] == "tight":  # would make pixels != inches * dpi (contract s5)
        matplotlib.rcParams["savefig.bbox"] = "standard"
        result["warnings"].append("savefig.bbox='tight' is ignored; the figure is saved at its full size")

    # an explicit facecolor would override transparent=True inside savefig, so transparency drops it
    face = "none" if spec["transparent"] else spec["facecolor"]
    try:
        for fmt, path in (("png", spec["png"]), ("pdf", spec["pdf"])):
            if fmt == "png" or spec["format"] == "pdf":
                fig.savefig(path, format=fmt, dpi=dpi, facecolor=face, transparent=spec["transparent"])
    except BaseException as exc:
        _fail(result, exc)
        return
    result.update(status="ok", message="")


def _fork_server_loop():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np
    try:
        import pandas as pd
    except ImportError:
        pass

    sys.stdout.write("READY\n")
    sys.stdout.flush()

    while True:
        line = sys.stdin.readline()
        if not line:
            break
        try:
            req = json.loads(line)
        except Exception:
            continue
        spec_file = req["spec"]
        work_dir = req["work"]
        stdout_file = req.get("stdout")
        stderr_file = req.get("stderr")
        try:
            child = os.fork()
        except OSError as exc:
            sys.stdout.write(json.dumps({"error": f"fork failed: {exc}"}) + "\n")
            sys.stdout.flush()
            continue

        if child == 0:
            try:
                os.setpgrp()
                os.chdir(work_dir)
                if stdout_file:
                    out_fd = os.open(stdout_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                    os.dup2(out_fd, 1)
                    os.close(out_fd)
                if stderr_file:
                    err_fd = os.open(stderr_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                    os.dup2(err_fd, 2)
                    os.close(err_fd)
                with open(spec_file, encoding="utf-8") as fh:
                    spec = json.load(fh)
                _limit_resources(spec["limits"])
                result = {"status": "error", "message": "", "traceback": None, "missing_module": None,
                          "figures_found": 0, "warnings": []}
                try:
                    _run(spec, result)
                except BaseException as exc:
                    result.update(status="error", message=f"Internal runner error: {type(exc).__name__}: {exc}")
                tmp = spec["result"] + ".part"
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump(result, fh)
                os.replace(tmp, spec["result"])
                sys.stdout.flush()
                sys.stderr.flush()
                os._exit(0 if result["status"] == "ok" else 1)
            except BaseException:
                os._exit(1)

        sys.stdout.write(json.dumps({"pid": child}) + "\n")
        sys.stdout.flush()
        try:
            _, status = os.waitpid(child, 0)
        except OSError:
            status = 0
        sys.stdout.write(json.dumps({"status": status}) + "\n")
        sys.stdout.flush()


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) > 1 and sys.argv[1] == "--fork-server":
        _fork_server_loop()
        return
    with open(sys.argv[1], encoding="utf-8") as fh:
        spec = json.load(fh)
    _limit_resources(spec["limits"])
    result = {"status": "error", "message": "", "traceback": None, "missing_module": None,
              "figures_found": 0, "warnings": []}
    try:
        _run(spec, result)
    except BaseException as exc:                       # a harness bug, not the user's code
        result.update(status="error", message=f"Internal runner error: {type(exc).__name__}: {exc}")
    tmp = spec["result"] + ".part"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(result, fh)
    os.replace(tmp, spec["result"])
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0 if result["status"] == "ok" else 1)     # skip interpreter teardown: stray non-daemon threads can't hang us


if __name__ == "__main__":
    main()
