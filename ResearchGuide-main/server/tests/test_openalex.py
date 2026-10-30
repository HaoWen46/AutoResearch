# -*- coding: utf-8 -*-
"""OpenAlex 底座：id 归一、摘要还原、arXiv 作品归一成裸 id、检索/目录/元数据的请求形状、正文（OA PDF / 摘要）、
sources 分派、搜索路由接受中文、库内搜索认中文、话题表里非理工分支都配了 OpenAlex。全离线。"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import arxiv  # noqa: E402
import llm  # noqa: E402
import main  # noqa: E402
import openalex  # noqa: E402
import paper_collect  # noqa: E402
import reading  # noqa: E402
import sources  # noqa: E402
import store  # noqa: E402

pytestmark = pytest.mark.real_auth
ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "openalex.db")
    store.init_db()
    monkeypatch.setattr(llm, "enabled", lambda uid=None: False)
    monkeypatch.setattr(llm, "ready", lambda uid=None: False)
    openalex._CACHE = type(openalex._CACHE)(3600, 256)


def _user(name="oa"):
    row = store.create_user(name)
    token = store.create_session(row["uid"], 3600)
    return row["uid"], {"Authorization": f"Bearer {token}"}


def _work(wid="W1", title="Inflation expectations and monetary policy", doi="https://doi.org/10.1257/aer.1",
          landing=None, oa_pdf="https://pub.test/paper.pdf", venue="American Economic Review", lang="en",
          abstract=("We study inflation expectations.", ), locations=None):
    inv = {}
    for i, w in enumerate(" ".join(abstract).split()):
        inv.setdefault(w, []).append(i)
    return {"id": f"https://openalex.org/{wid}", "doi": doi, "title": title, "display_name": title,
            "publication_date": "2024-03-01", "language": lang, "cited_by_count": 12,
            "authorships": [{"author": {"display_name": "A. Author"}}, {"author": {"display_name": "B. Writer"}}],
            "primary_location": {"landing_page_url": landing or doi, "source": {"display_name": venue}},
            "locations": locations or [], "best_oa_location": {"pdf_url": oa_pdf} if oa_pdf else None,
            "primary_topic": {"subfield": {"display_name": "Economics and Econometrics"}, "field": {"display_name": "Economics, Econometrics and Finance"}},
            "abstract_inverted_index": inv}


def _fake_fetch(calls, works=None, pdf=b"%PDF fake", status=None):
    def fake(req, timeout=20, max_bytes=0, idle=None):
        url = req.full_url
        calls.append(url)
        if status:
            raise urllib.error.HTTPError(url, status, "x", {}, None)
        if url.startswith("https://api.openalex.org/works"):
            return json.dumps({"meta": {"count": len(works or [])}, "results": works or []}).encode("utf-8")
        return pdf
    return fake


def test_clean_id_forms():
    for raw in ("openalex:W123", "OPENALEX:w123", "W123", "https://openalex.org/W123", "https://api.openalex.org/works/W123/"):
        assert openalex.clean_id(raw) == "openalex:W123", raw
    assert openalex.is_id("openalex:W123") and not openalex.is_id("W123") and not openalex.is_id("2310.17623")
    for bad in ("2310.17623", "psyarxiv:abcde", "10.1257/aer.1", ""):
        with pytest.raises(openalex.OpenAlexError) as exc:
            openalex.clean_id(bad)
        assert exc.value.status == 400


def test_abstract_of_rebuilds_order():
    assert openalex.abstract_of({"study": [1], "We": [0], "expectations.": [3], "inflation": [2]}) == "We study inflation expectations."
    assert openalex.abstract_of(None) == "" and openalex.abstract_of({}) == ""


def test_entry_normalizes_arxiv_hosted_work():
    w = _work(wid="W9", doi="", landing="https://arxiv.org/abs/2310.17623v2", oa_pdf="https://arxiv.org/pdf/2310.17623v2")
    e = openalex.entry(w)
    assert e["id"] == "2310.17623" and e["source"] == "arxiv" and e["url"] == "https://arxiv.org/abs/2310.17623"
    w2 = _work(wid="W10", doi="https://doi.org/10.48550/arXiv.2009.03300", landing="https://doi.org/10.48550/arXiv.2009.03300", oa_pdf="")
    assert openalex.entry(w2)["id"] == "2009.03300"
    w3 = _work(wid="W11", locations=[{"landing_page_url": "https://arxiv.org/pdf/1706.03762"}])
    assert openalex.entry(w3)["id"] == "1706.03762"


def test_entry_plain_journal_article():
    e = openalex.entry(_work())
    assert e["id"] == "openalex:W1" and e["source"] == "openalex" and e["url"] == "https://doi.org/10.1257/aer.1"
    assert e["venue"] == "American Economic Review" and e["oa_pdf"] == "https://pub.test/paper.pdf"
    assert e["summary"] == "We study inflation expectations." and e["authors"] == ["A. Author", "B. Writer"]
    assert e["categories"] == ["Economics and Econometrics", "Economics, Econometrics and Finance"]
    assert e["published"] == "2024-03-01" and e["cited_by"] == 12 and e["doi"].endswith("aer.1")


def test_search_recent_meta_request_shapes(monkeypatch):
    calls = []
    monkeypatch.setattr(openalex, "fetch", _fake_fetch(calls, [_work()]))
    got = openalex.search("通货膨胀预期", 5)
    assert got and got[0]["id"] == "openalex:W1"
    assert "search=%E9%80%9A%E8%B4%A7%E8%86%A8%E8%83%80%E9%A2%84%E6%9C%9F" in calls[-1] and "is_paratext:false" in calls[-1] and "per-page=5" in calls[-1]
    openalex.recent(["2002", "subfields/2000"], ["macroeconomics", "monetary policy"], max_results=7, years=3)
    u = calls[-1]
    assert "primary_topic.subfield.id:subfields/2002|subfields/2000" in u and "sort=cited_by_count:desc" in u
    assert "from_publication_date:" in u and "search=macroeconomics+monetary+policy" in u and "per-page=7" in u
    openalex.meta(["openalex:W1", "W2", "junk"])
    assert "filter=openalex_id:W1|W2" in calls[-1]
    assert openalex.search("openalex:W1") and "openalex_id:W1" in calls[-1]  # 作品号直接取那一篇
    n = len(calls)
    openalex.meta(["W1", "W2"])
    assert len(calls) == n  # 一小时内同一请求走缓存


def test_fulltext_pdf_then_abstract(monkeypatch):
    import pdf as pdf_mod
    calls = []
    monkeypatch.setattr(openalex, "fetch", _fake_fetch(calls, [_work()]))
    monkeypatch.setattr(pdf_mod, "extract_pdf", lambda blob: {"title": "", "text": "1 Introduction\n" + "x " * 1500})
    got = openalex.fulltext("openalex:W1")
    assert got["source"] == "pdf" and got["id"] == "openalex:W1" and calls[-1] == "https://pub.test/paper.pdf"
    openalex._CACHE = type(openalex._CACHE)(3600, 256)
    monkeypatch.setattr(openalex, "fetch", _fake_fetch(calls, [_work(oa_pdf="")]))
    got = openalex.fulltext("W1")
    assert got["source"] == "abstract" and got["reason"] == "no_pdf" and got["retry_after"] > time.time() + 3600
    openalex._CACHE = type(openalex._CACHE)(3600, 256)
    monkeypatch.setattr(openalex, "fetch", _fake_fetch(calls, [_work()]))
    monkeypatch.setattr(pdf_mod, "extract_pdf", lambda blob: (_ for _ in ()).throw(ValueError("bad pdf")))
    got = openalex.fulltext("W1")
    assert got["source"] == "abstract" and got["reason"] == "pdf_failed" and got["retry_after"] < time.time() + 3600
    openalex._CACHE = type(openalex._CACHE)(3600, 256)
    monkeypatch.setattr(openalex, "fetch", _fake_fetch(calls, []))
    with pytest.raises(openalex.OpenAlexError) as exc:
        openalex.fulltext("W404")
    assert exc.value.status == 404


def test_upstream_status_is_kept(monkeypatch):
    monkeypatch.setattr(openalex, "fetch", _fake_fetch([], status=429))
    with pytest.raises(openalex.OpenAlexError) as exc:
        openalex.search("anything")
    assert exc.value.status == 429


def test_sources_dispatch_openalex(monkeypatch):
    assert sources.kind("openalex:W1") == "openalex" and sources.kind("https://openalex.org/W1") == "openalex"
    assert sources.clean("W77") == "openalex:W77" and sources.label("openalex:W77") == "DOI"
    assert sources.landing_url("openalex:W77") == "https://openalex.org/W77"
    monkeypatch.setattr(openalex, "fulltext", lambda pid: {"id": pid, "title": "t", "source": "pdf", "text": "x " * 1200, "url": "https://doi.org/10.1/x", "tables": [], "retry_after": 0})
    got = sources.fulltext("openalex:W77")
    assert got["source"] == "pdf" and (store.get_paper_text("openalex:W77") or {}).get("source") == "pdf"
    assert sources.cached("openalex:W77")["source"] == "pdf"


def test_search_route_accepts_chinese_and_fills_from_openalex(monkeypatch):
    seen = {"oa": [], "ax": []}
    monkeypatch.setattr(reading.openalex, "search", lambda q, n=20: seen["oa"].append(q) or [openalex.entry(_work())])
    monkeypatch.setattr(reading.arxiv, "search", lambda q, n=20: seen["ax"].append(q) or [{"id": "2310.17623", "title": "An arXiv hit", "summary": "", "authors": [], "published": "2024-01-01", "categories": ["cs.CL"], "url": "https://arxiv.org/abs/2310.17623"}])
    client = TestClient(main.app)
    uid, h = _user()
    r = client.get(f"/api/papers/search?q=通货膨胀预期&uid={uid}", headers=h)
    assert r.status_code == 200, r.text
    ids = [it["id"] for it in r.json()["items"]]
    assert ids == ["openalex:W1"] and seen["ax"] == []  # 中文只问 OpenAlex
    r = client.get(f"/api/papers/search?q=inflation+expectations&uid={uid}", headers=h)
    assert r.status_code == 200
    ids = [it["id"] for it in r.json()["items"]]
    assert ids[0] == "2310.17623" and "openalex:W1" in ids and seen["ax"] == ["inflation expectations"]  # 英文 arXiv 在前，OpenAlex 补


def test_library_search_matches_chinese_tokens():
    store.put_paper_dir("790.13", "openalex:W5", "oa-econ-macro", 1, "openalex", "我国通货膨胀预期的形成机理",
                        summary="中文摘要", published="2025-01-01", url="https://doi.org/10.1/zh")
    store.put_paper_dir("790.13", "2310.17623", "econ-macro", 2, "arxiv", "Inflation expectations survey",
                        summary="English abstract", published="2024-01-01", url="https://arxiv.org/abs/2310.17623")
    assert [p["id"] for p in store.search_paper_dir("通货膨胀")] == ["openalex:W5"]
    assert [p["id"] for p in store.search_paper_dir("inflation")] == ["2310.17623"]
    assert [p["id"] for p in store.search_paper_dir("预期 形成")] == ["openalex:W5"]


def test_topics_table_has_openalex_for_non_arxiv_branches():
    table = json.loads((ROOT / "knowledge" / "arxiv_topics.json").read_text(encoding="utf-8"))
    topics, nodes = table["topics"], table["nodes"]
    for nid, tids in nodes.items():
        if nid.split(".")[0] in ("790", "190", "310"):
            oa = [t for t in tids if (topics.get(t) or {}).get("source") == "openalex"]
            assert oa, f"{nid} 没有 OpenAlex 话题"
    for tid, spec in topics.items():
        if spec.get("source") == "openalex":
            assert spec.get("subfields") and all(str(s).isdigit() for s in spec["subfields"]), tid
            assert spec.get("name") and spec.get("slugs"), tid


def test_fetch_topic_and_topic_source_dispatch_openalex(monkeypatch):
    seen = []
    monkeypatch.setattr(openalex, "recent", lambda subfields, keywords, max_results=25, years=3: seen.append((tuple(subfields), tuple(keywords), max_results)) or [openalex.entry(_work())])
    got, err = paper_collect._fetch_topic("oa-econ-macro", max_results=9)
    assert err == "" and got[0]["id"] == "openalex:W1" and seen[-1][2] == 9 and "2002" in seen[-1][0]
    papers, err, stale = reading.topic_source("oa-econ-macro")
    assert err == "" and not stale and papers[0]["source"] == "openalex"
    import interests
    assert interests.is_thin_topic("oa-med-anat") is False
