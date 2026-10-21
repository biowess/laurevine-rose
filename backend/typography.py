"""Presentation-level typography (mirror of js/typography.js, data side only).

``doc.typography`` is a resolved snapshot written by the editor: ``{"id": str, "roles": {role: {"font", "bold"?, "italic"?}}}``
for the roles title / subtitle / body / label / caption. The backend never needs the template definitions: it only reads the
snapshot. Documents without the field keep the old behaviour (theme head/body fonts).
"""

from typing import Any, Dict, Optional, Set

ROLES = ("title", "subtitle", "body", "label", "caption")
# app role string -> typography role (anything else is "generic" and follows body)
ROLE_OF = {
    "title": "title", "subtitle": "subtitle", "body": "body",
    "kicker": "label", "meta": "label", "label": "label",
    "caption": "caption", "footnote": "caption",
}


def sanitize(raw: Any) -> Optional[Dict[str, Any]]:
    """Clean snapshot or None. Title and body fonts are mandatory; other roles fall back to the body font."""
    if not isinstance(raw, dict) or not isinstance(raw.get("roles"), dict):
        return None
    roles_in = raw["roles"]

    def font(role: str) -> Optional[str]:
        e = roles_in.get(role)
        f = e.get("font") if isinstance(e, dict) else None
        return f.strip() if isinstance(f, str) and f.strip() and len(f) <= 80 else None

    title_font, body_font = font("title"), font("body")
    if not title_font or not body_font:
        return None
    roles: Dict[str, Dict[str, Any]] = {}
    for role in ROLES:
        entry: Dict[str, Any] = {"font": font(role) or body_font}
        src = roles_in.get(role) if isinstance(roles_in.get(role), dict) else {}
        for key in ("bold", "italic"):
            if key in src and (src[key] is None or isinstance(src[key], bool)):
                entry[key] = src[key]
        roles[role] = entry
    rid = raw.get("id")
    return {"id": rid[:80] if isinstance(rid, str) else "custom", "roles": roles}


def role_spec(typography: Optional[Dict[str, Any]], role: Optional[str]) -> Dict[str, Any]:
    """Spec {font, bold?, italic?} for an object role; {} when the document has no typography snapshot."""
    if not typography:
        return {}
    return typography["roles"].get(ROLE_OF.get(role or "", "body"), typography["roles"]["body"])


def fonts_of(typography: Any) -> Set[str]:
    snap = sanitize(typography) if not isinstance(typography, dict) or "roles" in typography else None
    return {e["font"] for e in snap["roles"].values()} if snap else set()
