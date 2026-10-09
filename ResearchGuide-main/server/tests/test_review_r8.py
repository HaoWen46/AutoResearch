# -*- coding: utf-8 -*-
"""Codex 第八轮（整个分支对 main）复现的问题。"""
from __future__ import annotations

import asyncio
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from singleflight import AsyncFlight  # noqa: E402


def test_a_running_shared_job_is_not_started_again_after_its_waiter_leaves():
    """等同一篇论文的人走光了，但抓取已经开始：后来的人接着等这一次，不再占一个新线程重跑。
    原来 key 照样删掉，重试一次就多占一个线程，四个线程能被同一篇论文占满（Codex 复现）。"""
    pool = ThreadPoolExecutor(max_workers=2)
    flight = AsyncFlight(pool, max_pending=8)
    started, release, calls = threading.Event(), threading.Event(), []

    def fetch():
        calls.append(1)
        started.set()
        assert release.wait(5)
        return "paper"

    async def go():
        first = asyncio.create_task(flight.do(("paper", "2401.00001"), fetch))
        while not started.is_set():
            await asyncio.sleep(0.01)
        first.cancel()  # 第一个人断开：活已经在跑
        await asyncio.gather(first, return_exceptions=True)
        assert flight.in_flight() == 1  # 还记着
        second = asyncio.create_task(flight.do(("paper", "2401.00001"), fetch))
        await asyncio.sleep(0.05)
        release.set()
        return await second

    try:
        assert asyncio.run(go()) == "paper"
        assert calls == [1]
        assert flight.in_flight() == 0
    finally:
        release.set()
        pool.shutdown(wait=True)


def test_a_queued_shared_job_is_still_dropped_when_nobody_waits():
    """还在排队（线程都忙）时等的人走光：照旧撤掉，不白跑。"""
    pool = ThreadPoolExecutor(max_workers=1)
    flight = AsyncFlight(pool, max_pending=8)
    hold, ran = threading.Event(), []
    blocker = pool.submit(hold.wait, 5)

    async def go():
        t = asyncio.create_task(flight.do(("paper", "x"), lambda: ran.append(1)))
        await asyncio.sleep(0.05)
        t.cancel()
        await asyncio.gather(t, return_exceptions=True)
        await asyncio.sleep(0.05)
        return flight.in_flight()

    try:
        assert asyncio.run(go()) == 0
    finally:
        hold.set()
        blocker.result(5)
        pool.shutdown(wait=True)
    assert ran == []
