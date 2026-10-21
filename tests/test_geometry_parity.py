import json
import shutil
import subprocess
import pytest
from backend import shape_geometry

TEST_KINDS = [
    "triangle", "rtriangle", "diamond", "pentagon", "hexagon", "octagon",
    "parallelogram", "trapezoid", "arrow", "arrow2", "callout", "callout2",
    "star4", "star5", "star6", "chevron", "ribbon", "cross",
    "line", "brace", "scalebar"
]
TEST_ADJS = [0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0]


def test_js_python_geometry_parity():
    node_bin = shutil.which("node")
    if not node_bin:
        pytest.skip("Node.js not available on PATH")

    # Generate commands from JS
    js_code = """
    const shapes = require('./js/shapes.js');
    const kinds = %s;
    const adjs = %s;
    const result = {};
    for (const k of kinds) {
        result[k] = {};
        for (const a of adjs) {
            result[k][a] = shapes.commands(k, a);
        }
    }
    console.log(JSON.stringify(result));
    """ % (json.dumps(TEST_KINDS), json.dumps(TEST_ADJS))

    res = subprocess.run([node_bin, "-e", js_code], capture_output=True, text=True, check=True)
    js_data = json.loads(res.stdout)

    for kind in TEST_KINDS:
        for adj in TEST_ADJS:
            py_cmds = shape_geometry.commands(kind, adj)
            key = str(int(adj)) if adj in (0.0, 1.0) else str(adj)
            js_cmds = js_data[kind][key]

            assert len(py_cmds) == len(js_cmds), f"Length mismatch for {kind} at adj={adj}"
            for i, (py_c, js_c) in enumerate(zip(py_cmds, js_cmds)):
                # Convert tuples/lists to lists of primitives
                py_list = list(py_c)
                assert py_list == js_c, f"Mismatch in {kind} (adj={adj}) command {i}: py={py_list} vs js={js_c}"
