"""Bundled font catalog, style resolution, and isolated PDF export font registration.

This module ensures that LibreOffice PDF export uses the application's bundled fonts
from the `fonts/` directory rather than relying on fonts installed on the host OS.

Key capabilities:
1. Enumerates all bundled font families from `fonts/`.
2. Normalizes font names, aliases, and family identifiers.
3. Maps font-family names to explicit style variants (regular, bold, italic, bold_italic).
4. Handles variable TTF fonts by instantiating static TrueType variants (Regular 400,
   Bold 700, Italic, Bold Italic) with normalized name records into an application-local
   cache (`fonts/.cache/`), overcoming LibreOffice/Cairo's inability to subset variable
   fonts as vector TrueType into PDF.
5. Prepares an isolated font environment (user/fonts and fonts.conf) for LibreOffice
   headless conversion so that bundled fonts take precedence without polluting the OS.
6. Gracefully handles incomplete font families and missing fonts.
"""

import logging
import os
import re
import shutil
import subprocess
import tempfile
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

from backend.soffice import user_data_dir

logger = logging.getLogger(__name__)

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FONTS_DIR = os.path.join(BASE_DIR, "fonts")
# NOT under FONTS_DIR: in a packaged build FONTS_DIR lives inside the app's bundled
# resources (e.g. an AppImage's read-only squashfs mount), so instantiated variable-font
# files must be cached in the same writable, persistent userData folder everything else
# writable (managed LibreOffice, setup-state.json) already uses. See backend/soffice.py.
CACHE_DIR = os.path.join(user_data_dir(), "fonts-cache")

# 38 Curated Fonts Catalog: id -> Canonical Family Name
CURATED_FONTS_CATALOG: Dict[str, str] = {
    "outfit": "Outfit",
    "spline-sans": "Spline Sans",
    "arimo": "Arimo",
    "source-sans-3": "Source Sans 3",
    "open-dyslexic": "OpenDyslexic",
    "tex-gyre-termes": "TeX Gyre Termes",
    "cormorant-garamond": "Cormorant Garamond",
    "amiri": "Amiri",
    "cairo": "Cairo",
    "noto-sans-arabic": "Noto Sans Arabic",
    "tajawal": "Tajawal",
    "scheherazade-new": "Scheherazade New",
    "inter": "Inter",
    "roboto": "Roboto",
    "open-sans": "Open Sans",
    "lato": "Lato",
    "montserrat": "Montserrat",
    "poppins": "Poppins",
    "raleway": "Raleway",
    "oswald": "Oswald",
    "fira-sans": "Fira Sans",
    "plus-jakarta-sans": "Plus Jakarta Sans",
    "merriweather": "Merriweather",
    "playfair-display": "Playfair Display",
    "lora": "Lora",
    "pt-serif": "PT Serif",
    "bitter": "Bitter",
    "cinzel": "Cinzel",
    "libre-baskerville": "Libre Baskerville",
    "eb-garamond": "EB Garamond",
    "jetbrains-mono": "JetBrains Mono",
    "fira-code": "Fira Code",
    "inconsolata": "Inconsolata",
    "source-code-pro": "Source Code Pro",
    "space-mono": "Space Mono",
    "caveat": "Caveat",
    "pacifico": "Pacifico",
    "space-grotesk": "Space Grotesk",
}

# Aliases mapping normalized lowercase strings to canonical family names
FONT_ALIASES: Dict[str, str] = {
    "source sans": "Source Sans 3",
    "source sans pro": "Source Sans 3",
    "sourcesans3": "Source Sans 3",
    "sourcesans": "Source Sans 3",
    "open dyslexic": "OpenDyslexic",
    "opendyslexic": "OpenDyslexic",
    "tex gyre termes": "TeX Gyre Termes",
    "texgyretermes": "TeX Gyre Termes",
    "cormorant": "Cormorant Garamond",
    "cormorantgaramond": "Cormorant Garamond",
    "eb garamond": "EB Garamond",
    "ebgaramond": "EB Garamond",
    "jetbrains mono": "JetBrains Mono",
    "jetbrainsmono": "JetBrains Mono",
    "fira code": "Fira Code",
    "firacode": "Fira Code",
    "fira sans": "Fira Sans",
    "firasans": "Fira Sans",
    "plus jakarta sans": "Plus Jakarta Sans",
    "plusjakartasans": "Plus Jakarta Sans",
    "playfair display": "Playfair Display",
    "playfairdisplay": "Playfair Display",
    "libre baskerville": "Libre Baskerville",
    "librebaskerville": "Libre Baskerville",
    "pt serif": "PT Serif",
    "ptserif": "PT Serif",
    "source code pro": "Source Code Pro",
    "sourcecodepro": "Source Code Pro",
    "space mono": "Space Mono",
    "spacemono": "Space Mono",
    "space grotesk": "Space Grotesk",
    "spacegrotesk": "Space Grotesk",
    "spline sans": "Spline Sans",
    "splinesans": "Spline Sans",
    "noto sans arabic": "Noto Sans Arabic",
    "notosansarabic": "Noto Sans Arabic",
    "scheherazade new": "Scheherazade New",
    "scheherazadenew": "Scheherazade New",
}
for _fid, _cname in CURATED_FONTS_CATALOG.items():
    FONT_ALIASES[_cname.lower()] = _cname
    FONT_ALIASES[_fid] = _cname
    FONT_ALIASES[_cname.lower().replace(" ", "")] = _cname


def normalize_family_name(name: Optional[str]) -> Optional[str]:
    """Normalize any font family string to the canonical bundled font name if available."""
    if not name or not isinstance(name, str):
        return None
    cleaned = name.strip().strip("'\"")
    if "," in cleaned:
        cleaned = cleaned.split(",")[0].strip().strip("'\"")
    key = cleaned.lower()
    if key in FONT_ALIASES:
        return FONT_ALIASES[key]
    key_no_space = key.replace(" ", "").replace("-", "")
    if key_no_space in FONT_ALIASES:
        return FONT_ALIASES[key_no_space]
    # Check against catalog names
    for fid, cname in CURATED_FONTS_CATALOG.items():
        if key == fid or key == cname.lower():
            return cname
    return cleaned


def _classify_static_font_file(file_path: str) -> Tuple[str, int]:
    """Classify a static TTF/OTF file into a style bucket and weight.

    Returns:
        (style_name, priority): style_name is 'regular', 'bold', 'italic', or 'bold_italic'.
        priority is an integer (lower is preferred).
    """
    try:
        tt = TTFont(file_path)
    except Exception:
        fname = os.path.basename(file_path).lower()
        is_it = "italic" in fname or "oblique" in fname
        is_bd = "bold" in fname or "black" in fname or "semibold" in fname
        if is_bd and is_it:
            return "bold_italic", 100
        if is_bd:
            return "bold", 100
        if is_it:
            return "italic", 100
        return "regular", 100

    names = {rec.nameID: rec.toUnicode() for rec in tt["name"].names if rec.platformID == 3 and rec.platEncID == 1}
    subfamily = names.get(2, "").lower()
    os2 = tt.get("OS/2")
    weight = os2.usWeightClass if os2 else 400
    fs_sel = os2.fsSelection if os2 else 0

    is_italic = bool(fs_sel & 0x01) or "italic" in subfamily or "oblique" in subfamily or "italic" in os.path.basename(file_path).lower()
    is_bold = bool(fs_sel & 0x20) or weight >= 600 or "bold" in subfamily or "black" in subfamily or "bold" in os.path.basename(file_path).lower()

    if is_bold and is_italic:
        diff = abs(weight - 700)
        return "bold_italic", diff
    elif is_bold:
        diff = abs(weight - 700)
        return "bold", diff
    elif is_italic:
        diff = abs(weight - 400)
        return "italic", diff
    else:
        diff = abs(weight - 400)
        if "medium" in subfamily:
            diff += 50
        return "regular", diff


def _set_font_names(tt: TTFont, family: str, style: str) -> None:
    """Set standardized TrueType name records and OS/2 weight/style flags."""
    full_name = f"{family} {style}".strip()
    postscript_name = f"{family.replace(' ', '')}-{style.replace(' ', '')}"

    # Remove existing 1, 2, 4, 6, 16, 17 records
    name_table = tt["name"]
    name_table.names = [rec for rec in name_table.names if rec.nameID not in (1, 2, 4, 6, 16, 17)]

    # Windows (platform 3, encoding 1, lang English US 0x409)
    name_table.setName(family, 1, 3, 1, 0x409)
    name_table.setName(style, 2, 3, 1, 0x409)
    name_table.setName(full_name, 4, 3, 1, 0x409)
    name_table.setName(postscript_name, 6, 3, 1, 0x409)

    # Mac (platform 1, encoding 0, lang English 0)
    name_table.setName(family, 1, 1, 0, 0)
    name_table.setName(style, 2, 1, 0, 0)
    name_table.setName(full_name, 4, 1, 0, 0)
    name_table.setName(postscript_name, 6, 1, 0, 0)

    is_bold = "bold" in style.lower()
    is_italic = "italic" in style.lower()

    os2 = tt.get("OS/2")
    if os2:
        os2.usWeightClass = 700 if is_bold else 400
        fs_sel = os2.fsSelection & ~0x61
        if is_bold:
            fs_sel |= 0x20
        if is_italic:
            fs_sel |= 0x01
        if not is_bold and not is_italic:
            fs_sel |= 0x40
        os2.fsSelection = fs_sel

    head = tt.get("head")
    if head:
        mac_style = 0
        if is_bold:
            mac_style |= 1
        if is_italic:
            mac_style |= 2
        head.macStyle = mac_style


class BundledFontFamily:
    """Represents a bundled font family and resolves style variants."""

    def __init__(self, family_id: str, canonical_name: str, dir_path: str):
        self.family_id = family_id
        self.canonical_name = canonical_name
        self.dir_path = dir_path
        self.is_variable = False
        self.raw_files: List[str] = []
        self.static_variants: Dict[str, str] = {}
        self._inspect_files()

    def _inspect_files(self) -> None:
        if not os.path.isdir(self.dir_path):
            return
        files = [f for f in sorted(os.listdir(self.dir_path)) if f.endswith((".ttf", ".otf"))]
        self.raw_files = [os.path.join(self.dir_path, f) for f in files]

        # Check for variable font table ('fvar')
        for fp in self.raw_files:
            try:
                tt = TTFont(fp)
                if "fvar" in tt:
                    self.is_variable = True
                    break
            except Exception:
                pass

        if not self.is_variable:
            # Classify static variants
            best_variants: Dict[str, Tuple[str, int]] = {}
            for fp in self.raw_files:
                style, prio = _classify_static_font_file(fp)
                if style not in best_variants or prio < best_variants[style][1]:
                    best_variants[style] = (fp, prio)
            self.static_variants = {st: pair[0] for st, pair in best_variants.items()}

    def get_style_files(self, cache_dir: Optional[str] = None) -> Dict[str, str]:
        """Return a mapping of style names ('regular', 'bold', 'italic', 'bold_italic') to file paths.

        For variable fonts, instantiates static TTF instances and caches them.
        """
        if not self.is_variable:
            res: Dict[str, str] = {}
            reg = self.static_variants.get("regular")
            if not reg and self.raw_files:
                reg = self.raw_files[0]
            if reg:
                res["regular"] = reg
            res["bold"] = self.static_variants.get("bold") or reg
            res["italic"] = self.static_variants.get("italic") or reg
            res["bold_italic"] = self.static_variants.get("bold_italic") or res["bold"] or res["italic"] or reg
            return {k: v for k, v in res.items() if v}

        # Variable font handling
        c_dir = cache_dir or CACHE_DIR
        family_cache = os.path.join(c_dir, self.family_id)
        os.makedirs(family_cache, exist_ok=True)

        cached_files = {
            "regular": os.path.join(family_cache, f"{self.canonical_name.replace(' ', '')}-Regular.ttf"),
            "bold": os.path.join(family_cache, f"{self.canonical_name.replace(' ', '')}-Bold.ttf"),
            "italic": os.path.join(family_cache, f"{self.canonical_name.replace(' ', '')}-Italic.ttf"),
            "bold_italic": os.path.join(family_cache, f"{self.canonical_name.replace(' ', '')}-BoldItalic.ttf"),
        }

        # Determine available source files (roman and italic)
        roman_src = None
        italic_src = None
        for fp in self.raw_files:
            fname = os.path.basename(fp).lower()
            if "italic" in fname:
                italic_src = fp
            else:
                roman_src = fp
        if not roman_src and self.raw_files:
            roman_src = self.raw_files[0]

        # Check if cache exists
        need_generate = False
        for st in ("regular", "bold"):
            if not os.path.exists(cached_files[st]):
                need_generate = True
                break

        if need_generate and roman_src:
            try:
                tt_rom = TTFont(roman_src)
                axes = {a.axisTag: (a.minValue, a.defaultValue, a.maxValue) for a in tt_rom["fvar"].axes} if "fvar" in tt_rom else {}

                # Regular
                loc_reg = {}
                if "wght" in axes:
                    loc_reg["wght"] = min(max(400, axes["wght"][0]), axes["wght"][2])
                inst_reg = instantiateVariableFont(tt_rom, loc_reg)
                _set_font_names(inst_reg, self.canonical_name, "Regular")
                inst_reg.save(cached_files["regular"])

                # Bold
                loc_bold = {}
                if "wght" in axes:
                    loc_bold["wght"] = min(max(700, axes["wght"][0]), axes["wght"][2])
                inst_bold = instantiateVariableFont(tt_rom, loc_bold)
                _set_font_names(inst_bold, self.canonical_name, "Bold")
                inst_bold.save(cached_files["bold"])

                # Italic and Bold Italic
                if italic_src:
                    tt_it = TTFont(italic_src)
                    axes_it = {a.axisTag: (a.minValue, a.defaultValue, a.maxValue) for a in tt_it["fvar"].axes} if "fvar" in tt_it else {}

                    loc_it = {}
                    if "wght" in axes_it:
                        loc_it["wght"] = min(max(400, axes_it["wght"][0]), axes_it["wght"][2])
                    inst_it = instantiateVariableFont(tt_it, loc_it)
                    _set_font_names(inst_it, self.canonical_name, "Italic")
                    inst_it.save(cached_files["italic"])

                    loc_bi = {}
                    if "wght" in axes_it:
                        loc_bi["wght"] = min(max(700, axes_it["wght"][0]), axes_it["wght"][2])
                    inst_bi = instantiateVariableFont(tt_it, loc_bi)
                    _set_font_names(inst_bi, self.canonical_name, "Bold Italic")
                    inst_bi.save(cached_files["bold_italic"])
                elif "slnt" in axes:
                    # Synthetic italic using slant axis (e.g. Cairo)
                    min_slnt = axes["slnt"][0]
                    inst_it = instantiateVariableFont(tt_rom, {"wght": loc_reg.get("wght", 400), "slnt": min_slnt})
                    _set_font_names(inst_it, self.canonical_name, "Italic")
                    inst_it.save(cached_files["italic"])

                    inst_bi = instantiateVariableFont(tt_rom, {"wght": loc_bold.get("wght", 700), "slnt": min_slnt})
                    _set_font_names(inst_bi, self.canonical_name, "Bold Italic")
                    inst_bi.save(cached_files["bold_italic"])
            except Exception as e:
                logger.warning(f"Error instantiating static font for {self.canonical_name}: {e}")

        # Collect existing cached variants
        res = {}
        for st, path in cached_files.items():
            if os.path.exists(path):
                res[st] = path

        # Fallbacks for incomplete styles
        reg = res.get("regular")
        if not reg and self.raw_files:
            reg = self.raw_files[0]
            res["regular"] = reg
        if "bold" not in res and reg:
            res["bold"] = reg
        if "italic" not in res and reg:
            res["italic"] = reg
        if "bold_italic" not in res:
            res["bold_italic"] = res.get("bold") or res.get("italic") or reg

        return res


class FontCatalog:
    """Catalog of all bundled application fonts."""

    def __init__(self, fonts_dir: str = FONTS_DIR):
        self.fonts_dir = fonts_dir
        self.families: Dict[str, BundledFontFamily] = {}
        self._alias_map: Dict[str, str] = {}
        self._scan()

    def _scan(self) -> None:
        if not os.path.isdir(self.fonts_dir):
            return
        for item in sorted(os.listdir(self.fonts_dir)):
            if item.startswith("."):
                continue
            dir_path = os.path.join(self.fonts_dir, item)
            if not os.path.isdir(dir_path):
                continue
            cname = CURATED_FONTS_CATALOG.get(item)
            if not cname:
                cname = item.replace("-", " ").title()
            family = BundledFontFamily(item, cname, dir_path)
            self.families[cname] = family
            self._alias_map[cname.lower()] = cname
            self._alias_map[item.lower()] = cname
            self._alias_map[cname.lower().replace(" ", "")] = cname

        # Include custom aliases
        for alias, cname in FONT_ALIASES.items():
            if cname in self.families:
                self._alias_map[alias.lower()] = cname

    def resolve_family(self, name: Optional[str]) -> Optional[BundledFontFamily]:
        """Resolve a font name to a BundledFontFamily instance."""
        if not name:
            return None
        norm = normalize_family_name(name)
        if norm and norm in self.families:
            return self.families[norm]
        key = name.strip().strip("'\"").lower()
        if key in self._alias_map:
            return self.families.get(self._alias_map[key])
        key_no_space = key.replace(" ", "").replace("-", "")
        if key_no_space in self._alias_map:
            return self.families.get(self._alias_map[key_no_space])
        return None

    def list_families(self) -> List[str]:
        """List all canonical family names in the catalog."""
        return sorted(self.families.keys())


# Global singleton catalog instance
_GLOBAL_CATALOG: Optional[FontCatalog] = None


def get_font_catalog() -> FontCatalog:
    """Get or initialize the global font catalog."""
    global _GLOBAL_CATALOG
    if _GLOBAL_CATALOG is None:
        _GLOBAL_CATALOG = FontCatalog()
    return _GLOBAL_CATALOG


def extract_document_fonts(doc: Any) -> Set[str]:
    """Extract all font family names referenced in a PresentationDoc model or dict."""
    fonts: Set[str] = set()

    # Theme fonts
    theme_id = getattr(doc, "themeId", None) if not isinstance(doc, dict) else doc.get("themeId")
    from backend.exporter import THEMES_CONFIG
    theme = THEMES_CONFIG.get(theme_id or "journal", THEMES_CONFIG["journal"])
    if theme.get("headFont"):
        fonts.add(theme["headFont"])
    if theme.get("bodyFont"):
        fonts.add(theme["bodyFont"])

    # Typography preset (doc.typography): every role font, so a role that inherits the preset font is still registered for PDF
    from backend.typography import fonts_of
    fonts |= fonts_of(getattr(doc, "typography", None) if not isinstance(doc, dict) else doc.get("typography"))

    # Header / footer text (master + per-slide overrides): explicit family and fonts inside the rich text
    from backend.headerfooter import iter_items
    for it in iter_items(doc):
        if it.get("font"):
            fonts.add(it["font"])
        raw_hf = it.get("html")
        if isinstance(raw_hf, str):
            for match in re.finditer(r'font-family:\s*[\'"]?([^\'";>]+)', raw_hf, re.I):
                fonts.add(match.group(1).split(",")[0].strip().strip("'\""))
            for match in re.finditer(r'face=[\'"]([^\'"]+)', raw_hf, re.I):
                fonts.add(match.group(1).split(",")[0].strip().strip("'\""))

    slides = getattr(doc, "slides", None) if not isinstance(doc, dict) else doc.get("slides")
    for s in (slides or []):
        objs = getattr(s, "objects", None) if not isinstance(s, dict) else s.get("objects")
        for obj in (objs or []):
            font = getattr(obj, "font", None) if not isinstance(obj, dict) else obj.get("font")
            if font:
                fonts.add(font)
            raw_html = getattr(obj, "html", None) if not isinstance(obj, dict) else obj.get("html")
            if raw_html and isinstance(raw_html, str):
                for match in re.finditer(r'font-family:\s*[\'"]?([^\'";>]+)', raw_html, re.I):
                    fonts.add(match.group(1).split(",")[0].strip().strip("'\""))
                for match in re.finditer(r'face=[\'"]([^\'"]+)', raw_html, re.I):
                    fonts.add(match.group(1).split(",")[0].strip().strip("'\""))
    return fonts


def prepare_export_font_environment(
    target_dir: str,
    font_names: Optional[Iterable[str]] = None,
    catalog: Optional[FontCatalog] = None,
    warnings: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[str, str, Dict[str, str]]:
    """Prepare isolated font files and fontconfig configuration for LibreOffice.

    Args:
        target_dir: Directory where the isolated lo_profile and font files will reside.
        font_names: Set or list of font names required. If None, all bundled fonts are prepared.
        catalog: FontCatalog instance.
        warnings: Optional list to append warnings to.

    Returns:
        (fonts_conf_path, user_fonts_dir, env_vars_dict)
    """
    cat = catalog or get_font_catalog()
    user_fonts_dir = os.path.join(target_dir, "user", "fonts")
    fc_cache_dir = os.path.join(target_dir, "fc_cache")
    os.makedirs(user_fonts_dir, exist_ok=True)
    os.makedirs(fc_cache_dir, exist_ok=True)

    families_to_prepare: Set[str] = set()
    if font_names:
        for name in font_names:
            norm = normalize_family_name(name)
            fam = cat.resolve_family(norm)
            if fam:
                families_to_prepare.add(fam.canonical_name)
            else:
                if warnings is not None:
                    warnings.append({
                        "code": "FONT_NOT_BUNDLED",
                        "font": name,
                        "message": f"Font '{name}' is not in bundled font catalog; falling back to default.",
                    })
    else:
        families_to_prepare.update(cat.list_families())

    # Always ensure default theme fonts (Outfit, Arimo) are available as fallbacks
    from backend.symbols import FALLBACK_FAMILIES  # symbol glyph fallbacks must be installed too (backend/symbols.py)
    for fallback in ("Outfit", "Arimo", "TeX Gyre Termes") + tuple(FALLBACK_FAMILIES):
        if fallback in cat.families:
            families_to_prepare.add(fallback)

    installed_families: Set[str] = set()
    for fam_name in families_to_prepare:
        fam = cat.families.get(fam_name)
        if not fam:
            continue
        variants = fam.get_style_files()
        installed_families.add(fam.canonical_name)
        for st, src_path in variants.items():
            if not os.path.exists(src_path):
                continue
            base = os.path.basename(src_path)
            dst_path = os.path.join(user_fonts_dir, base)
            if not os.path.exists(dst_path):
                try:
                    os.symlink(src_path, dst_path)
                except OSError:
                    shutil.copyfile(src_path, dst_path)

    # Generate isolated fontconfig configuration giving precedence to bundled user fonts
    conf_path = os.path.join(target_dir, "fonts.conf")

    # Build match rules so fontconfig strictly matches bundled fonts without substitution
    prefer_rules = []
    for fam_name in installed_families:
        prefer_rules.append(
            f'  <match target="pattern">\n'
            f'    <test name="family"><string>{fam_name}</string></test>\n'
            f'    <edit name="family" mode="prepend" binding="strong"><string>{fam_name}</string></edit>\n'
            f'  </match>'
        )

    conf_content = (
        '<?xml version="1.0"?>\n'
        '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n'
        '<fontconfig>\n'
        f'  <cachedir>{fc_cache_dir}</cachedir>\n'
        f'  <dir>{user_fonts_dir}</dir>\n'
        f'  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>\n'
        + "\n".join(prefer_rules) + "\n"
        '</fontconfig>\n'
    )
    with open(conf_path, "w", encoding="utf-8") as f:
        f.write(conf_content)

    env_vars = {
        "FONTCONFIG_FILE": conf_path,
        "SAL_FONTPATH": user_fonts_dir,
    }
    return conf_path, user_fonts_dir, env_vars