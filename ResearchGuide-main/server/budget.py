# -*- coding: utf-8 -*-
"""模型调用的预算：每调一次记一笔，按人、按全站每天有上限；超了就当模型没开，功能回退到规则版。

模型钱是团队的（DeepSeek 密钥在服务器上）。原来任何人开个访客号就能无限次触发模型调用：
六十次交任务、几次对话就是七十次真实调用，没人同意过隐私说明也照样调。现在：
- 谁在调：auth.guard 在每个请求开头 bind(uid)；公开接口 bind 成匿名，匿名一律不许调。
- 上限（每天，北京时间）：全站 LLM_DAILY_TOTAL、绑了微信的人 LLM_DAILY_USER、访客 LLM_DAILY_GUEST。
- 没同意当前版本隐私说明的人不调：对话和成绩单会发给模型服务，这一条必须先同意。
- 不在 HTTP 请求里（脚本、测试直接调函数）不计不限：上下文变量是 None。
llm.enabled() 先问这里有没有额度（各功能本来就会在模型不可用时回退规则），llm.chat 真正调用前再扣一笔。
"""
from __future__ import annotations

import contextvars
import os
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Iterator

import store

ANON = ""  # 公开接口：不许调模型
_WHO: contextvars.ContextVar[str | None] = contextvars.ContextVar("llm_user", default=None)
CN = timezone(timedelta(hours=8))


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name) or default)
    except ValueError:
        return default


def total_cap() -> int:
    return _int("LLM_DAILY_TOTAL", 2000)


def user_cap() -> int:
    return _int("LLM_DAILY_USER", 150)


def guest_cap() -> int:
    return _int("LLM_DAILY_GUEST", 15)


def bind(uid: str | None) -> None:
    """这个请求是谁的。None 只用于请求之外；请求里没有登录就传 ANON。"""
    _WHO.set(uid if uid is not None else ANON)


@contextmanager
def unmetered() -> Iterator[None]:
    """管理员测连通这类不该算在任何人头上的调用。"""
    token = _WHO.set(None)
    try:
        yield
    finally:
        _WHO.reset(token)


def _today() -> str:
    return datetime.now(CN).strftime("%Y-%m-%d")


def cap_for(uid: str) -> int:
    """这个人今天最多调几次。没同意隐私说明、账号不存在都是 0。"""
    import auth  # auth 也 import 本模块，放到函数里避免循环
    u = store.get_user(uid)
    if not u or u.get("consent_version") != auth.PRIVACY_VERSION:
        return 0
    return user_cap() if u.get("wechat_openid") else guest_cap()


def left(uid: str) -> int:
    day = _today()
    return max(0, min(cap_for(uid) - store.llm_calls(day, uid), total_cap() - store.llm_calls(day, "*")))


def allowed() -> bool:
    """只查不扣：这个请求现在还能不能调模型。"""
    who = _WHO.get()
    if who is None:
        return True
    return bool(who) and left(who) > 0


def charge() -> bool:
    """真正调用之前扣一笔；没额度返回 False，调用方当作模型不可用。"""
    who = _WHO.get()
    if who is None:
        return True
    if not who:
        return False
    return store.llm_charge(_today(), who, cap_for(who), total_cap())
