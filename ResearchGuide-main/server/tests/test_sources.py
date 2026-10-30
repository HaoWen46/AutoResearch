# -*- coding: utf-8 -*-
"""sources：一个 ref 决定来源；OSF / bioRxiv 论文能打开、能带读（原来 400）；预热分派；可达性探针。全离线。"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import arxiv  # noqa: E402
import biorxiv  # noqa: E402
import llm  # noqa: E402
import main  # noqa: E402
import osf  # noqa: E402
import reading  # noqa: E402
import sources  # noqa: E402
import store  # noqa: E402

pytestmark = pytest.mark.real_auth

PAD = " ".join(["This sentence is long enough to count as real body text for the station splitter."] * 12)
OSF_ID = "psyarxiv:abcde"
BIO_ID = "biorxiv:10.1101.2024.12.06.627082"


def _pdf_paper(aid: str) -> dict:
    text = "\n".join([
        "Abstract\nA preprint about how students read papers.\n",
        "1 Introduction\n" + PAD,
        "2 Methods\n" + PAD,
        "3 Results\n" + PAD,
        "4 Limitations\nWe did not test the reading intervention outside one university. " + PAD,
        "5 Conclusion\n" + PAD,
    ])
    return {"id": aid, "title": "How students read", "source": "pdf", "text": text,
            "url": "https://osf.io/abcde/", "tables": [], "retry_after": 0}


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "sources.db")
    store.init_db()
    monkeypatch.setattr(llm, "enabled", lambda uid=None: False)
    monkeypatch.setattr(llm, "ready", lambda uid=None: False)


def _user(name="src"):
    row = store.create_user(name)
    token = store.create_session(row["uid"], 3600)
    return row["uid"], {"Authorization": f"Bearer {token}"}


def test_kind_clean_and_slash_free_refs():
    assert sources.kind("2310.17623") == "arxiv" and sources.clean("2310.17623v2") == "2310.17623"
    assert sources.kind("psyarxiv:abcde_v2") == "osf" and sources.clean("psyarxiv:abcde_v2") == OSF_ID
    assert sources.kind(BIO_ID) == "biorxiv" and sources.clean("10.1101/2024.12.06.627082") == BIO_ID
    assert sources.kind("local:0123456789ab") == "local" and sources.is_local("local:0123456789ab")
    assert sources.clean(" local:0123456789ab ") == "local:0123456789ab"
    for bad in ("openalex:W1", "10.1257/aer.20201545", "hep-th/9901001", ""):
        with pytest.raises(arxiv.ArxivError):
            sources.clean(bad)


def test_labels_and_landing_urls():
    assert sources.label("2310.17623") == "arXiv" and sources.label(OSF_ID) == "PsyArXiv"
    assert sources.label("medrxiv:10.1101.2024.01.01.123456") == "medRxiv" and sources.label("local:0123456789ab") == "导入 PDF"
    assert sources.landing_url("2310.17623") == "https://arxiv.org/abs/2310.17623"
    assert sources.landing_url(OSF_ID) == "https://osf.io/abcde/"
    assert sources.landing_url(BIO_ID) == "https://www.biorxiv.org/content/10.1101/2024.12.06.627082"
    assert sources.landing_url(BIO_ID, "https://x.test/p") == "https://x.test/p"
    assert sources.landing_url("local:0123456789ab") == ""


def test_cached_reads_paper_text_for_non_arxiv():
    assert sources.cached(OSF_ID) is None
    store.put_paper_text(OSF_ID, _pdf_paper(OSF_ID))
    got = sources.cached(OSF_ID)
    assert got and got["source"] == "pdf" and got["id"] == OSF_ID and "1 Introduction" in got["text"]
    store.put_paper_text(BIO_ID, {"id": BIO_ID, "title": "t", "source": "abstract", "text": "only abstract", "url": "", "tables": []})
    assert sources.cached(BIO_ID) is None  # 只有摘要不算正文
    assert sources.cached("local:0123456789ab") is None


def test_fulltext_dispatches_and_stores_osf(monkeypatch):
    calls = []
    monkeypatch.setattr(arxiv, "fulltext", lambda aid, hint=None: calls.append(("arxiv", aid, hint)) or {"id": aid, "source": "html", "text": "x"})
    monkeypatch.setattr(osf, "fulltext", lambda pid: calls.append(("osf", pid)) or _pdf_paper(pid))
    monkeypatch.setattr(biorxiv, "fulltext", lambda pid: calls.append(("bio", pid)) or {"id": pid, "source": "html", "text": "y"})
    sources.fulltext("2310.17623", hint={"title": "t"})
    sources.fulltext(OSF_ID)
    sources.fulltext(BIO_ID)
    assert [c[0] for c in calls] == ["arxiv", "osf", "bio"] and calls[0][2] == {"title": "t"}
    assert (store.get_paper_text(OSF_ID) or {}).get("source") == "pdf"  # OSF 自己不落库，分发层补上
    with pytest.raises(arxiv.ArxivError):
        sources.fulltext("local:0123456789ab")
    monkeypatch.setattr(arxiv, "fulltext", lambda aid: {"id": aid, "source": "html", "text": "x"})  # 旧打桩只收一个参数
    assert sources.fulltext("2310.17623")["source"] == "html"


def test_warm_fetch_goes_through_sources(monkeypatch):
    seen = []
    monkeypatch.setattr(sources, "fulltext", lambda aid, hint=None: seen.append((aid, hint)) or {"id": aid, "source": "abstract", "text": ""})
    reading.warm_fetch(OSF_ID)
    reading.warm_fetch("2310.17623", hint={"title": "t"})
    assert seen == [(OSF_ID, None), ("2310.17623", {"title": "t"})]


def test_osf_paper_opens_and_tutor_starts(monkeypatch):
    """原来 PsyArXiv 论文点「带读答题」是 400（arxiv.clean_id 拒掉 psyarxiv: 前缀）。"""
    monkeypatch.setattr(osf, "fulltext", lambda pid: _pdf_paper(pid))
    client = TestClient(main.app)
    uid, h = _user()
    r = client.get(f"/api/papers/{OSF_ID}", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "pdf" and body["lib_at"] == "db"
    assert [s["name"] for s in body["sections"]][:2] == ["introduction", "methods"]  # PDF 走 strict 分节
    r = client.get(f"/api/tutor/{OSF_ID}?uid={uid}&kit=", headers=h)
    assert r.status_code == 200, r.text  # 原来在 _paper_ref 就 400
    assert r.json()["in_kit"] is False
    # 开始带读：路由先取正文、建引文索引，再进出题；出题本身打桩（没模型时 tutor.start 自己会 400「现在用不了模型」）
    seen = {}
    monkeypatch.setattr(main.tutor, "start", lambda uid_, kit, aid, restart: seen.update(aid=aid) or {"session": {"aid": aid}})
    r = client.post(f"/api/tutor/{OSF_ID}/start", json={"uid": uid, "kit": "", "restart": False}, headers=h)
    assert r.status_code == 200, r.text
    assert seen["aid"] == OSF_ID and r.json()["session"]["aid"] == OSF_ID
    r = client.post("/api/tutor/psyarxiv:zzzzz/start", json={"uid": uid, "kit": "", "restart": False}, headers=h)
    assert r.status_code == 200  # 同样走 osf.fulltext 打桩；id 形状对就不再被 arXiv 规则拒


def test_osf_paper_without_fulltext_falls_back_to_catalogue_abstract(monkeypatch):
    def boom(pid):
        raise osf.OsfError("连不上 OSF")
    monkeypatch.setattr(osf, "fulltext", boom)
    store.put_paper_dir("190.20", OSF_ID, "psy-soc", 1, "psyarxiv", "Only abstract",
                        summary="Just the abstract.", published="2026-01-01", url="https://osf.io/abcde/")
    def bio_404(pid):
        raise biorxiv.BiorxivError(f"bioRxiv 上没有 {pid}", 404)
    monkeypatch.setattr(biorxiv, "fulltext", bio_404)
    client = TestClient(main.app)
    _uid, h = _user()
    r = client.get(f"/api/papers/{OSF_ID}", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "abstract" and r.json()["text"] == "Just the abstract."
    r = client.get(f"/api/papers/{BIO_ID}", headers=h)
    assert r.status_code == 404, r.text  # 目录里也没有：如实报错，不编


def test_probe_runs_all_sources_in_parallel(monkeypatch):
    monkeypatch.setattr(sources, "probe_one", lambda n, url, timeout=8.0: {"status": 200, "ms": 5, "ok": True, "error": ""})
    out = sources.probe(timeout=1.0)
    assert set(out) == set(sources.PROBES) and all(v["ok"] for v in out.values())
    assert set(sources.probe(["arxiv", "nope"])) == {"arxiv"}


def test_admin_probe_endpoint(monkeypatch):
    token = "isolated-test-admin-token-000000000000"
    monkeypatch.setenv("ADMIN_TOKEN", token)
    monkeypatch.setattr(sources, "probe", lambda timeout=8.0: {"openalex": {"status": 200, "ms": 7, "ok": True, "error": ""}})
    client = TestClient(main.app)
    assert client.get("/api/admin/sources/probe").status_code in (403, 429)
    r = client.get("/api/admin/sources/probe?timeout=3", headers={"X-Admin-Token": token})
    assert r.status_code == 200 and r.json()["sources"]["openalex"]["ok"] is True
