"""Subprocess runner for custom Python figures (docs/FIGURES_CONTRACT.md s4a, s5, s7)."""
import io
import json
import os
import sys
import tempfile
import time

import pytest
from PIL import Image

from backend.figures import runner
from backend.figures.runner import MAX_STREAM_BYTES, run_python

LINUX = sys.platform.startswith("linux")
PLOT = "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\n"


@pytest.fixture(scope="module", autouse=True)
def _warm_matplotlib_cache():
    """The first matplotlib import may build the font cache; keep that out of the timing-sensitive tests."""
    assert run_python(PLOT, dpi=72).ok


def image(res):
    return Image.open(io.BytesIO(res.png_bytes))


def is_blank(img):
    return len(img.convert("RGBA").getcolors(maxcolors=1_000_000)) < 2


def test_success_png_at_requested_size_and_dpi():
    src = ("import matplotlib.pyplot as plt\n"
           "def main():\n"
           "    fig, ax = plt.subplots(figsize=(3, 2))\n"
           "    ax.plot([1, 2, 3], [3, 1, 2])\n"
           "    print('plotted')\n"
           "    plt.show()\n"
           "if __name__ == '__main__':\n"
           "    main()\n")
    res = run_python(src, dpi=100)
    assert res.ok and res.status == "ok" and res.message == ""
    assert res.png_bytes.startswith(b"\x89PNG") and res.pdf_bytes is None
    assert (res.width_px, res.height_px) == (300, 200) == image(res).size
    assert not is_blank(image(res))
    assert res.stdout.strip() == "plotted" and res.figures_found == 1 and res.warnings == []
    assert res.traceback is None and res.duration_ms > 0


def test_pdf_output_also_returns_png():
    res = run_python(PLOT, dpi=100, out_format="pdf")
    assert res.ok and res.pdf_bytes.startswith(b"%PDF") and res.png_bytes.startswith(b"\x89PNG")


def test_facecolor_and_transparent():
    red = run_python(PLOT, dpi=100, facecolor="#ff0000")
    assert image(red).convert("RGBA").getpixel((0, 0)) == (255, 0, 0, 255)
    clear = run_python(PLOT, dpi=100, transparent=True)
    assert image(clear).convert("RGBA").getpixel((0, 0))[3] == 0


def test_tight_bbox_rcparam_cannot_change_pixel_size():
    src = "import matplotlib.pyplot as plt\nplt.rcParams['savefig.bbox'] = 'tight'\nplt.figure(figsize=(3, 2))\nplt.plot([1])\n"
    res = run_python(src, dpi=100)
    assert res.ok and (res.width_px, res.height_px) == (300, 200)
    assert any("tight" in w for w in res.warnings)


@pytest.mark.parametrize("source, line, fragment", [
    ("import matplotlib.pyplot as plt\nx = 1\ny = undefined_name + x\n", 3, "NameError"),
    ("def boom():\n    return 1 / 0\n\nboom()\n", 2, "ZeroDivisionError"),          # innermost frame in the script
    ("ok = 1\nif ok\n    pass\n", 2, "SyntaxError"),
])
def test_exception_reports_line_and_message(source, line, fragment):
    res = run_python(source)
    assert not res.ok and res.status == "error" and res.png_bytes is None
    assert res.traceback["line"] == line
    assert fragment in res.traceback["message"] and res.message == res.traceback["message"]
    assert fragment in res.stderr and "script.py" in res.traceback["text"]
    assert "harness.py" not in res.traceback["text"]


def test_sys_exit_nonzero_is_an_error_but_zero_is_not():
    assert run_python(PLOT + "import sys\nsys.exit(0)\n").ok
    res = run_python(PLOT + "import sys\nsys.exit(3)\n")
    assert res.status == "error" and "3" in res.message


def test_timeout_kills_script_and_its_children(monkeypatch, tmp_path):
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    src = ("import os, subprocess, sys, time\n"
           "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'])\n"
           "print('cwd', os.getcwd())\n"
           "print('child', child.pid, flush=True)\n"
           "while True:\n"
           "    time.sleep(0.05)\n")
    t0 = time.monotonic()
    res = run_python(src, timeout=5)
    assert time.monotonic() - t0 < 20
    assert res.status == "timeout" and not res.ok and "5 s" in res.message and res.png_bytes is None
    fields = dict(line.split(" ", 1) for line in res.stdout.splitlines())    # output printed before the kill survives
    assert not os.path.exists(fields["cwd"]) and list(tmp_path.iterdir()) == []
    if LINUX:
        pid, deadline = int(fields["child"]), time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                with open(f"/proc/{pid}/stat") as fh:
                    if fh.read().rsplit(")", 1)[1].split()[0] == "Z":        # zombie == already killed
                        break
            except OSError:
                break
            time.sleep(0.05)
        else:
            pytest.fail("child process of the script survived the timeout")


def test_missing_module_is_reported_not_installed():
    res = run_python("import matplotlib.pyplot as plt\nimport definitely_not_installed_xyz\n")
    assert res.status == "missing_dependency" and not res.ok
    assert res.missing_module == "definitely_not_installed_xyz"
    assert "definitely_not_installed_xyz" in res.message and "never installs" in res.message
    assert res.traceback["line"] == 2


@pytest.mark.parametrize("source", [
    "x = 1\n",
    "import matplotlib.pyplot as plt\nplt.plot([1])\nplt.close('all')\n",
])
def test_no_figure(source):
    res = run_python(source)
    assert res.status == "no_figure" and not res.ok and res.png_bytes is None and res.figures_found == 0
    assert "plt.subplots()" in res.message and "plt.close()" in res.message


def test_two_figures_shows_lowest_number_with_warning():
    src = ("import matplotlib.pyplot as plt\n"
           "plt.figure(5, figsize=(6, 4)); plt.plot([1, 2])\n"
           "plt.figure(2, figsize=(3, 2)); plt.plot([3, 4])\n")
    res = run_python(src, dpi=100)
    assert res.ok and res.figures_found == 2
    assert res.warnings == ["2 figures created; showing figure #2"]
    assert (res.width_px, res.height_px) == (300, 200)


@pytest.mark.parametrize("figsize, dpi, fragment", [
    ((100, 100), 72, "per side"),          # > 30 in
    ((0.2, 0.2), 100, "per side"),         # < 0.5 in
    ((14, 14), 1200, "px per side"),       # 16800 px
    ((30, 30), 450, "megapixels"),         # 13500 x 13500 = 182 MP, each side within 16384 px
    ((12, 11), 1000, "megapixels"),        # 12000 x 11000 = 132 MP
])
def test_huge_figure_rejected_before_rendering(figsize, dpi, fragment):
    t0 = time.monotonic()
    res = run_python(f"import matplotlib.pyplot as plt\nplt.figure(figsize={figsize})\nplt.plot([1])\n", dpi=dpi)
    assert time.monotonic() - t0 < 20
    assert res.status == "error" and not res.ok and res.png_bytes is None
    assert fragment in res.message


def test_stdout_flood_is_truncated():
    src = PLOT + "chunk = 'x' * 1023 + '\\n'\nfor _ in range(20000):\n    print(chunk, end='')\n"   # ~20 MB
    res = run_python(src, dpi=72)
    assert res.ok                                                    # the figure still comes back
    assert len(res.stdout.encode()) <= MAX_STREAM_BYTES and "truncated" in res.stdout
    assert res.stdout.startswith("x" * 100)
    assert any(w.startswith("stdout truncated") for w in res.warnings)


def test_stderr_flood_is_truncated_too():
    res = run_python(PLOT + "import sys\nfor _ in range(5000):\n    sys.stderr.write('e' * 200 + '\\n')\n", dpi=72)
    assert res.ok and len(res.stderr.encode()) <= MAX_STREAM_BYTES and "truncated" in res.stderr


def test_tempdir_removed_on_success_error_and_no_figure(monkeypatch, tmp_path):
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    cwds = []
    for src in (PLOT, "raise RuntimeError('boom')\n", "x = 1\n"):
        res = run_python("import os\nprint(os.getcwd())\n" + src, dpi=72)
        cwds.append(res.stdout.strip())
        assert list(tmp_path.iterdir()) == []
    assert all(cwds) and not any(os.path.exists(c) for c in cwds)


def test_environment_is_scrubbed(monkeypatch):
    for key, value in (("HTTPS_PROXY", "http://proxy.invalid"), ("ALL_PROXY", "socks5://proxy.invalid"),
                       ("MY_API_TOKEN", "s3cr3t"), ("ANTHROPIC_API_KEY", "sk-test"), ("AWS_SECRET_ACCESS_KEY", "x")):
        monkeypatch.setenv(key, value)
    res = run_python("import json, os\nprint(json.dumps(dict(os.environ)))\n")
    env = {k.upper(): v for k, v in json.loads(res.stdout.splitlines()[0]).items()}
    assert not {"HTTPS_PROXY", "ALL_PROXY", "MY_API_TOKEN", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY"} & set(env)
    assert env["MPLBACKEND"] == "Agg" and os.path.basename(env["TMPDIR"]) == "tmp"


def test_files_are_written_next_to_the_script():
    src = ("import csv, helper\n"
           "import matplotlib.pyplot as plt\n"
           "rows = list(csv.DictReader(open('data.csv')))\n"
           "print(helper.VALUE, len(rows), open('sub/notes.txt').read().strip())\n"
           "plt.plot([float(r['x']) for r in rows], [float(r['y']) for r in rows])\n")
    files = {"data.csv": "x,y\n1,2\n3,4\n", "helper.py": b"VALUE = 7\n", "sub/notes.txt": "hello"}
    res = run_python(src, dpi=72, files=files)
    assert res.ok and res.stdout.split() == ["7", "2", "hello"]


@pytest.mark.skipif(not LINUX, reason="RLIMIT_AS is only enforced on Linux")
def test_memory_limit_turns_into_an_error():
    res = run_python(f"x = bytearray({runner.MEMORY_LIMIT_BYTES * 2})\n")
    assert res.status == "error" and "MemoryError" in res.message


@pytest.mark.skipif(os.name != "posix", reason="rlimits are POSIX only")
def test_file_size_limit(monkeypatch):
    monkeypatch.setattr(runner, "MAX_FILE_BYTES", 1 << 20)
    res = run_python("open('big.bin', 'wb').write(b'0' * (3 << 20))\n")
    assert res.status == "error" and "File too large" in res.message


@pytest.mark.parametrize("kwargs", [
    {"dpi": 10}, {"dpi": 5000}, {"dpi": 100.5}, {"out_format": "svg"}, {"timeout": 0}, {"timeout": 10_000},
    {"facecolor": "red; rm -rf /"}, {"transparent": "yes"},
    {"files": {"../escape.txt": "x"}}, {"files": {"/abs.txt": "x"}}, {"files": {"script.py": "x"}},
    {"files": {"a\\b.txt": "x"}}, {"files": {"c:evil.txt": "x"}}, {"files": {"ok.txt": 12}},
])
def test_malformed_arguments_raise_value_error(kwargs):
    with pytest.raises(ValueError):
        run_python(PLOT, **kwargs)


def test_non_string_source_raises_value_error():
    with pytest.raises(ValueError):
        run_python(123)
