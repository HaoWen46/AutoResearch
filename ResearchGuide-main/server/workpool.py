# -*- coding: utf-8 -*-
"""要等模型的活在自己的线程池里跑，排队有上限。

公用的工作线程池（Starlette 的，main.THREADS 个）给普通读写。原来对话、交任务、方向推荐这些同步接口
也在里面等模型：两百个人同时等模型，128 个线程全占住，连 /api/health、/api/auth/me 都排队五秒（Codex 第五轮压测复现）。
挪到这里以后公用池永远有空；这里满了，新来的在队里等，队也满了就 Overloaded（接口回 503）。

- submit 带上调用方的上下文变量：模型额度算在谁头上（budget.py）靠它。
- 还没开始的活可以 cancel：浏览器走了、排队的那一轮就不跑了（main.dialogue_stream）。
"""
from __future__ import annotations

import contextvars
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable

from singleflight import Overloaded


class BoundedPool:
    def __init__(self, workers: int, max_queued: int, name: str) -> None:
        self.workers, self.max_queued = workers, max_queued
        self._ex = ThreadPoolExecutor(max_workers=workers, thread_name_prefix=name)
        self._mu = threading.Lock()
        self.queued = 0   # 排上了、还没开始
        self.running = 0

    def submit(self, fn: Callable[..., Any], *args: Any) -> Future:
        """排上队返回 Future；排队的已经有 max_queued 个就抛 Overloaded，什么都不做。"""
        ctx = contextvars.copy_context()
        with self._mu:
            if self.queued >= self.max_queued:
                raise Overloaded()
            self.queued += 1

        def run() -> Any:
            with self._mu:
                self.queued -= 1
                self.running += 1
            try:
                return ctx.run(fn, *args)
            finally:
                with self._mu:
                    self.running -= 1

        fut = self._ex.submit(run)
        fut.add_done_callback(self._on_cancel)  # 开始前被取消的不会进 run，名额在这里还
        return fut

    def _on_cancel(self, fut: Future) -> None:
        if fut.cancelled():
            with self._mu:
                self.queued -= 1

    def stats(self) -> dict[str, int]:
        with self._mu:
            return {"workers": self.workers, "running": self.running, "queued": self.queued, "max_queued": self.max_queued}
