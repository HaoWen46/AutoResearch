# -*- coding: utf-8 -*-
"""同一个人的并发改动（Codex 复现过的三种）：
- 对话在等模型时切画像：回复写进了新画像；
- 两次并发的项目评阅：只留下后一份；
- 两张并发提交的阅读卡：都是 v1。
走真的接口（conftest 把登录换成「信请求里的 uid」），用屏障和事件把竞态窗口卡住，保证每次都复现。
"""
from __future__ import annotations

import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import dialogue  # noqa: E402
import main  # noqa: E402
import reading  # noqa: E402
import store  # noqa: E402
import submission  # noqa: E402
import userlock  # noqa: E402


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "races.db")
    store.init_db()
    monkeypatch.setattr(userlock, "WAIT", 0.5)  # 测试里别真等十五秒


def test_switching_portrait_during_a_model_call_waits_for_the_turn(monkeypatch):
    uid = store.create_user("切画像")["uid"]
    old_pid = store.list_portraits(uid)[0]["id"]
    entered, release = threading.Event(), threading.Event()
    monkeypatch.setattr(dialogue, "build_env", lambda *a: {"active_plan": {"direction": "ai"}, "trace": {}})
    monkeypatch.setattr(dialogue.llm, "enabled", lambda: True)

    def slow_propose(env):
        entered.set()
        assert release.wait(5)
        return {"memory_ops": [], "understanding": {"gist": "旧画像里的一句"}, "next_action": None, "tool_intent": None,
                "dialogue": {"move": "answer", "reason": "t", "reply": "只该出现在旧画像里", "offered_actions": []}}

    monkeypatch.setattr(dialogue, "_propose", slow_propose)
    with ThreadPoolExecutor(max_workers=1) as pool:
        turn = pool.submit(TestClient(main.app).post, "/api/dialogue/turn", json={"uid": uid, "message": "我在旧画像里说话"})
        assert entered.wait(5)
        # 对话还在等模型：切画像要等它，等不到就 409，不会把现场换掉
        r = TestClient(main.app).post("/api/portraits", json={"uid": uid})
        assert r.status_code == 409
        release.set()
        assert turn.result(10).status_code == 200
    msgs = store.list_messages(uid)
    assert [m["role"] for m in msgs] == ["user", "assistant"]  # 一问一答都在旧画像（仍是现场）
    assert store.list_portraits(uid)[0]["id"] == old_pid and len(store.list_portraits(uid)) == 1
    # 对话做完之后再切，就正常
    assert TestClient(main.app).post("/api/portraits", json={"uid": uid}).status_code == 200
    assert not any("只该出现在旧画像里" in m["text"] for m in store.list_messages(uid))  # 新画像只有它自己的开场白


def test_streaming_turn_refuses_a_second_concurrent_turn(monkeypatch):
    uid = store.create_user("连发")["uid"]
    with userlock.hold(uid):  # 模拟上一句还在处理
        r = TestClient(main.app).post("/api/dialogue/stream", json={"uid": uid, "message": "再发一句"})
    assert r.status_code == 200 and "event: error" in r.text and "还在处理" in r.text


def test_two_concurrent_project_reviews_are_both_recorded(monkeypatch):
    uid = store.create_user("评阅")["uid"]
    store.save_project(uid, "p1", {"name": "项目", "reviews": []})
    stale = store.get_project(uid, "p1")  # 两个请求开始时都拿到这份（还没有评阅）
    both_reviewed = threading.Barrier(2)

    def fake_review(data, p):
        both_reviewed.wait(5)  # 两次评阅都做完了才去记
        return {"passed": int(data), "total": 5, "inventory": [], "tag": data.decode()}

    monkeypatch.setattr(submission, "review", fake_review)
    with ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(main._review_and_record, uid, stale, b"5")
        b = pool.submit(main._review_and_record, uid, stale, b"2")
        assert a.result(10)["recorded"] and b.result(10)["recorded"]
    reviews = store.get_project(uid, "p1")["reviews"]
    assert sorted(r["tag"] for r in reviews) == ["2", "5"]  # 原来只剩后记的那一份


def test_review_finished_after_a_portrait_switch_is_not_written_into_the_new_portrait(monkeypatch):
    uid = store.create_user("评阅切画像")["uid"]
    store.save_project(uid, "p1", {"name": "旧画像的项目", "reviews": []})
    p = store.get_project(uid, "p1")
    store.open_new_portrait(uid)  # 评阅在跑的时候切了画像
    monkeypatch.setattr(submission, "review", lambda data, p: {"passed": 5, "total": 5, "inventory": []})
    out = main._review_and_record(uid, p, b"zip")
    assert out["recorded"] is False and "切换了画像" in out["note"]
    assert store.list_projects(uid) == []  # 新画像里没有冒出旧画像的项目
    assert store.list_facts(uid) == []


def test_two_concurrent_card_submissions_get_successive_versions(monkeypatch):
    uid = store.create_user("交卡")["uid"]
    both_read = threading.Barrier(2, timeout=0.2)  # 比锁的等待（0.5 秒）短

    def racy_submit(uid, kit, aid, fields, dims, log=None):
        """和真 submit_card 一样：先读最新版本号再写 +1。两个请求都读完再写，就会撞号。"""
        prev = store.latest_card(uid, kit, aid)
        try:
            both_read.wait()  # 没有锁时两个都会读到「没有上一版」
        except threading.BrokenBarrierError:
            pass  # 有锁时第二个进不来，屏障超时就各走各的
        version = (prev["version"] + 1) if prev else 1
        store.save_card({"id": f"c{version}-{time.time_ns()}", "uid": uid, "kit_id": kit, "arxiv_id": aid,
                         "title": "t", "version": version, "status": "pass", "fields": fields, "dims": dims,
                         "review": {}, "created_at": "2026-10-10T00:00:00+00:00"})
        return {"version": version}

    monkeypatch.setattr(reading, "submit_card", racy_submit)
    monkeypatch.setattr(main, "_shared", lambda *a, **k: _done())
    monkeypatch.setattr(reading.arxiv, "cached", lambda aid: {"title": "t"})
    body = {"uid": uid, "kit": "llm-eval", "arxiv_id": "2401.00001", "fields": {"q": "a"}, "dims": {}}
    with ThreadPoolExecutor(max_workers=2) as pool:
        rs = [pool.submit(TestClient(main.app).post, "/api/cards", json=body) for _ in range(2)]
        versions = sorted(r.result(10).json()["version"] for r in rs)
    assert versions == [1, 2]


async def _done():
    return None
