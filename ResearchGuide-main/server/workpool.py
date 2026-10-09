# -*- coding: utf-8 -*-
"""要等模型的活在自己的线程池里跑，排队有上限。

公用的工作线程池（Starlette 的，main.THREADS 个）给普通读写。原来对话、交任务、方向推荐这些同步接口
也在里面等模型：两百个人同时等模型，128 个线程全占住，连 /api/health、/api/auth/me 都排队五秒（Codex 第五轮压测复现）。
挪到这里以后公用池永远有空；这里满了，新来的在队里等，队也满了就 Overloaded（接口回 503）。

- submit 带上调用方的上下文变量：模型额度算在谁头上（budget.py）靠它。
- 还没开始的活可以 cancel：浏览器走了、排队的那一轮就不跑了（main.dialogue_stream）。取消的活当场从队里拿掉，
  连同它带着的请求内容一起放掉。不用 ThreadPoolExecutor：它取消了的活还留在内部队列里，要等线程空出来才扔，
  线程都在等模型时，一个人反复发起又断开就能在里面堆上任意多份（Codex 复现：上限 1，堆了 64 份）。
"""
from __future__ import annotations

import contextvars
import itertools
import threading
from collections import OrderedDict
from concurrent.futures import Future
from typing import Any, Callable

from singleflight import Overloaded


class BoundedPool:
    def __init__(self, workers: int, max_queued: int, name: str) -> None:
        self.workers, self.max_queued, self._name = workers, max_queued, name
        self._cv = threading.Condition()
        self._queue: OrderedDict[int, tuple] = OrderedDict()  # 排上了、还没开始的：序号 → (future, 上下文, 函数, 参数)
        self._seq = itertools.count()
        self._threads = 0
        self._idle = 0      # 在等活的线程
        self.running = 0

    def submit(self, fn: Callable[..., Any], *args: Any) -> Future:
        """排上队返回 Future；排队的已经有 max_queued 个就抛 Overloaded，什么都不做。"""
        fut: Future = Future()
        ctx = contextvars.copy_context()
        with self._cv:
            if len(self._queue) >= self.max_queued:
                raise Overloaded()
            key = next(self._seq)
            self._queue[key] = (fut, ctx, fn, args)
            if len(self._queue) > self._idle and self._threads < self.workers:  # 闲着的不够分：再开一个线程
                self._threads += 1
                threading.Thread(target=self._work, name=f"{self._name}-{self._threads}", daemon=True).start()
            self._cv.notify()
        fut.add_done_callback(lambda f: f.cancelled() and self._drop(key))
        return fut

    def _drop(self, key: int) -> None:
        with self._cv:
            self._queue.pop(key, None)

    def _work(self) -> None:
        while True:
            with self._cv:
                while not self._queue:
                    self._idle += 1
                    self._cv.wait()
                    self._idle -= 1
                _, (fut, ctx, fn, args) = self._queue.popitem(last=False)
            if not fut.set_running_or_notify_cancel():  # 刚被取消
                continue
            with self._cv:
                self.running += 1
            try:
                fut.set_result(ctx.run(fn, *args))
            except BaseException as exc:  # noqa: BLE001 — 原样交给等结果的人
                fut.set_exception(exc)
            finally:
                with self._cv:
                    self.running -= 1
                del fut, ctx, fn, args  # 等下一件活的时候别还拿着这一件的请求内容

    def stats(self) -> dict[str, int]:
        with self._cv:
            return {"workers": self.workers, "threads": self._threads, "running": self.running,
                    "queued": len(self._queue), "max_queued": self.max_queued}
