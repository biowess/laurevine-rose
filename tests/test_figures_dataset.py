"""CSV parsing, type inference, validation and /api/figures/dataset/parse (docs/FIGURES_CONTRACT.md s3b, s4)."""
import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend.figures.dataset import (
    MAX_BYTES,
    correlation_ready_columns,
    parse_csv,
    to_matrix,
    validate_dataset,
)
from backend.figures.models import Dataset
from backend.server import app

client = TestClient(app)


def codes(items):
    return [i["code"] for i in items]


def types(res):
    return {c["name"]: c["type"] for c in res["columns"]}


# ------------------------------------------------------------ delimiters
@pytest.mark.parametrize("delim", [",", ";", "\t", "|"])
def test_delimiter_sniffing(delim):
    text = delim.join(["x", "y", "label"]) + "\n" + "\n".join(delim.join([str(i), str(i * 2.5), f"g{i}"]) for i in range(6)) + "\n"
    res = parse_csv(text)
    assert res["errors"] == [] and res["delimiter"] == delim and res["hasHeader"] is True
    assert [c["name"] for c in res["columns"]] == ["x", "y", "label"]
    assert types(res) == {"x": "number", "y": "number", "label": "text"}
    assert res["rows"][2] == [2, 5.0, "g2"]


def test_delimiter_override_and_single_column_default():
    assert parse_csv("a;b\n1;2\n", delimiter=",")["columns"][0]["name"] == "a;b"
    assert parse_csv("v\n1\n2\n3\n")["delimiter"] == ","


def test_semicolon_file_with_decimal_commas_is_reported_not_silent():
    res = parse_csv("a;b\n1,5;2\n2,5;3\n")
    assert res["delimiter"] == ";" and res["rows"] == [[1.5, 2], [2.5, 3]]
    assert "decimal_comma" in codes(res["warnings"])


# ---------------------------------------------------------------- quotes
def test_quoted_values_delimiters_quotes_and_newlines():
    text = 'name,note,v\n"Smith, J","said ""hi""",1\n"Lee","two\nlines",2\n'
    res = parse_csv(text)
    assert res["errors"] == [] and res["warnings"] == []
    assert res["rows"] == [["Smith, J", 'said "hi"', 1], ["Lee", "two\nlines", 2]]


def test_unclosed_quote_is_a_warning():
    res = parse_csv('a,b\n1,"oops\n2,3\n')
    assert "quote_problem" in codes(res["warnings"]) and res["errors"] == []


# ------------------------------------------------------------- BOM / encoding
def test_utf8_bom_is_stripped_and_text_returned_untouched():
    raw = b"\xef\xbb\xbfa,b\r\n1,2\r\n"
    res = parse_csv(raw)
    assert res["encoding"] == "utf-8-sig" and res["columns"][0]["name"] == "a"
    assert res["originalText"] == "a,b\r\n1,2\r\n"  # line endings preserved, BOM only removed by decoding


def test_latin1_fallback_warns():
    res = parse_csv("name,v\nCaf\xe9,1\nNa\xefve,2\n".encode("latin-1"))
    assert res["encoding"] == "latin-1" and res["rows"][0][0] == "Café"
    assert "encoding_fallback" in codes(res["warnings"])


def test_utf16_and_binary():
    assert parse_csv("a,b\n1,2\n".encode("utf-16"))["rows"] == [[1, 2]]
    assert codes(parse_csv(b"\x00\x01\x02\x03binary\x00")["errors"]) == ["binary_file"]


def test_str_input_not_mutated():
    text = "a,b\n1,2\n"
    assert parse_csv(text)["originalText"] == text


# --------------------------------------------------------------- header detection
def test_header_detection():
    assert parse_csv("1,2\n3,4\n5,6\n")["hasHeader"] is False
    no_hdr = parse_csv("1,2\n3,4\n5,6\n")
    assert [c["name"] for c in no_hdr["columns"]] == ["Column 1", "Column 2"] and len(no_hdr["rows"]) == 3
    assert parse_csv("time,value\n1,2\n3,4\n")["hasHeader"] is True
    assert parse_csv("1,2\n3,4\n", has_header=True)["rows"] == [[3, 4]]
    assert parse_csv("name,city\nAnn,Oslo\nBo,Rome\n")["hasHeader"] is True


def test_duplicate_and_empty_headers_are_renamed_with_warning():
    res = parse_csv("a,a,\n1,2,3\n4,5,6\n")
    assert [c["name"] for c in res["columns"]] == ["a", "a (2)", "Column 3"]
    assert codes(res["warnings"]).count("column_renamed") == 2
    Dataset(columns=res["columns"], rows=res["rows"])  # unique, non-empty names


# ------------------------------------------------------------ type inference
def test_text_in_number_column_reports_coordinates_and_leaves_cell_empty():
    rows = "\n".join(f"{i},{i * 1.5}" for i in range(20))
    res = parse_csv("x,y\n" + rows.replace("5,7.5", "5,n/a") + "\n")
    assert types(res) == {"x": "number", "y": "number"}
    bad = res["report"]["invalidNumeric"]
    assert res["report"]["invalidNumericTotal"] == 1
    assert bad == [{"row": 5, "col": 1, "column": "y", "value": "n/a"}]
    assert res["rows"][5][1] is None and "invalid_numeric" in codes(res["warnings"])


def test_ninety_percent_rule_is_not_silent_coercion():
    nine = parse_csv("v\n" + "\n".join(["1"] * 9 + ["x"]) + "\n")
    assert types(nine)["v"] == "number" and nine["report"]["invalidNumericTotal"] == 1
    eight = parse_csv("v\n" + "\n".join(["1"] * 8 + ["x", "y"]) + "\n")
    assert types(eight)["v"] == "text" and "1" in eight["rows"][0]  # text kept verbatim
    assert "mixed_column" in codes(eight["warnings"]) and eight["report"]["invalidNumericTotal"] == 0


@pytest.mark.parametrize("cell", ["007", "1,234", "5%", "NaN", "inf", "\u22123", "1e999", "$4"])
def test_non_plain_numbers_are_not_numbers(cell):
    res = parse_csv(f'v,w\n"{cell}",a\n"{cell}",b\n')
    assert types(res)["v"] == "text" and res["rows"][0][0] == cell


def test_number_forms_and_int_float():
    res = parse_csv("v\n1\n-2\n+3\n.5\n2.\n1e3\n-0.25\n")
    assert [r[0] for r in res["rows"]] == [1, -2, 3, 0.5, 2.0, 1000.0, -0.25]
    assert isinstance(res["rows"][0][0], int) and isinstance(res["rows"][1][0], int)


def test_empty_columns_and_missing_counts():
    res = parse_csv("a,b,c\n1,,x\n2,,\n3,,y\n")
    rep = res["report"]
    assert rep["emptyColumns"] == ["b"] and "empty_column" in codes(res["warnings"])
    by = {c["name"]: c for c in rep["columns"]}
    assert by["b"]["missing"] == 3 and by["c"]["missing"] == 1 and by["a"]["missing"] == 0
    assert res["rows"][1] == [2, None, None]


def test_output_loads_into_dataset_model():
    res = parse_csv("x,y,g\n1,2.5,a\n2,,b\n3,4,\n")
    ds = Dataset(columns=res["columns"], rows=res["rows"], origin={"type": "csv", "label": "t.csv"})
    assert len(ds.rows) == 3


# ----------------------------------------------------------------- ragged rows
def test_ragged_rows_padded_dropped_and_reported():
    res = parse_csv("a,b,c\n1,2,3\n4,5\n6,7,8,9\n10,11,12\n")
    assert res["rows"] == [[1, 2, 3], [4, 5, None], [6, 7, 8], [10, 11, 12]]
    assert res["report"]["raggedTotal"] == 2
    assert res["report"]["raggedRows"] == [{"row": 1, "cells": 2, "expected": 3}, {"row": 2, "cells": 4, "expected": 3}]
    assert "ragged_rows" in codes(res["warnings"])


def test_blank_rows_skipped_with_info():
    res = parse_csv("a,b\n1,2\n\n,\n3,4\n")
    assert res["rows"] == [[1, 2], [3, 4]]
    assert [w["level"] for w in res["warnings"] if w["code"] == "blank_rows"] == ["info"]


# --------------------------------------------------- empty / header only / huge
@pytest.mark.parametrize("payload", ["", b"", "   \n\n", b"\xef\xbb\xbf"])
def test_empty_file(payload):
    res = parse_csv(payload)
    assert codes(res["errors"]) == ["empty_file"] and res["columns"] == [] and res["rows"] == []


def test_header_only():
    res = parse_csv("a,b\n")
    assert [c["name"] for c in res["columns"]] == ["a", "b"] and res["rows"] == []
    assert "no_data_rows" in codes(res["warnings"])


def test_file_size_cap():
    big = b"a,b\n" + b"1,2\n" * (MAX_BYTES // 4)  # slightly over 5 MB
    assert len(big) > MAX_BYTES
    res = parse_csv(big)
    assert codes(res["errors"]) == ["file_too_large"] and res["rows"] == [] and "5 MB" in res["errors"][0]["message"]
    assert codes(parse_csv(big.decode())["errors"]) == ["file_too_large"]
    assert parse_csv(b"a,b\n" + b"1,2\n" * 1000)["errors"] == []


def test_row_cap_truncates_with_message():
    res = parse_csv("v\n" + "1\n" * 200_001)
    assert res["errors"] == [] and len(res["rows"]) == 200_000 and res["report"]["truncated"] is True
    w = [w for w in res["warnings"] if w["code"] == "row_cap"][0]
    assert "200,000" in w["message"]
    small = parse_csv("v\n1\n2\n3\n4\n", max_rows=2)
    assert len(small["rows"]) == 2 and "row_cap" in codes(small["warnings"])


def test_cell_cap_keeps_result_storable():
    cols = 12
    res = parse_csv(",".join(f"c{i}" for i in range(cols)) + "\n" + (",".join(["1"] * cols) + "\n") * 190_000)
    assert "cell_cap" in codes(res["warnings"]) and len(res["rows"]) * cols <= 2_000_000
    assert len(res["rows"]) == 2_000_000 // cols


def test_too_many_columns():
    res = parse_csv(",".join(f"c{i}" for i in range(300)) + "\n" + ",".join(["1"] * 300) + "\n")
    assert codes(res["errors"]) == ["too_many_columns"]


# ------------------------------------------------------------ validation
def ds(cols, rows):
    return {"columns": [{"name": n, "type": t} for n, t in cols], "rows": rows}


DATA = ds([("x", "number"), ("y", "number"), ("Group", "text"), ("e", "number")],
          [[1, 2.0, "a", 0.1], [2, 3.0, "b", 0.1], [3, None, "a", 0.2]])


def test_histogram_text_column_message():
    out = validate_dataset(DATA, "hist", {"y": ["Group"]})
    err = [i for i in out if i["level"] == "error"]
    assert err[0]["code"] == "column_not_numeric" and err[0]["column"] == "Group"
    assert err[0]["message"].startswith("Column 'Group' is text; histogram needs numbers")


def test_valid_mappings_have_no_errors():
    assert not [i for i in validate_dataset(DATA, "scatter", {"x": "x", "y": ["y"], "group": "Group"}) if i["level"] == "error"]
    assert not [i for i in validate_dataset(DATA, "box", {"y": ["y"], "x": "Group"}) if i["level"] == "error"]
    assert not [i for i in validate_dataset(DATA, "bar", {"x": "Group", "y": ["y"], "yErr": "e"}) if i["level"] == "error"]
    assert not [i for i in validate_dataset(DATA, "line", {"y": ["y"]}) if i["level"] == "error"]


def test_missing_required_unknown_and_unused():
    assert [i["code"] for i in validate_dataset(DATA, "scatter", {"y": ["y"]}) if i["level"] == "error"] == ["mapping_missing"]
    assert codes(validate_dataset(DATA, "hist", {})) == ["mapping_missing"]
    assert [i["code"] for i in validate_dataset(DATA, "line", {"x": "nope", "y": ["y"]}) if i["level"] == "error"] == ["column_missing"]
    assert codes(validate_dataset(DATA, "pie", {})) == ["unknown_plot_type"]
    unused = validate_dataset(DATA, "hist", {"y": ["y"], "x": "x"})
    assert [(i["level"], i["code"]) for i in unused if i["code"] == "mapping_unused"] == [("info", "mapping_unused")]


def test_missing_values_warning_and_empty_column_error():
    out = validate_dataset(DATA, "line", {"x": "x", "y": ["y"]})
    assert [(i["level"], i["code"]) for i in out] == [("warning", "missing_values")]
    empty = ds([("x", "number"), ("y", "number")], [[1, None], [2, None]])
    assert codes(validate_dataset(empty, "line", {"x": "x", "y": ["y"]})) == ["column_empty"]
    assert codes(validate_dataset(ds([("x", "number")], []), "line", {"y": ["x"]})) == ["no_rows"]
    assert codes(validate_dataset(ds([], []), "line", {})) == ["no_columns"]


def test_text_column_that_mostly_looks_numeric_gets_a_hint():
    d = ds([("v", "text")], [["1"], ["2"], ["3"], ["x"]])
    msg = validate_dataset(d, "scatter", {"x": "v", "y": ["v"]})[0]["message"]
    assert "Only 3 of 4 values look like numbers" in msg


def test_heatmap_needs_two_numeric_columns():
    assert codes(validate_dataset(DATA, "heatmap", {})) == []  # x, y, e are numeric
    one = ds([("a", "number"), ("t", "text")], [[1, "u"], [2, "v"]])
    assert codes(validate_dataset(one, "heatmap", {})) == ["too_few_numeric_columns"]
    assert "column_not_numeric" in codes(validate_dataset(DATA, "heatmap", {"y": ["x", "Group"]}))


def test_many_groups_warning_and_model_inputs():
    d = ds([("g", "text"), ("v", "number")], [[f"g{i}", i] for i in range(25)])
    assert codes(validate_dataset(d, "box", {"y": ["v"], "group": "g"})) == ["many_groups"]
    model = Dataset(columns=[{"name": "v", "type": "number"}], rows=[[1], [2]])
    assert validate_dataset(model, "hist", {"y": ["v"]}) == []


# ---------------------------------------------------------------- helpers
def test_to_matrix():
    m = to_matrix(DATA)
    assert m.shape == (3, 3) and m.dtype == np.float64 and np.isnan(m[2, 1]) and m[0, 0] == 1.0
    assert to_matrix(DATA, ["y", "x"])[1].tolist() == [3.0, 2.0]
    with pytest.raises(ValueError, match="Column 'Group' is text"):
        to_matrix(DATA, ["Group"])
    with pytest.raises(ValueError, match="not in the dataset"):
        to_matrix(DATA, ["zzz"])


def test_correlation_ready_columns():
    d = ds([("a", "number"), ("const", "number"), ("few", "number"), ("t", "text"), ("b", "number")],
           [[1, 5, 1, "x", 2.0], [2, 5, None, "y", 4.0], [3, 5, 3, "z", None], [4, 5, None, "w", 9.0]])
    assert correlation_ready_columns(d) == ["a", "b"]
    assert correlation_ready_columns(d, min_valid=2) == ["a", "few", "b"]


# ---------------------------------------------------------------- endpoint
def test_endpoint_multipart():
    r = client.post("/api/figures/dataset/parse", files={"file": ("d.csv", b"\xef\xbb\xbfa;b\n1;2\n3;4\n", "text/csv")})
    j = r.json()
    assert r.status_code == 200 and j["ok"] is True and j["status"] == "ok" and j["fileName"] == "d.csv"
    assert j["delimiter"] == ";" and j["originalText"] == "a;b\n1;2\n3;4\n" and j["rows"] == [[1, 2], [3, 4]]


def test_endpoint_multipart_options():
    r = client.post("/api/figures/dataset/parse", files={"file": ("d.csv", b"1,2\n3,4\n", "text/csv")},
                    data={"hasHeader": "true", "delimiter": ","})
    assert r.json()["rows"] == [[3, 4]]


def test_endpoint_json_text_and_options():
    r = client.post("/api/figures/dataset/parse", json={"text": "a\tb\n1\t2\n", "fileName": "t.tsv"})
    j = r.json()
    assert j["ok"] and j["delimiter"] == "\t" and j["fileName"] == "t.tsv"
    j2 = client.post("/api/figures/dataset/parse", json={"text": "1;2\n3;4\n", "hasHeader": False, "delimiter": ";"}).json()
    assert len(j2["rows"]) == 2
    j3 = client.post("/api/figures/dataset/parse", json={"text": "a|b\n1|2\n", "delimiter": "auto", "hasHeader": "auto"}).json()
    assert j3["delimiter"] == "|"
    j4 = client.post("/api/figures/dataset/parse", json={"text": "a\tb\n1\t2\n", "delimiter": "tab"}).json()
    assert j4["delimiter"] == "\t"


def test_endpoint_empty_and_oversize_are_200_with_errors():
    j = client.post("/api/figures/dataset/parse", json={"text": ""}).json()
    assert j["ok"] is False and j["status"] == "error" and j["errors"][0]["code"] == "empty_file"
    big = b"a,b\n" + b"1,2\n" * (MAX_BYTES // 4 + 10)
    r = client.post("/api/figures/dataset/parse", files={"file": ("big.csv", big, "text/csv")})
    assert r.status_code == 200 and r.json()["errors"][0]["code"] == "file_too_large"


def test_endpoint_malformed_requests_are_4xx():
    url = "/api/figures/dataset/parse"
    assert client.post(url, json={"nope": 1}).status_code == 400
    assert client.post(url, json=["a"]).status_code == 400
    assert client.post(url, content=b"{bad", headers={"content-type": "application/json"}).status_code == 400
    assert client.post(url, files={"other": ("d.csv", b"a,b\n")}).status_code == 400
    assert client.post(url, content=b"a,b\n1,2", headers={"content-type": "text/csv"}).status_code == 415
    assert client.post(url, json={"text": "a,b", "delimiter": "x"}).status_code == 400
    assert client.post(url, json={"text": "a,b", "hasHeader": "maybe"}).status_code == 400
    assert client.post(url, content=b"x", headers={"content-type": "application/json", "content-length": str(50 * 1024 * 1024)}).status_code in (400, 413)
