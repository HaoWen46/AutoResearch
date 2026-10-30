# -*- coding: utf-8 -*-
"""论文来源分发：一个 ref 字符串决定去哪个模块，main / reading / tutor / paper_collect 不再各写一串 if。

ref 的形状（都不带斜杠：FastAPI 路径 `{arxiv_id}` 和磁盘缓存文件名吃不下 DOI 的 `/`）：
  2310.17623                    arxiv（裸 id，兼容所有旧数据）
  psyarxiv:xxxxx / socarxiv:…   osf（PsyArXiv / SocArXiv 预印本，正文是 PDF 抽文）
  openalex:W123                 openalex（全学科目录；作品挂在 arXiv 上的在入口就归一成裸 arXiv id）
  biorxiv:10.1101.… / medrxiv:… biorxiv（DOI 里的 / 写成 .，见 biorxiv.clean_id）
  local:<sha12>                 用户自己导入的 PDF，只本人可见，走 store.get_user_paper，不在这里取
新来源（openalex:W…、pmc:PMC…、nber:w…）只加在这个文件里。
正文结果的形状同 arxiv.fulltext：{id, title, source(html|pdf|abstract), text, url, tables, retry_after}。
"""
from __future__ import annotations

import re
import threading
import time
import urllib.error
import urllib.request
from typing import Any

import arxiv
import biorxiv
import openalex
import osf
import store

ERRORS = (arxiv.ArxivError, osf.OsfError, biorxiv.BiorxivError, openalex.OpenAlexError)
LABELS = {"arxiv": "arXiv", "psyarxiv": "PsyArXiv", "socarxiv": "SocArXiv",
          "biorxiv": "bioRxiv", "medrxiv": "medRxiv", "openalex": "DOI", "local": "导入 PDF"}
_BIO_RE = re.compile(r"^(biorxiv|medrxiv):(10\.\d{4,5})\.(.+)$", re.I)


_BIO_INPUT = re.compile(r"^(?:(?:https?://)?(?:www\.)?(?:biorxiv|medrxiv)\.org/|(?:doi:)?10\.(?:1101|64898)/)", re.I)


def kind(raw: str) -> str:
    """local / biorxiv / osf / arxiv。认不出的一律当 arxiv，让 arxiv.clean_id 去报 400。
    粘贴进来的 bioRxiv DOI / 网址也算 biorxiv（clean 会归一成不带斜杠的 ref）；别的 DOI 不认。"""
    s = (raw or "").strip()
    if arxiv.is_local(s):
        return "local"
    if biorxiv.is_id(s) or _BIO_INPUT.match(s):
        return "biorxiv"
    if osf.is_id(s):
        return "osf"
    if openalex.is_id(s) or openalex._W_RE.match(s):
        return "openalex"
    return "arxiv"


def is_local(raw: str) -> bool:
    return arxiv.is_local((raw or "").strip())


def clean(raw: str) -> str:
    k = kind(raw)
    if k == "local":
        return (raw or "").strip()
    if k == "biorxiv":
        return biorxiv.clean_id(raw)
    if k == "osf":
        return osf.clean_id(raw)
    if k == "openalex":
        return openalex.clean_id(raw)
    return arxiv.clean_id(raw)


def label(ref: str) -> str:
    prefix = ref.split(":", 1)[0].lower() if ":" in (ref or "") else "arxiv"
    return LABELS.get(prefix, prefix)


def landing_url(ref: str, url: str = "") -> str:
    """原文页。记录里带 url 就用它；没有就按来源拼。"""
    if url:
        return url
    k = kind(ref)
    if k == "arxiv":
        return f"https://arxiv.org/abs/{ref}"
    if k == "osf":
        return f"https://osf.io/{ref.split(':', 1)[1]}/"
    if k == "openalex":
        return f"https://openalex.org/{ref.split(':', 1)[1]}"
    m = _BIO_RE.match(ref or "")
    if m:
        return f"https://www.{m.group(1).lower()}.org/content/{m.group(2)}/{m.group(3)}"
    return ""


def has_fulltext(row: dict[str, Any] | None) -> bool:
    return bool(row) and row.get("source") in ("html", "pdf") and bool(row.get("text"))


def _shape(row: dict[str, Any], ref: str) -> dict[str, Any]:
    return {"id": ref, "title": row.get("title") or ref, "source": row.get("source") or "abstract",
            "text": row.get("text") or "", "url": row.get("url") or "", "tables": row.get("tables") or [],
            "retry_after": row.get("retry_after") or 0}


def cached(ref: str) -> dict[str, Any] | None:
    """不打上游：arXiv 走它自己的三级缓存，其它来源看 paper_text 里有没有正文。"""
    k = kind(ref)
    if k == "arxiv":
        return arxiv.cached(ref)
    if k == "local":
        return None
    row = store.get_paper_text(ref)
    if has_fulltext(row) and not row.get("needs_reparse"):
        return _shape(row, ref)
    return None


def fulltext(ref: str, hint: dict[str, Any] | None = None) -> dict[str, Any]:
    """取正文（可能打上游）。bioRxiv 自己落库；OSF 不落库，这里补上，下次 cached 直接命中。"""
    k = kind(ref)
    if k == "arxiv":
        return arxiv.fulltext(ref, hint=hint) if hint else arxiv.fulltext(ref)
    if k == "biorxiv":
        return biorxiv.fulltext(ref)
    if k in ("osf", "openalex"):
        got = osf.fulltext(ref) if k == "osf" else openalex.fulltext(ref)
        if has_fulltext(got):
            try:
                store.put_paper_text(clean(ref), got)
            except Exception:
                pass
        return got
    raise arxiv.ArxivError("导入的 PDF 只在本人账号里，不走公共正文", 400)


# ---- 可达性探针：从这台机器（函数计算实例）出去，各来源一次最小请求 ----
PROBES = {
    "arxiv": "https://export.arxiv.org/api/query?search_query=all:electron&max_results=1",
    "osf": "https://api.osf.io/v2/preprints/?page%5Bsize%5D=1",
    "biorxiv": "https://api.biorxiv.org/details/biorxiv/2024-01-01/2024-01-02/0",
    "openalex": "https://api.openalex.org/works?per-page=1",
    "europepmc": "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=cell&format=json&pageSize=1",
    "nber": "https://www.nber.org/api/v1/working_page_listing/contentType/working_paper/_/_/search?page=1&perPage=1&q=inflation",
    "crossref": "https://api.crossref.org/works?rows=1",
}
PROBE_UA = "qiyan/0.2 (+https://chengcanwu.github.io/AutoResearch/; sources-probe)"


def probe_one(name: str, url: str, timeout: float = 8.0) -> dict[str, Any]:
    t0 = time.time()
    req = urllib.request.Request(url, headers={"User-Agent": PROBE_UA, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read(65536)
            status = int(resp.status)
    except urllib.error.HTTPError as exc:
        status = int(exc.code)
    except Exception as exc:  # 连不上、超时、证书
        return {"status": 0, "ms": int((time.time() - t0) * 1000), "ok": False, "error": type(exc).__name__}
    return {"status": status, "ms": int((time.time() - t0) * 1000), "ok": 200 <= status < 400, "error": ""}


def probe(names: list[str] | None = None, timeout: float = 8.0) -> dict[str, dict[str, Any]]:
    """并行打一遍，总耗时约等于最慢的一个。返回 {来源: {status, ms, ok, error}}。"""
    picked = [n for n in (names or list(PROBES)) if n in PROBES]
    out: dict[str, dict[str, Any]] = {}
    lock = threading.Lock()

    def run(n: str) -> None:
        got = probe_one(n, PROBES[n], timeout)
        with lock:
            out[n] = got

    threads = [threading.Thread(target=run, args=(n,), daemon=True) for n in picked]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout + 2)
    for n in picked:
        out.setdefault(n, {"status": 0, "ms": int(timeout * 1000), "ok": False, "error": "Timeout"})
    return out
