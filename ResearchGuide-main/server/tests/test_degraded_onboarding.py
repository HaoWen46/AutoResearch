# -*- coding: utf-8 -*-
"""模型不可用（额度用完、没配密钥）时，新同学在对话里也能把五问走完，不会卡在同一句。Codex 第四轮复现过卡住。"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import dialogue  # noqa: E402
import onboarding  # noqa: E402
import store  # noqa: E402


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "deg.db")
    store.init_db()
    monkeypatch.setattr(dialogue.llm, "enabled", lambda: False)
    monkeypatch.setattr(onboarding.llm, "enabled", lambda: False)


def test_a_new_student_gets_through_the_five_questions_without_the_model():
    uid = store.create_user("新同学")["uid"]
    onboarding.start(uid)
    replies, offers = [], []
    answers = ["大一 · 理科 / 工科", "两者都接触过", "我想知道大模型为什么会胡说", "随便", "我喜欢先动手"]
    for msg in answers:
        r = dialogue.turn(uid, msg)
        replies.append(r["reply"])
        offers.append([a["label"] for a in r.get("offered_actions") or []])
    assert store.get_onboard_state(uid)["phase"] == "done"
    assert len(set(replies)) == len(replies)  # 每一轮都往前走了，不是同一句
    assert offers[0]  # 前几轮给了可点的选项
    assert "方向" in replies[-1] and "核对" in replies[-1]
    assert store.list_facts(uid)  # 回答记成了待核对的条目
    # 问完之后再说话：指到方向页，不重新开始五问
    after = dialogue.turn(uid, "然后呢")
    assert "方向" in after["reply"] and store.get_onboard_state(uid)["phase"] == "done"
