# -*- mode: python ; coding: utf-8 -*-
# Build (onedir): pyinstaller run.spec  ->  dist/run/ (run / run.exe + its libraries).
# The Electron app expects the bundle at <resources>/backend/.
#
# Cross-platform: works on Linux (AppImage/deb/rpm) and Windows (NSIS installer).
# backend/server.py resolves everything relative to the folder above `backend/`,
# so the data below keeps the repo layout inside the bundle.
import os
import sys
import sysconfig
from PyInstaller.utils.hooks import collect_all, collect_dynamic_libs
from pathlib import Path


ROOT = os.path.abspath(SPECPATH)
IS_WINDOWS = sys.platform.startswith('win')
IS_MAC = sys.platform == 'darwin'
SKIP_DIRS = {'.cache', '__pycache__'}   # fonts/.cache is rebuilt at run time

# site-packages of the interpreter running PyInstaller — used to locate
# the .libs folders (Linux) or in-package DLLs (Windows/macOS).
SITE_PACKAGES = Path(sysconfig.get_paths()['purelib'])


def tree(name):
    """Every file under ROOT/name as (source file, destination folder inside the bundle)."""
    out = []
    for folder, dirs, files in os.walk(os.path.join(ROOT, name)):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        rel = os.path.relpath(folder, ROOT)
        out += [(os.path.join(folder, f), rel) for f in files if not f.endswith(('.pyc', '.pyo'))]
    return out


def collect_native_libs(folder_name):
    """Collect *.so* (Linux), *.dylib (macOS), or *.dll (Windows) from a
    site-packages '<pkg>.libs' folder.

    On Linux, pip installs some packages with separate '<pkg>.libs/' folders
    next to the package (e.g. pillow.libs, numpy.libs, scipy.libs). On Windows
    and macOS, most binaries live inside the package folder itself, and
    PyInstaller's collect_dynamic_libs handles those — so this function is a
    harmless no-op there.
    """
    out = []
    lib_dir = SITE_PACKAGES / folder_name
    if not lib_dir.is_dir():
        return out
    for f in lib_dir.iterdir():
        if not f.is_file():
            continue
        name = f.name.lower()
        if '.so' in name or name.endswith('.dll') or name.endswith('.dylib'):
            out.append((str(f), folder_name))
    return out


def backend_modules():
    """uvicorn.run("backend.server:app") imports by string, so list every backend module."""
    mods = []
    for folder, dirs, files in os.walk(os.path.join(ROOT, 'backend')):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        pkg = os.path.relpath(folder, ROOT).replace(os.sep, '.')
        for f in files:
            if f.endswith('.py') and f != 'harness.py':   # harness.py ships as a data file
                mods.append(pkg if f == '__init__.py' else pkg + '.' + f[:-3])
    return mods


# Everything backend/server.py serves or reads from disk.
REQUIRED = [
    'index.html', 'css', 'js', 'fonts', 'Assets',
    os.path.join('docs', 'SECURITY.md'),
    os.path.join('backend', 'figures', 'harness.py'),
]
missing = [r for r in REQUIRED if not os.path.exists(os.path.join(ROOT, r))]
if missing:
    raise SystemExit('run.spec: missing files the backend serves: ' + ', '.join(missing))

datas = [
    (os.path.join(ROOT, 'index.html'), '.'),
    (os.path.join(ROOT, 'docs', 'SECURITY.md'), 'docs'),
    (os.path.join(ROOT, 'backend', 'figures', 'harness.py'),
     os.path.join('backend', 'figures')),
]
for _d in ('css', 'js', 'fonts', 'Assets'):
    datas += tree(_d)

binaries = []
hiddenimports = backend_modules() + ['multipart', 'python_multipart']

# collect_all pulls datas + binaries + hidden imports for each package.
for _pkg in ('uvicorn', 'fastapi', 'pptx', 'numpy', 'scipy', 'pandas', 'matplotlib', 'PIL'):
    tmp_ret = collect_all(_pkg)
    datas += tmp_ret[0]
    binaries += tmp_ret[1]
    hiddenimports += tmp_ret[2]

# collect_dynamic_libs picks up in-package native libs — works on all platforms.
# On Linux this catches nothing extra (the .so files live in *.libs folders handled below);
# on Windows it's what grabs numpy/.libs/*.dll, scipy/.libs/*.dll, PIL/*.dll, etc.
for _pkg in ('numpy', 'scipy', 'PIL'):
    binaries += collect_dynamic_libs(_pkg)

# Linux-style *.libs folders. No-op on Windows/macOS if these folders don't exist.
for _libs in ('pillow.libs', 'numpy.libs', 'scipy.libs'):
    binaries += collect_native_libs(_libs)

a = Analysis(
    ['run.py'],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={
        # Pin matplotlib to the headless Agg backend so PyInstaller does NOT
        # probe Qt/GTK backends — which would pull in libgirepository, GTK3,
        # and copy the entire /usr/share/icons + /usr/share/themes tree (~900 MB).
        'matplotlib': {'backends': 'Agg'},
    },
    runtime_hooks=[],
    excludes=[
        # GNU readline (GPL-3.0) — backend never opens a REPL.
        # No-op on Windows (no readline module there), but kept for cross-platform
        # consistency and the shared filter below.
        'readline',
        # GUI toolkits — none used by this app.
        'PyQt5', 'PyQt6', 'PySide2', 'PySide6', 'tkinter',
        # GTK/GObject introspection — prevents the /usr/share/icons cascade on Linux.
        'gi', 'gi.repository', 'cairo', 'pango',
        # PyTorch / CUDA / Triton — not imported anywhere in the backend.
        'torch', 'torchvision', 'torchaudio', 'functorch', 'triton',
        'nvidia', 'nvidia.cublas', 'nvidia.cuda_cupti', 'nvidia.cuda_nvrtc',
        'nvidia.cuda_runtime', 'nvidia.cudnn', 'nvidia.cufft', 'nvidia.curand',
        'nvidia.cusolver', 'nvidia.cusparse', 'nvidia.nccl', 'nvidia.nvjitlink',
        'nvidia.cusparselt', 'nvidia.nvshmem',
        # HuggingFace stack.
        'transformers', 'accelerate', 'safetensors', 'datasets', 'tokenizers',
        'huggingface_hub',
        # ONNX.
        'onnxruntime',
        # Vector search / PyAV / Arrow.
        'faiss', 'faiss_cpu', 'av', 'pyarrow',
        # IPython / Jupyter.
        'IPython', 'ipykernel', 'ipython_genutils', 'jupyter_client',
        'jupyter_core', 'nbformat', 'traitlets', 'comm',
        # SymPy (only pulled in via torch).
        'sympy',
        # Misc.
        'jedi', 'parso', 'debugpy',
    ],
    noarchive=False,
    optimize=0,
)

# Strip libreadline (GPL-3.0) from the bundle — no-op on Windows, required on Linux.
a.binaries = [b for b in a.binaries if 'readline' not in b[0].lower()]

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='run',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # Windows: console=False hides the black command-prompt window that would
    # otherwise appear every time Electron spawns the backend. stdout/stderr
    # still work through the pipe Electron opens, so log capture is preserved.
    # Linux/macOS: console=True is the correct setting there (no window manager
    # draws a "console" for it).
    console=(not IS_WINDOWS),
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # Optional: uncomment and point at an .ico if you have one
    # icon=os.path.join(ROOT, 'Assets', 'appicon.ico') if IS_WINDOWS else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='run',
)