# PDF Converter – LibreOffice Setup

Laurevine uses LibreOffice (`soffice`) for presentation-to-PDF export. This page covers the **download metadata**, **distribution terms**, and **checksum method** for the official LibreOffice binaries listed in `setup/libreoffice-manifest.json`.

## Distribution terms

LibreOffice is **not bundled** in the Laurevine installer. When PDF export is requested, Laurevine downloads the official LibreOffice archive from `download.documentfoundation.org` **at the user’s request**. The download is performed by the installer from The Document Foundation’s official server only; no mirrors or repackagers are used.

LibreOffice is licensed under the **Mozilla Public License 2.0 (MPL‑2.0)**. The license source page is <https://www.libreoffice.org/download/license/>.

## Sizes (version 26.2.6, fetched 2026‑10‑20)

| Platform‑arch | Archive | Exact bytes | Approx. |
|---|---|---|---|
| win‑x64 | MSI | 373,252,096 | 356 MB |
| win‑arm64 | MSI | 359,571,456 | 343 MB |
| mac‑arm64 | DMG | 297,798,926 | 284 MB |
| mac‑x64 | DMG | 308,308,875 | 294 MB |
| linux‑x64 | tar.gz (deb) | 217,285,735 | 207 MB |

Sizes are taken from the official per‑file mirrorlist pages (e.g. `LibreOffice_26.2.6_Win_x86-64.msi.mirrorlist` shows `373252096 bytes`[reference:3]).

## Checksum method

Every entry includes a **SHA‑256** hash taken directly from the official `.sha256` sidecar published next to the artifact on `download.documentfoundation.org`. Example:

- `LibreOffice_26.2.6_Win_x86-64.msi.sha256` contains `f9877032fd908beb9c0ddf06df4af5c2e85f419c42e14876c4cce5aae5fb2660`[reference:4].
- The mirrorlist page repeats the same hash for independent confirmation[reference:5].

The installer **must compute SHA‑256** of the downloaded file and compare it against the value in the manifest before extraction. If the hash does not match, extraction must be refused. The validator (`scripts/validate-libreoffice-manifest.py`) also refuses any entry whose `verified` flag is not `true`.

## Verification status

All metadata fields for the five entries above are marked `"verified": true` because they were read from official `documentfoundation.org` pages. The actual **download and extraction were not performed** in this environment and are therefore **UNTESTED**; the installer’s runtime check (SHA‑256 + successful `soffice --version` probe) is the final gate.
