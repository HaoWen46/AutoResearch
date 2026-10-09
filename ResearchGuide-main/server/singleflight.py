# -*- coding: utf-8 -*-
"""同一个 key 同时只做一次：并发的相同请求等第一个做完，共用它的结果（或异常）。

缓存只管「做完之后」；这里管「正在做的时候」——没有它，八个同时到的相同检索会各自打一次上游。
"""
from __future__ import annotations

import asyncio
import functools
import threading
from concurrent.futures import Executor
from typing import Any, Callable, Hashable


class _Call:
    __slots__ = ("done", "value", "error")

    def __init__(self) -> None:
        self.done = threading.Event()
        self.value: Any = None
        self.error: BaseException | None = None


class SingleFlight:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._calls: dict[Hashable, _Call] = {}

    def do(self, key: Hashable, fn: Callable[[], Any]) -> Any:
        with self._lock:
            call = self._calls.get(key)
            leader = call is None
            if leader:
                call = self._calls[key] = _Call()
        if not leader:
            call.done.wait()
            if call.error is not None:
                raise call.error
            return call.value
        try:
            call.value = fn()
        except BaseException as exc:
            call.error = exc
            raise
        finally:
            with self._lock:
                self._calls.pop(key, None)
            call.done.set()
        return call.value

    def in_flight(self) -> int:
        with self._lock:
            return len(self._calls)


class Overloaded(Exception):
    """同时在做或在排队的活已经到上限，不再接新的。"""


class AsyncFlight:
    """事件循环里的版本：相同 key 的并发请求 await 同一个任务，阻塞的活只在线程里跑一次。
    线程版的跟随者会各占一个线程干等，四十个相同请求就能占满服务器的四十个工作线程。"""

    def __init__(self, executor: Executor | None = None, max_pending: int | None = None) -> None:
        """executor：这类活专用的线程池。不传就用事件循环默认的那个（所有地方共用，线程不多）。
        max_pending：同时在做或在排队的不同 key 最多几个，超了抛 Overloaded（不传不限）。"""
        self._tasks: dict[Hashable, asyncio.Future] = {}
        self._waiters: dict[asyncio.Future, int] = {}
        self._executor = executor
        self.max_pending = max_pending

    async def do(self, key: Hashable, fn: Callable[..., Any], *args: Any) -> Any:
        task = self._tasks.get(key)
        if task is None:
            if self.max_pending is not None and len(self._tasks) >= self.max_pending:
                raise Overloaded(key)
            loop = asyncio.get_running_loop()
            task = asyncio.ensure_future(loop.run_in_executor(self._executor, functools.partial(fn, *args)))
            self._tasks[key] = task

            def forget(done: asyncio.Future, k: Hashable = key) -> None:
                if self._tasks.get(k) is done:
                    del self._tasks[k]
                self._waiters.pop(done, None)
                if not done.cancelled():
                    done.exception()  # 标记已取走，等的人都走了也不报「异常没人取」

            task.add_done_callback(forget)
        self._waiters[task] = self._waiters.get(task, 0) + 1
        try:
            return await asyncio.shield(task)  # 一个请求断开，不连累其他在等的请求
        finally:
            left = self._waiters.get(task, 1) - 1
            if left > 0:
                self._waiters[task] = left
            else:
                self._waiters.pop(task, None)
                if not task.done():
                    task.cancel()  # 等的人都走了：还在排队的不做了（已经在跑的停不下，跑完结果丢掉）

    def in_flight(self) -> int:
        return len(self._tasks)
