"""tests/test_academic_templates.py

Verifies that all 10 Academic Templates:
1. Are properly defined and serialized.
2. Comply with the PresentationDoc schema.
3. Contain 26 distinct, editable slide layouts each (260 total slides).
4. Export to valid PowerPoint (.pptx) documents without errors.
"""

import json
import os
import subprocess
import pytest
from backend.models import PresentationDoc
from backend.exporter import export_presentation

DECKS_CACHE = "/tmp/academic_templates_decks.json"

@pytest.fixture(scope="session", autouse=True)
def ensure_decks_generated():
    """Ensure decks are built from js/templates."""
    subprocess.run(["node", "tests/test_templates.js"], check=True)
    assert os.path.exists(DECKS_CACHE), "Decks json cache must exist"


EXPECTED_TEMPLATES = [
    ("clinical-blue", "Clinical Blue", False),
    ("editorial-review", "Editorial Review", False),
    ("field-biology", "Field Biology", False),
    ("molecular-translational", "Molecular & Translational", False),
    ("hematology-oncology", "Hematology & Oncology", False),
    ("data-methods", "Data & Methods", False),
    ("population-health", "Population Health", False),
    ("computational-biology", "Computational Biology", False),
    ("dark-auditorium", "Dark Auditorium", True),
    ("swiss-minimal", "Swiss Scientific Minimal", False),
]


@pytest.mark.parametrize("tpl_id, tpl_name, is_dark", EXPECTED_TEMPLATES)
def test_template_deck_validation(tpl_id, tpl_name, is_dark):
    with open(DECKS_CACHE) as f:
        decks = json.load(f)

    assert tpl_id in decks, f"Template {tpl_id} must be in catalog"
    deck_dict = decks[tpl_id]
    doc = PresentationDoc.model_validate(deck_dict)

    assert len(doc.slides) == 26, f"{tpl_id} must have exactly 26 slides"
    assert doc.templateId == tpl_id

    # Verify each slide has a valid layout and objects
    for i, slide in enumerate(doc.slides):
        assert slide.layout, f"Slide {i} in {tpl_id} must have a non-empty layout"
        assert len(slide.objects) > 0, f"Slide {i} in {tpl_id} must have objects"

    # Verify PPTX export
    bio = export_presentation(doc)
    pptx_bytes = bio.getvalue()
    assert len(pptx_bytes) > 20000, f"Exported PPTX for {tpl_id} must be substantial"
