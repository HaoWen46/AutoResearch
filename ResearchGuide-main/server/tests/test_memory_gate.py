# -*- coding: utf-8 -*-
"""记忆写入闸门按字段核对：年级 {stage, year}、数量 {value, unit, per}、学校院系专业查别名表、兴趣目标要原话片段，都不能在否定/过去/改口里。不调真的模型。"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import dialogue  # noqa: E402
import memory  # noqa: E402
import store  # noqa: E402


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "gate.db")
    store.init_db()


def _check(key, value, quote):
    op = {"op": "add", "key": key, "value": value, "evidence_quote": quote, "affects": "task_difficulty"}
    if key.startswith("constraint:"):
        op["valid_until"] = "2030-01-01"
    return memory.validate_ops(store.create_user("t")["uid"], [op], [quote])


@pytest.mark.parametrize("key,value,quote", [
    ("interest:ml", "机器学习", "我不想碰机器学习"),                       # 「不想碰」原来不在否定词表里（Codex 复现）
    ("school", "清华大学", "我在北京大学读书"),                            # 「大学」两个字对上就算撑住（Codex 复现）
    ("grade", "研二", "I am second-year, not a graduate student"),         # 没说阶段的 second-year 撑住了任何阶段（Codex 复现）
    ("base:code", "会", "我没学过Python"),                                 # 全是虚词的值原来算撑得住（Codex 复现）
    ("base:code", "会Python", "我没学过Python"),
    ("interest:ml", "机器学习", "我对机器学习一点兴趣都没有"),
    ("interest:cv", "CV", "我喜欢NLP，不喜欢CV"),
    ("interest:ml", "机器学习", "机器学习我不太感兴趣"),
    ("interest:ml", "机器学习", "我对深度学习感兴趣"),                     # 「学习」两个字对上不算
    ("interest:nlp", "NLP", "以前喜欢NLP，现在更想做CV"),
    ("goal:phd", "读博", "我不打算读博"),
    ("goal:abroad", "出国", "我没想过出国"),
    ("goal:work", "就业", "我不想工作，想读研"),
    ("grade", "研究生", "我想读研"),                                      # 打算的不是现在的年级
    ("grade", "博士", "我在读博士后"),
    ("grade", "大二", "我以前是大二，现在研一"),
    ("grade", "大一", "大一的时候学过C"),
    ("grade", "大三", "大三，哦打错了，我大二"),
    ("grade", "大二", "我最多同时做大2个项目"),
    ("school", "北京大学", "我在东北大学读书"),                            # 「北大」藏在「东北大学」里
    ("school", "北京大学", "我不是北大的"),
    ("school", "清华大学", "我想考清华的研究生"),
    ("school", "上海交通大学", "我在西安交大"),
    ("department", "信息科学技术学院", "我想转到信科"),
    ("department", "信息管理系", "我不是信管的，是数院的"),
    ("department", "数学科学学院", "我喜欢数学"),                          # 学科词不是院系
    ("department", "信息科学技术学院", "以前在信科，后来转到了信管"),
    ("major", "计算机科学与技术", "我是学经济学的"),
    ("base:math", "数学很好", "数学不太好"),
    ("current:course", "在修线性代数", "我没修过线性代数"),
    ("role:club", "参加了机器学习社团", "我没参加社团"),
    ("capability:python", "熟练使用Python", "我不会Python"),
    ("enroll_year", "2023", "我2024年入学"),                              # 原来按比例容差，2023 和 2024 差不到千分之一
])
def test_contradicted_or_unsupported_values_are_rejected(key, value, quote):
    acc, rej = _check(key, value, quote)
    assert acc == [], acc


@pytest.mark.parametrize("key,value,quote", [
    ("age", {"value": 19, "unit": "岁"}, "我有19门课"),
    ("age", {"value": 20, "unit": "岁"}, "我去年20岁"),
    ("age", {"value": 19, "unit": "岁"}, "我不是19岁，是20岁"),
    ("pace", {"value": 20, "unit": "小时", "per": "周"}, "我每周2小时，总共20周"),
    ("pace", {"value": 2, "unit": "小时", "per": "周"}, "每天2小时"),
    ("pace", {"value": 10, "unit": "小时", "per": "周"}, "以前每周10小时，现在每周只有2小时"),
    ("pace", {"value": 10, "unit": "小时", "per": "周"}, "我每周没有10小时那么多"),
    ("pace", {"value": 10, "unit": "小时", "per": "周"}, "每周10分钟"),
    ("pace", {"value": 5, "unit": "小时", "per": "周"}, "每周5小时，哦不对，每周3小时"),
    ("enroll_year", {"value": 2023, "unit": "年"}, "我2024年入学"),
    ("grade", {"stage": "硕士", "year": 2}, "I am second-year, not a graduate student"),
    ("grade", {"stage": "硕士", "year": 1}, "我是一年级本科生"),
    ("grade", {"stage": "本科", "year": 4}, "本科四年里想做一次科研"),
])
def test_structured_values_are_checked_field_by_field(key, value, quote):
    acc, rej = _check(key, value, quote)
    assert acc == [] and rej[0]["reason"] in ("number_not_in_evidence", "negated_in_evidence", "grade_not_in_evidence"), rej


@pytest.mark.parametrize("key,value,quote,shown", [
    ("grade", {"stage": "本科", "year": 2}, "我是二年级本科生", "大二"),
    ("grade", {"stage": "硕士", "year": 1}, "first-year master's student", "研一"),
    ("grade", {"stage": "本科", "year": 1}, "一年级，还在适应", "大一"),     # 没说阶段按本科
    ("grade", {"stage": "博士", "year": None}, "我是博士生", "博士"),
    ("age", {"value": 19, "unit": "岁"}, "我今年十九岁", "19岁"),           # 中文写的年龄原来认不出（Codex 复现）
    ("age", {"value": 20, "unit": "岁"}, "我20周岁", "20岁"),              # 「周岁」原来被当成「周」
    ("age", {"value": 20, "unit": "岁"}, "今年二十", "20岁"),
    ("age", {"value": 20, "unit": "岁"}, "虚岁二十", "20岁"),
    ("enroll_year", {"value": 2024, "unit": "级"}, "24级的", "2024"),
    ("enroll_year", {"value": 2025, "unit": "年"}, "二〇二五年入学", "2025"),
    ("enroll_year", {"value": 2024, "unit": "年"}, "我是2024入学的", "2024"),
    ("pace", {"value": 80, "unit": "分钟", "per": "天"}, "每天一小时二十分钟", "每天80分钟"),  # 复合时长原来拆成两个数（Codex 复现）
    ("pace", {"value": 100, "unit": "分钟", "per": "天"}, "每天1h40min", "每天100分钟"),
    ("pace", {"value": 1.5, "unit": "小时", "per": "天"}, "每天一个半小时", "每天1.5小时"),
    ("pace", {"value": [2, 3], "unit": "小时", "per": "周"}, "每周两三个小时", "每周2到3小时"),
    ("pace", {"value": 6, "unit": "hours", "per": "week"}, "a week maybe 6 hours", "每周6小时"),
    ("pace", {"value": 2, "unit": "小时", "per": "天"}, "每天两个钟头", "每天2小时"),
])
def test_structured_values_that_match_are_kept_in_a_canonical_form(key, value, quote, shown):
    acc, rej = _check(key, value, quote)
    assert rej == [] and acc[0]["value"] == shown and acc[0]["source"] == "declared", rej


@pytest.mark.parametrize("key,value,quote", [
    ("grade", "大二", "I'm a second-year student"),
    ("grade", "大三", "我是大三的，上次说大二是打错了"),
    ("grade", "大二", "我是大二学生，不是研究生"),
    ("school", "人大", "我是人大的学生"),
    ("school", "北京大学", "我是北大学生"),
    ("department", "信息管理系", "我是信管的"),
    ("department", "数学科学学院", "数学系的"),
    ("major", "古典文献学", "古典文献学专业大一"),
    ("interest:ml", "机器学习", "数学我不太行，但是对机器学习感兴趣"),
    ("interest:ml", "机器学习", "想做不需要太多数学的机器学习"),       # 否定管不到「的」后面的词
    ("interest:ml", "机器学习", "我不仅喜欢机器学习，还喜欢数学"),
    ("interest:cv", "CV", "除了NLP，我对CV也有兴趣"),
    ("interest:llm", "大模型", "对LLM很感兴趣"),
    ("interest:ml", "对机器学习感兴趣", "我对机器学习有兴趣"),         # 「对…感兴趣」是包装，按里面的词找
    ("goal:phd", "PhD", "I want to do a PhD"),
    ("base:code", "没学过编程", "我没学过编程"),                       # 值自己带着否定，和原话一致
    ("constraint:time", "这学期每周最多2小时", "这学期每周不能超过两小时"),
    ("project:app.traction", "日活200", "日活两百左右"),               # 没单位的「两百」也是数
])
def test_things_students_actually_say_are_kept(key, value, quote):
    acc, rej = _check(key, value, quote)
    assert len(acc) == 1, rej


def test_a_paraphrased_interest_needs_an_anchor_and_is_only_inferred():
    acc, _ = _check("interest:gnn", "图神经网络的研究", "我对图神经网络有兴趣")
    assert acc[0]["source"] == "inferred" and "partially_inferred" in acc[0]["notes"]
    acc, rej = _check("interest:x", "强化学习的应用", "我对深度学习感兴趣")
    assert acc == [] and rej[0]["reason"] == "short_value_not_in_evidence"


@pytest.mark.parametrize("key,value", [
    ("grade", {"stage": "本科", "year": 9}), ("grade", {"stage": "大专", "year": 1}), ("grade", {"stage": None, "year": None}),
    ("grade", {"stage": "本科", "year": True}), ("age", {"value": "很多", "unit": "岁"}), ("age", {"value": 19, "unit": "小时"}),
    ("age", {"value": 19, "unit": "岁", "note": "x"}), ("pace", {"value": 10, "unit": "小时", "per": "世纪"}),
    ("pace", {"value": float("inf"), "unit": "小时"}), ("interest:ml", {"value": "机器学习"}), ("school", {"name": "清华大学"}),
])
def test_a_structured_value_of_the_wrong_shape_rejects_only_that_op(key, value):
    uid = store.create_user("t")["uid"]
    good = {"op": "add", "key": "grade", "value": {"stage": "本科", "year": 2}, "evidence_quote": "我大二", "affects": "task_difficulty"}
    acc, rej = memory.validate_ops(uid, [{**good, "key": key, "value": value}, good], ["我大二"])
    assert [a["value"] for a in acc] == ["大二"] and [r["reason"] for r in rej] == ["bad_type:value"]


def test_the_proposal_prompt_asks_for_the_structured_shapes():
    """模型照提示写：提示里没说的形状，代码按字段核对时只能当作字符串去猜。"""
    prompt = dialogue._proposal_system()
    for shape in ('"stage"', '"year"', '"unit"', '"per"', "直接抄原话"):
        assert shape in prompt


@pytest.mark.parametrize("text", [
    "不" * 20000, "大二不" * 7000, "对没兴趣" * 5000, "不" + "的" * 20000, "打错" * 10000, "not " * 5000 + "sophomore",
    "对" * 20000 + "没兴趣", "百分之" * 7000, "我不是大二，以前在信科，想读博，每周2小时，打错了。" * 800,
])
def test_the_gate_stays_linear_on_long_messages(text):
    """每条范围都管到分句末尾：原来按提示词逐个往后找「的」、逐处比对所有范围，几万字的消息会卡住整轮。"""
    ops = [{"op": "add", "key": k, "value": v, "evidence_quote": text, "affects": "task_difficulty"} for k, v in (
        ("grade", {"stage": "本科", "year": 2}), ("pace", {"value": 2, "unit": "小时", "per": "周"}), ("school", "清华大学"),
        ("department", "信息管理系"), ("interest:ml", "机器学习"), ("base:code", "会Python"), ("current:x", "在修线性代数课程的作业"))]
    t0 = time.perf_counter()
    memory.validate_ops(store.create_user("t")["uid"], ops, [text])
    assert time.perf_counter() - t0 < 2.0


@pytest.mark.parametrize("key,value,quote,ok", [
    ("age", "19岁，计算机基础扎实，擅长深度学习", "我今年19岁", False),    # 只核了 19，整串按自述存下（Codex 复现）
    ("pace", "每周能投入约十小时", "每周能投入约十小时", True),
    ("direction:ai", "人工智能", "我不喜欢AI", False),                      # 否定检查没换缩写找（Codex 复现）
    ("goal:papers", "每周读5篇机器学习论文", "我想每周读2篇机器学习论文", False),  # 锚住了就不查数字（Codex 复现）
    ("major", "国际政治", "我是外交学专业的", False),                      # 一张卡上的两个专业被当成一个（Codex 复现）
    ("major", "外交学", "我是外交学专业的", True),
    ("enroll_year", "2025", "我去年2025年入学", True),                     # 入学年份本来就是过去的事（Codex 复现）
    ("interest:ml", "机器学习", "我对机器学习不是不感兴趣", True),          # 抵掉的否定又被后置否定认了一遍（Codex 复现）
    ("grade", "大二", "我是大二.", True),                                  # 句号被当成小数点（Codex 复现）
    ("grade", {"stage": "本科", "year": 2}, "我是大二.", True),
])
def test_review_round18(key, value, quote, ok):
    acc, rej = _check(key, value, quote)
    assert (len(acc) == 1) is ok, rej


def test_an_oversized_structured_number_rejects_only_that_op():
    """10**400 是合法 JSON：原来 float() 抛 OverflowError，整轮校验中断（Codex 复现）。"""
    acc, rej = _check("age", {"value": 10 ** 400, "unit": "岁"}, "我今年19岁")
    assert acc == [] and rej[0]["reason"] == "bad_type:value"


def test_an_age_range_keeps_both_ends():
    """{"value": [19, 20]} 两头都核对了，原来只存「19岁」（Codex 复现）。"""
    acc, _ = _check("age", {"value": [19, 20], "unit": "岁"}, "我19到20岁")
    assert acc[0]["value"] == "19到20岁"
    acc, rej = _check("enroll_year", {"value": [2023, 2024], "unit": "年"}, "2023到2024年入学")
    assert acc == [] and rej[0]["reason"] == "bad_type:value"
