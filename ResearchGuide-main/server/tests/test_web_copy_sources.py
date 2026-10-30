# -*- coding: utf-8 -*-
"""论文页按来源给标签和原文链接：不再把 OSF 的 PDF 叫「你导入的 PDF」，不再一律写 arXiv。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_card_page_labels_follow_source():
    app = (ROOT / "web" / "js" / "app.js").read_text(encoding="utf-8")
    for s in ("function sourceLabel(aid)", "function paperHome(aid, url)", "正文来自 PDF，引文可逐字核对",
              "你导入的 PDF · 只有你能看到", "${esc(sourceLabel(aid))} 原文 ↗", "在 ${sourceLabel(it.arxiv_id)} 读",
              '(p.lib === "html" || p.lib === "pdf") ? "有全文"', '(it.lib === "html" || it.lib === "pdf") ? "有全文"'):
        assert s in app, s
    for s in ("正在取原文（arXiv HTML 版", "在 arXiv 读\"", "稍后重试：https://arxiv.org/abs/${aid}"):
        assert s not in app, s
    html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    assert html.count("w115") == 5 and "w114" not in html
