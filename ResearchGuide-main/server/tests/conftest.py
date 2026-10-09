# -*- coding: utf-8 -*-
"""功能测试不管登录：把 auth.guard 换成「请求里带的 uid 就是登录的人」，测的是登录之后的行为。
登录本身（会话、验证码、uid 核对、默认要登录）在 test_auth.py 里用真的 guard 测。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


async def _trust_uid(request: Request) -> None:
    uid = request.query_params.get("uid") or request.path_params.get("uid")
    if not uid:
        try:
            raw = await request.body()
            body = json.loads(raw) if raw else None
        except (RuntimeError, ValueError, UnicodeDecodeError):
            body = None
        if isinstance(body, dict):
            uid = body.get("uid")
    if uid:
        request.state.uid = uid


@pytest.fixture(autouse=True)
def _logged_in_as_request_uid(request):
    if request.node.get_closest_marker("real_auth"):
        yield
        return
    import auth
    import main
    main.app.dependency_overrides[auth.guard] = _trust_uid
    yield
    main.app.dependency_overrides.pop(auth.guard, None)


def pytest_configure(config):
    config.addinivalue_line("markers", "real_auth: 用真的登录校验，不替换 auth.guard")
