# -*- coding: utf-8 -*-
"""记忆服务：写入白名单、确定性校验、提交、召回。

契约见 docs/DIALOGUE_CONTRACT.md §3（key registry）、§7（校验）、§4（召回）。

核心原则：**模型提议，代码裁决。**
模型输出的每一条 memory_op 都要过 validate_ops；过不了的丢弃并记入 rejected_ops
（返回给前端和 decision log），绝不静默写库，也绝不让模型自己指定 confidence。
"""
from __future__ import annotations

import math
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any, NamedTuple

import store
import transcript
from schemas import DECISION_STATUSES, UserFact, now_iso

# ---------- §3 Key Registry ----------

# slug 允许连字符和点，也允许中文：模型很自然会写 interest:machine-learning，
# 也会写 current:选课数据大作业。早期只放行 [a-z0-9_] 会把这类真实信息整条拒掉
# （丢的是用户的话，不是垃圾）——这个错犯过两次，第二次是中文。
_SLUG_RE = re.compile(r"^[a-z0-9\u4e00-\u9fff][a-z0-9\u4e00-\u9fff_.\-]{0,39}$")
_SEP_RE = re.compile(r"[\s_]+")


def canon_key(key: str) -> str:
    """把 key 规范化，让同一个东西尽量只落到一个 key 上。

    允许中文之后，「interest:机器学习 」「interest:机器学习」「interest:机器学习_」
    会长成三条。但要清醒：ASCII-only **从来没有**解决同义重复
    （ai / AI / 人工智能 照样是三条），它只是拒掉了中文。
    所以这里做代码真正做得了的那部分——空格和下划线统一成连字符、去掉首尾分隔符。
    同义不同词那部分交给 single 基数的 supersede 和幂等 add 去兜。
    """
    k = (key or "").strip().lower()
    if ":" not in k:
        return k
    ns, slug = k.split(":", 1)
    return f"{ns}:{_SEP_RE.sub('-', slug.strip()).strip('-. ')}"


class KeySpec(NamedTuple):
    category: str
    cardinality: str          # single | multi | exclusive
    sources: tuple[str, ...]  # 允许的写入来源
    requires_valid_until: bool = False
    # 时间跨度层。决定注入预算、展示分组，以及「什么时候该重新问」。
    layer: str = "identity"
    # 不填 valid_until 时自动给的存活天数（0 = 不过期）。
    # 「当前实践」天然会过期：不问也不会一直错下去（见 docs/DIALOGUE_CONTRACT.md §4.1）。
    default_ttl_days: int = 0
    # 能不能主动问。False = 识别到就存，但**不主动追问**。
    # 性别/年龄放这里：它们几乎不改变任何建议，却是敏感信息——
    # 追问的收益近乎零，代价是让人觉得像在填表。用户自己说了就存着。
    ask: bool = True


# 层 = 时间跨度。顺序同时是提问顺序和界面展示顺序（契约 §4.1）。
# 为什么按时间跨度分而不是按主题分：变化速度决定「什么时候该重新问」，
# 也决定注入预算——身份类小且必带，倾向类多且只在聊方向时进来。
LAYERS: tuple[tuple[str, str], ...] = (
    ("identity", "身份"),
    ("practice", "当前实践"),
    ("capability", "能力起点"),
    ("experience", "经历积累"),
    ("interest", "倾向"),
    ("constraint", "临时约束"),
)
LAYER_LABELS: dict[str, str] = dict(LAYERS)
DEFAULT_LAYER = "identity"

# 每层注入预算。取代原来「平表按关键词取 top8」——那种做法里一门课的成绩
# 可能挤掉他的方向。每层给固定坑位，层内再按相关度排。
LAYER_BUDGET: dict[str, int] = {
    "identity": 6,
    "practice": 6,
    # 能力层放了两种东西：用户自述（capability:* / base:*）和成绩单推出来的
    # 事实（transcript:*）。后者是硬证据，坑位不够时**它优先**（见 recall_grouped）。
    # 4 个坑装不下「3 类课 + 数学基础 + 编程基础」，所以给 6。
    "capability": 6,
    "interest": 4,
    "experience": 3,
    "constraint": 4,
}


# 精确 key。分「域」见 key 的命名空间，分「层」见 layer。
_EXACT: dict[str, KeySpec] = {
    # 身份
    "grade": KeySpec("background", "single", ("declared",), layer="identity"),
    "school": KeySpec("background", "single", ("declared",), layer="identity"),
    "major": KeySpec("background", "single", ("declared",), layer="identity"),
    # 院系和专业分开存：常见「信息管理系 / 信息管理与信息系统」这种
    # 院系≠专业的组合，合成一条会丢掉其中一个（这正是 school 曾经被丢掉的老问题）。
    "department": KeySpec("background", "single", ("declared",), layer="identity"),
    # 入学年份：有了它年级可以自己算，否则「大二」每年都得重问一遍。
    "enroll_year": KeySpec("background", "single", ("declared",), layer="identity"),
    # 存得下、但不主动问（见 KeySpec.ask）
    "gender": KeySpec("background", "single", ("declared",), layer="identity", ask=False),
    "age": KeySpec("background", "single", ("declared",), layer="identity", ask=False),
    "location": KeySpec("background", "single", ("declared",), layer="identity"),
    # 每周可投入时间：决定任务给多大，是他最该被问清的一件事之一。
    "pace": KeySpec("preference", "single", ("declared",), layer="interest"),
    # 正在跟的组/老师。本科想进科研，这是最直接的抓手，所以放「当前实践」而不是经历。
    "research_group": KeySpec("practice", "multi", ("declared", "inferred"),
                              layer="practice", default_ttl_days=180),
    "base:math": KeySpec("capability", "single", ("declared",), layer="capability"),
    "base:code": KeySpec("capability", "single", ("declared",), layer="capability"),
    "base:math_code": KeySpec("capability", "single", ("declared",), layer="capability"),
    "base:none": KeySpec("capability", "single", ("declared",), layer="capability"),
}

# 命名空间 key：<namespace>:<slug>
_NAMESPACED: dict[str, KeySpec] = {
    # 学籍：双专业 / 辅修。变化很慢，但会改变他要补的课，所以归身份层。
    "enroll": KeySpec("background", "multi", ("declared",), layer="identity"),
    "goal": KeySpec("interest", "multi", ("declared",), layer="interest"),
    "interest": KeySpec("interest", "multi", ("declared", "inferred"), layer="interest"),
    # 方向互斥：写新的自动把旧的置 superseded。
    "direction": KeySpec("interest", "exclusive", ("declared",), layer="interest"),
    # 细分科研领域：比 direction 更细（例如 direction:ai 下面的「具身智能」）。
    "field": KeySpec("interest", "multi", ("declared", "inferred"), layer="interest"),
    # 就业去向：方向 / 地域 / 期望薪资。放在倾向层——它和科研方向是同一种
    # 「他想去哪」的信息，只是落点不同。
    "career": KeySpec("interest", "multi", ("declared",), layer="interest"),
    "style": KeySpec("preference", "single", ("declared",), layer="interest"),
    # 自然聊天里会出现「会一点 Python」这类能力自述；自述「已掌握」会被降级标注，
    # 见 validate_ops 的 needs_behavior_evidence。
    "capability": KeySpec("capability", "multi", ("declared", "inferred"), layer="capability"),
    # 从成绩单**推导**出来的能力底稿。只有代码能写（sources 是 derived-only）。
    # 和 capability: 分开是有意的：
    #   capability:*  = 用户自述或模型推断（「我会一点 Python」）
    #   transcript:*  = 成绩单推出来的事实（「修过 3 门数学类课程，加权平均 88.3」）
    # 混在一个 key 上会分不清哪部分是硬证据、哪部分是自述——
    # base:code 事故就是把两者搅在一起写出来的。
    "transcript": KeySpec("capability", "multi", ("derived",), layer="capability"),
    # 当前实践：手头在上的课、在做的项目。90 天自动过期，过期后系统会重新问，
    # 而不是拿半年前的项目当「他正在做的事」。（这正是「实践跨度」那一层）
    "current": KeySpec("practice", "multi", ("declared", "inferred"),
                       layer="practice", default_ttl_days=90),
    # 项目：一个项目 = 一个文件夹。
    #
    # 用户要的是「大项目记忆」——KotobaAI 这种东西不该拆成「在做什么」+「能力」
    # 两条互不认识的记录。但**不能做成一块 blob**，因为四条机制都要逐条粒度：
    # 证据核对、TTL、单独改删、按相关度部分注入。
    #
    # 所以是「实体 + 属性」：
    #   project:kotoba            实体本身（这是什么）
    #   project:kotoba.what       它是什么
    #   project:kotoba.stage      到什么阶段了
    #   project:kotoba.stack      用了什么
    #   project:kotoba.blocker    卡在哪
    #   project:kotoba.next       下一步
    #   project:kotoba.traction   成果/数据
    #
    # 存储上仍是分开的事实（每条各有证据、可单独改删）；
    # 展示上合成一张卡（见 recall 和前端 proj-*）；
    # 注入时整组进出（recall 里 project 同组一起捞）——
    # 项目缺一半会导致误判，所以不拆开注入。
    #
    # TTL 180 天：项目比「这周在做什么」活得久，但也不该无限期当现状。
    "project": KeySpec("practice", "multi", ("declared", "inferred"),
                       layer="practice", default_ttl_days=180),
    # 担任的角色：社团、学工、志愿服务。
    # 和 experience 分开是有意的：experience 是「做出过什么」，必须由提交事件写入；
    # role 是「担任什么」，用户自述即可。混在一起会让行为证据被自述稀释。
    "role": KeySpec("experience", "multi", ("declared",), layer="experience"),
    # 临时约束必须带有效期，否则会变成永久设定。
    "constraint": KeySpec("preference", "multi", ("declared",),
                          requires_valid_until=True, layer="constraint"),
    # 经历只能由提交事件写入，模型不能写（见 §3 规则 3）。
    "experience": KeySpec("experience", "multi", ("behavior",), layer="experience"),
}


# ---------- 「核对」页的字段清单 ----------
# 用户给的九大类，以及每类里的固定字段。
# 为什么显式写出来、不从 registry 自动推导：用户看到的分类和库里的命名空间
# 不是一对一——「已修课程」在 enrollments 表里而不是 facts 里，
# 「进修方向」横跨身份层和倾向层。自动推导会让界面上的分类跟用户说的对不上。
#
# key 写法：
#   "grade"      精确匹配一条 facts
#   "current:"   前缀匹配（命名空间）
#   "@enroll"    特殊：查 enrollments 表
class Slot(NamedTuple):
    key: str
    label: str
    why: str          # 填了它，能让什么更准 —— 直接显示给用户看
    presumed: str = ""  # 产品的默认前提（本产品只服务北大学生）。显示成已填、不主动问，
                        # 只在用户自己说出别的值时被覆盖。


COVERAGE_GROUPS: tuple[tuple[str, str, str, tuple[Slot, ...]], ...] = (
    ("identity", "身份", "你是谁。这层决定我给你什么难度的东西。", (
        Slot("grade", "年级", "大一和大二能做的事不一样"),
        # 学校：本产品只服务北大学生，默认就是北大——**不主动问**（实测模型会问
        # 「你是哪个学校的」，用户回一句「这还用问」）。留这个格子是为了他主动
        # 说起别的学校时存得下，那一轮代码会如实说知识库只覆盖北大培养方案。
        Slot("school", "学校", "只在你主动提到时才记；本产品默认北京大学",
             presumed="北京大学"),
        Slot("department", "院系", "院系决定你身边有什么资源"),
        Slot("major", "专业", "专业决定你已经有哪些基础"),
        Slot("enroll_year", "入学年份", "用来算年级，免得每年重问你一次"),
        Slot("location", "所在地", "决定能不能参加线下的活动和实习"),
        Slot("gender", "性别", "存着，但我不主动问——它几乎不改变建议"),
        Slot("age", "年龄", "存着，但我不主动问——年级一般就够了"),
    )),
    ("courses_done", "已修课程", "你学过什么。这是判断起点最硬的依据。", (
        Slot("@enroll", "成绩单", "粘贴一次，我就知道你修过哪些课、考得怎么样"),
    )),
    ("practice", "在修课程与当前在做的事", "你此刻手头的事。它变得最快，所以我最常回来问。", (
        Slot("project:", "在做的项目", "项目是你最实的当前实践——任务要挂在它上面"),
        Slot("current:", "在修课程 / 在做的事", "任务要挂在你正在做的事上才有用"),
        Slot("current:audit", "旁听课程", "旁听说明你在主动往外看"),
    )),
    ("capability", "能力", "从成绩单和经历里推出来的结论，不是我拍脑袋。", (
        Slot("capability:", "已掌握的能力", "决定起点难度"),
        Slot("base:", "基础自评", "数学和编程基础决定路径怎么排"),
    )),
    ("interest", "进修方向", "你想往哪走。没有它，我只能给泛泛的建议。", (
        Slot("direction:", "方向", "决定我给你哪条路径"),
        Slot("field:", "细分科研领域", "越具体，我能找的论文和项目越准"),
        Slot("enroll:", "双专业 / 辅修", "决定你还缺哪些课"),
        Slot("goal:", "目标", "读研、出国、就业，路径不一样"),
        Slot("pace", "每周可投入时间", "决定任务给多大——不然我给的任务你做不到"),
    )),
    ("career", "实习就业方向", "如果你在意就业，这层让建议不至于偏到纯学术。", (
        Slot("career:", "就业方向 / 地域", "就业和科研的路径安排不一样"),
    )),
    ("social", "人际交往", "社团、学工、志愿，以及导师课题组。", (
        Slot("research_group", "导师课题组", "本科生进科研最直接的抓手就是进组"),
        Slot("role:", "社团 / 学工 / 志愿服务", "也是你的时间去向，影响任务大小"),
    )),
    ("constraint", "临时约束", "这周忙不忙。会过期，过期我会重新问。", (
        Slot("constraint:", "当前限制", "不然我会给出你现在根本做不了的事"),
    )),
    ("experience", "经验积累", "你真做出来过的东西。只有交过成果才算。", (
        Slot("experience:", "做过的项目 / 成果", "这是唯一没法自己说了算的依据，所以最值钱"),
    )),
)


def _slot_filled(uid: str, slot_key: str, facts_keys: set[str],
                 enroll_count: int) -> tuple[bool, str]:
    """这个字段填了没有，以及填的是什么（给界面显示一行值）。"""
    if slot_key == "@enroll":
        return (enroll_count > 0), (f"已录入 {enroll_count} 门" if enroll_count else "")
    if slot_key.endswith(":"):
        hit = sorted(k for k in facts_keys if k.startswith(slot_key))
        return bool(hit), (hit[0] if hit else "")
    hit = slot_key in facts_keys
    return hit, (slot_key if hit else "")


def coverage(uid: str) -> dict[str, Any]:
    """「核对」页用：按类别列出每个固定字段填了没有。

    用户的原话：「把我给出来的这些空都给用户展示出来……表示填好这些信息
    可以让科研导向更准确」。所以每个空格都带一句「填了它有什么用」——
    空格本身是邀请，但得说清代价和收益，否则就是一张逼人填的表。
    """
    alive = active_facts(uid)
    by_key = {f.key: f.value for f in alive}
    keys = set(by_key)
    enroll_count = len(store.list_enrollments(uid))

    groups = []
    total = filled = 0
    for gid, label, why, slots in COVERAGE_GROUPS:
        items = []
        for s in slots:
            ok, val = _slot_filled(uid, s.key, keys, enroll_count)
            if ok and s.key in by_key:
                val = by_key[s.key]
            # 前缀类字段拿真实值显示，别拿 key 当值
            if ok and s.key.endswith(":") and val:
                val = by_key.get(val, "")
            if not ok and s.presumed:
                # 默认前提（本产品只服务北大）算已填：核对页不该给用户留一个
                # 永远填不上、还会诱导对话去问的格子。
                ok, val = True, s.presumed
            items.append({
                "key": s.key, "label": s.label, "why": s.why,
                "filled": ok, "value": val,
                # 值是默认前提（不是他自己说的）——界面用它决定要不要标「默认」
                "presumed": bool(s.presumed) and val == s.presumed,
            })
            total += 1
            filled += 1 if ok else 0
        groups.append({
            "group": gid, "label": label, "why": why, "slots": items,
            "filled": sum(1 for i in items if i["filled"]), "total": len(items),
        })

    return {
        "groups": groups,
        "filled": filled,
        "total": total,
        "missing": total - filled,
    }


def layer_of(key: str) -> str:
    spec = spec_for(key)
    return spec.layer if spec else DEFAULT_LAYER


def layer_label(key: str) -> str:
    return LAYER_LABELS.get(layer_of(key), layer_of(key))

# 只有这些来源是「用户自己说的」——模型输出一律按 declared/inferred 处理，
# 永远不能自称 behavior（那是提交事件才有的事实）。
_MODEL_SOURCES = ("declared", "inferred")

_CONFIDENCE_BY_SOURCE = {
    "declared": 0.6,    # 用户自己说的
    "inferred": 0.4,    # 我们推的
    "derived": 0.75,    # 从成绩单这类**官方底稿**推出来的，比自述硬
    "behavior": 0.8,    # 在我们系统里真做出来的
    "user_edit": 1.0,   # 用户在界面上亲手改的（他是关于他自己的最终权威）
}

# 声称「已掌握」的措辞。只有 declared 证据时降级并标注，不得据此升级任务难度。
_MASTERY_WORDS = ("掌握", "熟练", "精通", "独立完成", "独立写", "会写", "aca", "能独立")


def spec_for(key: str) -> KeySpec | None:
    """key → 写入规则；未命中返回 None（该 op 必须被拒绝）。"""
    k = canon_key(key)
    if not k:
        return None
    if k in _EXACT:
        return _EXACT[k]
    if ":" not in k:
        return None
    ns, slug = k.split(":", 1)
    spec = _NAMESPACED.get(ns)
    if not spec or not _SLUG_RE.match(slug):
        return None
    return spec


def confidence_for(source: str) -> float:
    return _CONFIDENCE_BY_SOURCE.get(source, 0.5)


# ---------- 有效期 ----------


def _parse_when(raw: Any) -> datetime | None:
    if not raw or not isinstance(raw, str):
        return None
    text = raw.strip()
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(text, fmt)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    try:
        dt = datetime.fromisoformat(text)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def is_expired(fact: UserFact, now: datetime | None = None) -> bool:
    """临时约束到点后不再参与决策（03 §2「时间上下文」）。解析不了的日期视为未过期，不静默丢弃。"""
    when = _parse_when(fact.valid_until)
    if when is None:
        return False
    return when < (now or datetime.now(timezone.utc))


def _plus_days(days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


# ---------- §7 确定性校验 ----------


def _evidence_ok(quote: str, pool: list[str]) -> bool:
    """引文必须能在本画像的消息里逐字找到。这是防编造的关键一条。"""
    q = (quote or "").strip()
    if len(q) < 2:
        return False
    return any(q in text for text in pool if text)


# 虚词：出现在引文里不代表支撑了值，算支撑度时排除。
_SUPPORT_STOP = set("的了是在和与及或我你他她它们这那就也都很没为以对把被让给从到个之其会要可能但而且还只又再已经过将")

# 支撑度阈值。>=OK 直接收；中间地带保留但降级为 inferred；太低直接拒。
_SUPPORT_OK = 0.8
_SUPPORT_FLOOR = 0.5
# 只对「有实质内容」的值做支撑度检查。短值（"AI"、"大二"、方向 slug）本来就是
# 规范化缩写，逐字要求它出现在引文里会误杀；真正出问题的是长值里塞了引文没有的东西。
_SUPPORT_MIN_CHARS = 8


def _content_chars(text: str) -> set[str]:
    return {c for c in (text or "")
            if (c.isalnum() or "\u4e00" <= c <= "\u9fff")} - _SUPPORT_STOP


def support_ratio(value: str, quote: str) -> float:
    """值的「内容字」有多少能在引文里找到。

    只验「引文存在」是不够的，这是实测出来的：模型写 base:code 时，值里塞了三门课
    加成绩（来自别的消息），却挂一句「也做过一些个人小项目，但都是Vibecoding的」当依据，
    旧校验照样通过。于是它自己加的「（依赖AI生成）」永久进了画像，
    并直接导致了一个不合身份的任务（见 docs/CHANGELOG.md）。
    所以要补上这条：**引文得撑得住这个值**，不只是碰巧出现过。
    """
    v = _content_chars(value)
    if not v:
        return 1.0
    return len(v & _content_chars(quote)) / len(v)


# 年级的说法：「大二」「本科二年级」「sophomore」是同一个（本科, 2）；「博士」是（博士, 不知第几年）。
# 阶段词后面的空白放进可选组里：写成「(阶段)?\s*」时，一长串空格每个位置都要把后面的空格吃完再吐回来，
# 两万个空格要二十秒（自己压测出来的）
_GRADE_RE = re.compile(r"(?:(本科|硕士|研究生|博士|高中|大学)\s*)?(?:([大研硕博高])\s*([一二三四五六1-6])(?![0-9])|第([一二三四五六1-6])\s*年(?![代份])"
                       r"|(?<![0-9])([一二三四五六1-6])\s*年级)|(本科|硕士|研究生|博士|高中)")
_GRADE_STAGE = {"本科": "本", "大学": "本", "大": "本", "硕士": "硕", "研究生": "硕", "研": "硕", "硕": "硕",
                "博士": "博", "博": "博", "高中": "高", "高": "高"}
_GRADE_YEAR = {c: i + 1 for i, c in enumerate("一二三四五六")} | {str(i): i for i in range(1, 7)}
_GRADE_EN = {"freshman": ("本", 1), "sophomore": ("本", 2), "junior": ("本", 3), "senior": ("本", 4),
             "undergrad": ("本", None), "undergraduate": ("本", None), "master": ("硕", None),
             "masters": ("硕", None), "phd": ("博", None)}
_EN_ORD = {"first": 1, "1st": 1, "second": 2, "2nd": 2, "third": 3, "3rd": 3, "fourth": 4, "4th": 4, "fifth": 5, "5th": 5}
_EN_YEAR = re.compile(r"\b(first|second|third|fourth|fifth|[1-5](?:st|nd|rd|th))[\s-]*year\b|\byear\s*([1-6])\b")
# 前面紧跟这些的年级不算现在的：否定（不是、不算）和过去（以前是、去年读）。「以前是大一，现在大二」只有大二
_NEGATED = re.compile(r"(?:不是|不再是|并非|非|没在|不在|不算|算不上|(?:以前|之前|原来|去年|曾经|前年)(?:是|读|在读|上|念)?)\s*$")
# 后面紧跟这些的是说错了、改口：「大二，哦打错了我是大三」只有大三
_CORRECTED = re.compile(r"^[\s，,。.!！…~～]*(?:哦|啊|呃|嗯|额)?[\s，,]*(?:打错|说错|写错|口误|不对|错了)")
# 阶段词后直接跟年份、省了「第」：「我本科二年，北大的」（Codex 第十五轮）；没有阶段词的「三年」还是不算
_GRADE_STAGE_YEAR = re.compile(r"(本科|大学|研究生|硕士|博士)\s*([一二三四五六1-6])\s*年(?![代份级里内中制间期来])")


def _grades_in(text: str) -> list[tuple[str | None, int | None]]:
    """文本里提到的、说的是现在的年级（阶段, 第几年）。被否定的、过去的、紧接着改口的不算。
    「第N年」要有「第」：「学 Python 三年了」「一年内读完」不是年级（Codex 第十四轮复现）。"""
    text = unicodedata.normalize("NFKC", text or "")
    out = []
    for m in _GRADE_RE.finditer(text):
        if _NEGATED.search(text[max(0, m.start() - 6):m.start()]) or _CORRECTED.search(text[m.end():m.end() + 10]):
            continue
        word, prefix, year, year2, year3, alone = m.groups()
        stage = _GRADE_STAGE.get(word or prefix or alone or "")
        out.append((stage, _GRADE_YEAR.get(year or year2 or year3 or "")))
    for m in _GRADE_STAGE_YEAR.finditer(text):
        if not (_NEGATED.search(text[max(0, m.start() - 6):m.start()]) or _CORRECTED.search(text[m.end():m.end() + 10])):
            out.append((_GRADE_STAGE.get(m.group(1)), _GRADE_YEAR.get(m.group(2))))
    low = text.lower()

    def negated(start: int) -> bool:
        return bool(_NEGATED.search(text[max(0, start - 6):start]) or re.search(r"\bnot\s+(?:a\s+|an\s+)?(?:[a-z-]+\s+)?$", low[max(0, start - 30):start]))

    covered = []
    for m in _EN_YEAR.finditer(low):
        n = _EN_ORD.get(m.group(1) or "") or (int(m.group(2)) if m.group(2) else None)
        # 只看紧跟在 year 后面的阶段词：原来往后看 24 个字，「I am not first-year, I am a sophomore」的 sophomore 被吞掉（Codex 复现）
        sm = re.match(r"[\s-]*((?:undergrad(?:uate)?|phd|ph\.d\.?|doctoral|master'?s?|graduate|grad|college)\b(?:\s+(?:graduate|student))?)?", low[m.end():])
        words = sm.group(1) or ""
        covered.append((m.start(), m.end() + sm.end()))
        if n and not negated(m.start()):
            stage = ("博" if re.search(r"phd|ph\.d|doctoral", words) else  # 博士优先：「PhD graduate student」是博士不是硕士
                     "本" if ("undergrad" in words or "college" in words) else
                     "硕" if re.search(r"master|graduate|grad", words) else None)
            out.append((stage, n))
    for m in re.finditer(r"[a-z']+", low):
        hit = _GRADE_EN.get(m.group().replace("'", ""))
        if hit and not negated(m.start()) and not any(a <= m.start() < b for a, b in covered):
            out.append(hit)
    return out


# 常见缩写和全称算同一个：学生说「想试试 AI」，模型记「人工智能」不算编
_ALIASES = {"ai": "人工智能", "ml": "机器学习", "nlp": "自然语言处理", "cv": "计算机视觉", "cs": "计算机",
            "rl": "强化学习", "dl": "深度学习", "llm": "大模型", "hci": "人机交互", "econ": "经济学"}


def _with_aliases(text: str) -> str:
    low = (text or "").lower()
    extra = [full for a, full in _ALIASES.items() if re.search(rf"(?<![a-z]){a}(?![a-z])", low)]
    extra += [a for a, full in _ALIASES.items() if full in low]
    return low + " " + " ".join(extra)


_CN_DIGIT = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def _cn_number(run: str) -> int | None:
    """「二十」「二十五」「十二」「三」「一百」这类小于一千的中文数；认不出返回 None。"""
    total, cur = 0, 0
    for ch in run:
        if ch in _CN_DIGIT:
            cur = _CN_DIGIT[ch]
        elif ch == "十":
            total += (cur or 1) * 10
            cur = 0
        elif ch == "百":
            total += (cur or 1) * 100
            cur = 0
        else:
            return None
    return total + cur


# 数量连着单位比：「每周2小时，总共20周」撑不住「每周20小时」——20 在原话里是周数（Codex 第十四轮复现）
_UNITS = {"小时": "h", "h": "h", "hr": "h", "hrs": "h", "hour": "h", "hours": "h", "个小时": "h", "钟头": "h",
          "分钟": "min", "min": "min", "mins": "min", "分": "min", "秒": "s", "天": "d", "日": "d", "周": "w", "星期": "w",
          "个月": "mo", "月": "mo", "年": "y", "岁": "age", "学分": "cr", "门": "门", "个": "个", "次": "次", "篇": "篇",
          "项": "项", "人": "人", "倍": "x", "%": "%", "级": "lv", "期": "期", "章": "章", "节": "节", "页": "页", "题": "题"}
_COUNTERS = {"个", "项", "门", "篇", "次", "期", "章", "节", "页", "题", "人"}
_UNIT_RE = "|".join(sorted(map(re.escape, _UNITS), key=len, reverse=True))
_NUM = r"(\d{1,9}(?:\.\d{1,4})?|[零一二两三四五六七八九十百]+)"
_QTY = re.compile(_NUM + r"(?:\s*(?:到|至|~|-|—|或)\s*" + _NUM + r")?\s*(" + _UNIT_RE + r")?", re.IGNORECASE)


_VULGAR = re.compile(r"(?:(\d{1,6})\s*)?([¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])")  # 空白只跟在数字后面：「(数)?\s*」在长串空白上会平方级回溯


def _dec(x: float) -> str:
    return f"{x:.4f}".rstrip("0").rstrip(".")  # 最多四位小数：正好是数的正则能整段吃下的长度


def _fractions(text: str) -> str:
    """「½」「1½」「⅓」先整体算成小数（「1½」是 1.5）：原来 NFKC 把「1½」拼成「11⁄2」读成 5.5、⅓ 的循环小数被拆成两个数（Codex 复现）；
    「半小时」是 0.5 小时，「一个半小时」「1个半小时」是 1.5 小时。"""
    text = _VULGAR.sub(lambda m: _dec(int(m[1] or 0) + unicodedata.numeric(m[2])), text)
    # 空白不要两段连着写（「\s*个?\s*」）：长串空白上会平方级回溯，一万六千个空格卡住事件循环两秒多（Codex 复现）
    text = re.sub(r"(\d{1,6}|[一二两三四五六七八九十]{1,3})\s*(?:个\s*)?半\s*(?=小时|钟头)",
                  lambda m: _dec((float(m[1]) if m[1][0].isdigit() else float(_cn_number(m[1]) or 0)) + 0.5), text)
    return re.sub(r"(?<![\d一二两三四五六七八九十])半\s*(?:个\s*)?(?=小时|钟头)", "0.5", text)


def _num(tok: str) -> float | None:
    if tok[0].isdigit():
        return float(tok)
    n = _cn_number(tok)
    return None if n is None else float(n)


def _quantities(text: str) -> set[tuple[float, str]]:
    """文本里的数和它的单位（没单位就是 ""）。全角先转半角（「３．７」）；中文数只认带单位或在括号里的（「高数A（一）」），
    免得「一些」也成了 1；范围「三到五小时」两头都算小时。"""
    text = _fractions(text or "")
    text = unicodedata.normalize("NFKC", text)
    # 分数两头都得是完整的整数：「3.7/4.0」里的「7/4」不是分数（原来算成 1.75，GPA 3.7 被拒、编的 3.1 反而收了，Codex 复现）
    text = re.sub(r"(?<![\d.])(\d{1,3})\s*[⁄∕/]\s*(\d{1,3})(?![\d.])", lambda f: _dec(int(f[1]) / int(f[2])) if int(f[2]) else f[0], text)
    out: set[tuple[float, str]] = set()
    for m in _QTY.finditer(text):
        a, b, unit = m.group(1), m.group(2), (m.group(3) or "")
        u = _UNITS.get(unit.lower(), _UNITS.get(unit, "")) if unit else ""
        bracketed = text[max(0, m.start() - 1):m.start()] in ("(", "（") and text[m.end():m.end() + 1] in (")", "）")
        for tok in (a, b):
            if not tok:
                continue
            if not tok[0].isdigit() and not u and not bracketed:
                continue
            n = _num(tok)
            if n is not None:
                out.add((n, u))
    return out


def _numbers_in(text: str) -> set[float]:
    return {n for n, _ in _quantities(text)}


def _numbers_supported(value: str, quote: str) -> bool:
    """值里写的每个数，引文里都得有同一个数、而且单位对得上（值没写单位就只比数）；小时和分钟可以互换。
    原来「每周2小时」撑得住「每周20小时」、「3.07」撑得住「3.7」（Codex 复现）。"""
    have = _quantities(quote)
    for n, u in _quantities(value):
        same = {(n, u)} if u else {(n, x) for _, x in have}
        if u in _COUNTERS:  # 「个」和别的量词互通（「2个项目」「2项项目」），「门」和「篇」之间不通
            same |= {(n, "个")} if u != "个" else {(n, c) for c in _COUNTERS}
        if u == "h":
            same.add((round(n * 60, 4), "min"))
        if u == "min":
            same.add((round(n / 60, 4), "h"))
        if not (same & have or (u and (n, "") in have)):
            return False
    return True


_POSITIVE_KEYS = ("interest", "goal", "direction", "field")
_NEG_BEFORE = r"(?<!不是)(?<!并非)(?:不喜欢|讨厌|不想学|不想做|不想读|不想碰|不打算|不考虑|不感兴趣于|对)\s*"
_NEG_AFTER = r"\s*(?:没有?|不|并不|不太|没什么)(?:什么|太)?(?:兴趣|感兴趣|想法|打算)"


def _negated_in(value: str, quote: str) -> bool:
    """引文里这个值是被否定的：「对 X 没有兴趣」「不喜欢 X」（「我不是不喜欢 X」这种双重否定不算）。"""
    low = quote.lower()
    for term in {value.lower(), *(a for a, full in _ALIASES.items() if full == value), *(full for a, full in _ALIASES.items() if a == value.lower())}:
        t = re.escape(term) + (r"(?![a-z])" if term.isascii() else "")
        if re.search(r"(?<!不是)(?<!并非)对\s*" + t + _NEG_AFTER, low) or re.search(r"(?<!不是)(?<!并非)(?:不喜欢|讨厌|不想学|不想做|不想读|不打算|不考虑)\s*" + t, low):
            return True
    return False


_GRADE_WORDS = re.compile(r"(?i)\b(?:" + "|".join(list(_GRADE_EN) + list(_EN_ORD)) + r"|year|student|grad|graduate|college|university|pku)\b|[\s-]+")


def _grade_supported(value: str, quote: str) -> bool | None:
    """年级值的约束，不分长短：值写了第几年，引文就得说了同一年；被否定的、过去的、改口的不算；
    年级以外夹带的内容（「本科二年级，GPA4.0」）要另有着落（Codex 复现：长值原来跳过这些检查）。值里认不出年级返回 None。"""
    if not _grades_in(value):
        return None
    stage, year = _grades_in(value)[0]
    norm = unicodedata.normalize("NFKC", value)
    rest = _GRADE_WORDS.sub("", _GRADE_STAGE_YEAR.sub("", _GRADE_RE.sub("", norm)))
    if _content_chars(rest) and not (_numbers_supported(rest, quote) and _content_chars(rest) & _content_chars(_with_aliases(quote))):
        return False
    return any((stage is None or s is None or s == stage) and (year is None or y == year) for s, y in _grades_in(quote))


def _short_value_supported(key: str, value: str, quote: str) -> bool:
    """短值也得撑得住。年级按（阶段, 第几年）比：值写了第几年，引文就得说了同一年（「本科在读」撑不住「本科二年级」），
    被否定的不算；别的短值（算上常见缩写）至少要有一个内容字出现在引文里。"""
    g = _grade_supported(value, quote) if key == "grade" else None
    if g is not None:
        return g
    if key.split(":")[0] in _POSITIVE_KEYS and _negated_in(value, quote):
        return False
    v = _content_chars(_with_aliases(value))
    return not v or bool(v & _content_chars(_with_aliases(quote)))




# 这条记忆改变未来的哪个决策。填不出就没资格进画像。
# 依据是「写入代价不对称」：少记一条只是下次再问一遍，记错一条会静默污染之后每个决策，
# 而且没人会发现——所以默认不写，要写就举证。
AFFECTS: tuple[tuple[str, str], ...] = (
    ("task_difficulty", "任务难度"),
    ("task_kind", "任务类型"),
    ("direction_choice", "方向建议"),
    ("question_next", "下一轮问什么"),
    ("course_pick", "课程推荐"),
    ("pace", "推进节奏"),
    ("feedback", "反馈方式"),
)
AFFECT_LABELS: dict[str, str] = dict(AFFECTS)
AFFECT_KEYS = set(AFFECT_LABELS)

# 只有这些 op 需要举证「改变了什么决策」；retract/support 是对已有事实的操作。
_AFFECT_REQUIRED = ("add", "replace")

# 模型 op 里这些字段只能是字符串或不填。
_OP_FIELDS = ("op", "key", "value", "category", "source", "evidence_quote", "target_fact_id", "affects", "valid_until")


def validate_ops(uid: str, ops: list[dict[str, Any]], evidence_pool: list[str]) -> tuple[list[dict], list[dict]]:
    """逐条校验。返回 (accepted, rejected)，rejected 带 reason 以便前端和日志展示。

    注意：这里不抛异常、不静默通过——任何一条拿不准就拒绝，并留下可读理由。
    """
    accepted: list[dict] = []
    rejected: list[dict] = []
    facts_by_id = {f.id: f for f in store.list_facts(uid)}

    for raw in ops or []:
        if not isinstance(raw, dict):
            rejected.append({"op": None, "reason": "not_an_object"})
            continue
        # 值是数字（入学年份 2024、年龄 20）先转成字符串：原来一律当类型不对拒掉，年份就记不下来（Codex 复现）
        num = raw.get("value")
        if isinstance(num, int) and not isinstance(num, bool) and abs(num) < 10 ** 12:
            raw = {**raw, "value": str(num)}
        elif isinstance(num, float) and math.isfinite(num) and abs(num) < 1e12:
            raw = {**raw, "value": f"{num:g}"}
        # 字段只收字符串（或不填）：原来 key 是列表就 .strip() 抛异常、整轮 500，valid_until 是 [] / {} 过了校验到 SQLite 才炸（Codex 复现）
        bad = next((f for f in _OP_FIELDS if not isinstance(raw.get(f), (str, type(None)))), None)
        if bad:
            rejected.append({"op": raw.get("op"), "key": raw.get("key"), "value": raw.get("value"), "raw": raw,
                             "reason": f"bad_type:{bad}"})
            continue
        op = str(raw.get("op") or "").strip().lower()
        key = canon_key(raw.get("key") or "")
        item = {"op": op, "key": key, "value": raw.get("value"), "raw": raw}

        if op not in ("add", "replace", "retract", "support"):
            rejected.append({**item, "reason": "bad_op"})
            continue

        spec = spec_for(key)
        if spec is None:
            rejected.append({**item, "reason": "key_not_in_registry"})
            continue

        if spec.sources == ("behavior",):
            rejected.append({**item, "reason": "behavior_only:经历类事实只能由提交事件写入"})
            continue

        if spec.sources == ("derived",):
            # 成绩单推导由 memory.sync_transcript_facts 确定性生成。
            # 模型不能写：它没有底稿，只能编判断——那正是 base:code 事故。
            rejected.append({**item, "reason": "derived_only:成绩单结论由代码从底稿推导，模型不能写"})
            continue

        source = str(raw.get("source") or "declared").strip().lower()
        if source not in _MODEL_SOURCES:
            # 模型不得自称 behavior
            source = "declared"

        if not _evidence_ok(str(raw.get("evidence_quote") or ""), evidence_pool):
            rejected.append({**item, "reason": "evidence_not_found"})
            continue

        # 闸门③：必须说清这条记忆改变未来的哪个决策。
        affects = str(raw.get("affects") or "").strip().lower()
        if op in _AFFECT_REQUIRED:
            if not affects:
                rejected.append({**item, "reason": "no_affects:没说清它改变哪个决策"})
                continue
            if affects not in AFFECT_KEYS:
                rejected.append({**item, "reason": f"bad_affects:{affects}"})
                continue

        target = None
        changed_key = False
        retire_id = None
        if op in ("replace", "retract", "support"):
            tid = str(raw.get("target_fact_id") or "").strip()
            target = facts_by_id.get(tid)
            if target is None:
                rejected.append({**item, "reason": "target_fact_not_found"})
                continue
            if op == "replace" and str(target.key) != key:
                # 「把 direction:ai 改成 direction:math」：原来会存成 direction:ai = 数学，显示改了、规划和选项目还按 AI（Codex 复现）。
                # 键变了就不是改一条，是换一条：新值按 add 写，被替换的那条明确撤掉——
                # 不能只靠 add 的同类覆盖：goal:phd → goal:work 这种可多值的键不会被覆盖，两个目标会同时留着。
                retire_id = target.id
                op, target, changed_key = "add", None, True

        value = str(raw.get("value") or "").strip()
        if op in ("add", "replace") and not value:
            rejected.append({**item, "reason": "empty_value"})
            continue
        if len(value) > 200:
            value = value[:200]

        # 闸门②：引文得撑得住这个值。
        quote = str(raw.get("evidence_quote") or "").strip()
        substantive = len(_content_chars(value)) >= _SUPPORT_MIN_CHARS
        ratio = support_ratio(value, quote) if (op in ("add", "replace") and substantive) else 1.0
        if op in ("add", "replace") and substantive and ratio < _SUPPORT_FLOOR:
            rejected.append({**item, "reason": f"value_exceeds_evidence:{ratio:.2f}"})
            continue
        grade_ok = _grade_supported(value, quote) if key == "grade" else None
        if op in ("add", "replace") and grade_ok is False:
            rejected.append({**item, "reason": "grade_not_in_evidence"})
            continue
        if op in ("add", "replace") and key.split(":")[0] in _POSITIVE_KEYS and _negated_in(value, quote):
            rejected.append({**item, "reason": "negated_in_evidence"})  # 「我对机器学习没有兴趣」不能记成兴趣（Codex 复现）
            continue
        if op in ("add", "replace") and grade_ok is None and not substantive and not _short_value_supported(key, value, quote):
            # 短值原来跳过支撑度检查：学生说「我大二」，模型写年级「博士」也照样按 declared 存进去（Codex 复现）
            rejected.append({**item, "reason": "short_value_not_in_evidence"})
            continue
        if op in ("add", "replace") and key != "grade" and not _numbers_supported(value, quote):
            rejected.append({**item, "reason": "number_not_in_evidence"})
            continue

        valid_until = raw.get("valid_until")
        if spec.requires_valid_until:
            if not valid_until or _parse_when(valid_until) is None:
                rejected.append({**item, "reason": "constraint_requires_valid_until"})
                continue
        elif valid_until and _parse_when(valid_until) is None:
            valid_until = None

        notes: list[str] = ["replace_key_changed_as_add"] if changed_key else []
        # 引文只撑住一部分 → 说明值里有模型的推断成分。不丢，但降级成 inferred，
        # 免得「用户说的」和「模型推的」在画像里长得一样（这是 base:code 那次事故的根因）。
        if op in ("add", "replace") and ratio < _SUPPORT_OK:
            source = "inferred"
            notes.append("partially_inferred")
        if spec.category == "capability" and source != "behavior":
            if any(w in value for w in _MASTERY_WORDS):
                # 自述「已掌握」但没有行为证据：保留但不据此升级难度（02 §10.1）
                notes.append("needs_behavior_evidence")

        # 「当前实践」不填有效期时自动给一个，过期后会被重新问，而不是一直当现状用。
        if spec.default_ttl_days and not valid_until:
            valid_until = _plus_days(spec.default_ttl_days)

        accepted.append({
            "op": op,
            "key": key,
            "category": spec.category,
            "cardinality": spec.cardinality,
            "layer": spec.layer,
            "value": value,
            "source": source,
            "confidence": confidence_for(source),
            "valid_until": valid_until,
            "affects": affects or None,
            "support_ratio": round(ratio, 3),
            "evidence_quote": str(raw.get("evidence_quote") or "").strip()[:300],
            "target_fact_id": target.id if target else None,
            "retire_fact_id": retire_id,
            "notes": notes,
        })

    return accepted, rejected


# ---------- 提交 ----------


def _supersede_existing(uid: str, key: str, spec: KeySpec, keep: str | None,
                        decision_id: str) -> list[dict[str, Any]]:
    """按基数把旧事实置为 superseded，返回被改动的记录。"""
    changed: list[dict[str, Any]] = []
    for f in store.list_facts(uid, statuses=list(DECISION_STATUSES)):
        if f.id == keep:
            continue
        hit = f.key == key if spec.cardinality == "single" else (
            f.key.startswith(key.split(":", 1)[0] + ":") if spec.cardinality == "exclusive" else False
        )
        if not hit:
            continue
        store.update_fact(f.id, status="superseded")
        store.add_revision(uid, fact_id=f.id, operation="supersede", old_value=f.value,
                           new_value=None, evidence=f.evidence, decision_id=decision_id)
        changed.append({"id": f.id, "key": f.key, "status": "superseded", "value": f.value})
    return changed


def _retire(uid: str, fid: str | None, evidence: list[dict], decision_id: str, keep: str | None = None) -> list[dict]:
    """改键的 replace：把被替换的那条撤掉（已经不在用的、或者正好就是要留下的那条，不动）。"""
    if not fid or fid == keep:
        return []
    old = store.get_fact(fid)
    if not old or old.status not in DECISION_STATUSES:
        return []
    store.update_fact(old.id, status="superseded")
    store.add_revision(uid, fact_id=old.id, operation="retract", old_value=old.value,
                       new_value=None, evidence=evidence, decision_id=decision_id)
    return [{"id": old.id, "key": old.key, "status": "superseded", "value": old.value, "retracted": True}]


def apply_ops(uid: str, accepted: list[dict], decision_id: str) -> tuple[list[dict], list[dict]]:
    """把校验通过的操作写库。返回 (added, changed)。每条都留 revision。

    幂等：同 key 同 value 已存在时只补证据、不再新增行——同一轮重试不会重复计数（archive M7）。
    """
    added: list[dict] = []
    changed: list[dict] = []
    live_by_key: dict[str, list[UserFact]] = {}
    for f in store.list_facts(uid, statuses=list(DECISION_STATUSES)):
        live_by_key.setdefault(f.key, []).append(f)

    for op in accepted:
        spec = KeySpec(op["category"], op["cardinality"], tuple(_MODEL_SOURCES),
                       requires_valid_until=False)
        kind = op["op"]
        evidence = [{"type": "dialogue_turn", "quote": op["evidence_quote"], "decision_id": decision_id}]

        if kind == "add":
            dup = next((f for f in live_by_key.get(op["key"], []) if f.value == op["value"]), None)
            if dup is not None:
                changed += _retire(uid, op.get("retire_fact_id"), evidence, decision_id, keep=dup.id)
                store.update_fact(dup.id, evidence=list(dup.evidence) + evidence)
                store.add_revision(uid, fact_id=dup.id, operation="support", old_value=dup.value,
                                   new_value=dup.value, evidence=evidence, decision_id=decision_id)
                changed.append({"id": dup.id, "key": dup.key, "value": dup.value,
                                "status": dup.status, "supported": True})
                continue

            changed += _supersede_existing(uid, op["key"], spec, keep=None, decision_id=decision_id)
            fact = UserFact(
                user_id=uid, category=op["category"], key=op["key"], value=op["value"],
                confidence=op["confidence"], source=op["source"], evidence=evidence,
                status="confirmed", valid_until=op["valid_until"],
                affects=op.get("affects") or "",
            )
            store.add_fact(fact)
            store.add_revision(uid, fact_id=fact.id, operation="add", old_value=None,
                               new_value=fact.value, evidence=evidence, decision_id=decision_id)
            live_by_key.setdefault(op["key"], []).append(fact)
            added.append({**fact.to_dict(), "notes": op["notes"]})
            changed += _retire(uid, op.get("retire_fact_id"), evidence, decision_id)

        elif kind == "replace":
            target = store.get_fact(op["target_fact_id"] or "")
            if not target:
                continue
            old_value = target.value
            merged = list(target.evidence) + evidence
            # 来源、可信度、affects 也换成这次验过的：原来只换值，部分推断的新值还挂着旧的 user_edit / 1.0（Codex 复现）
            store.update_fact(target.id, value=op["value"], status="confirmed",
                              evidence=merged, valid_until=op["valid_until"],
                              source=op["source"], confidence=op["confidence"],
                              affects=op.get("affects") or target.affects or "")
            store.add_revision(uid, fact_id=target.id, operation="replace", old_value=old_value,
                               new_value=op["value"], evidence=evidence, decision_id=decision_id)
            changed.append({**(store.get_fact(target.id) or target).to_dict(),
                            "old_value": old_value, "notes": op["notes"]})

        elif kind == "support":
            target = store.get_fact(op["target_fact_id"] or "")
            if not target:
                continue
            merged = list(target.evidence) + evidence
            store.update_fact(target.id, evidence=merged)
            store.add_revision(uid, fact_id=target.id, operation="support", old_value=target.value,
                               new_value=target.value, evidence=evidence, decision_id=decision_id)
            changed.append({"id": target.id, "key": target.key, "value": target.value,
                            "status": target.status, "supported": True})

        elif kind == "retract":
            target = store.get_fact(op["target_fact_id"] or "")
            if not target:
                continue
            store.update_fact(target.id, status="superseded")
            store.add_revision(uid, fact_id=target.id, operation="retract", old_value=target.value,
                               new_value=None, evidence=evidence, decision_id=decision_id)
            changed.append({"id": target.id, "key": target.key, "status": "superseded",
                            "value": target.value, "retracted": True})

    return added, changed


# ---------- §4 召回 ----------


def active_facts(uid: str) -> list[UserFact]:
    """当前有效的事实：状态在白名单内且未过期。"""
    now = datetime.now(timezone.utc)
    return [f for f in store.list_facts(uid, statuses=list(DECISION_STATUSES))
            if not is_expired(f, now)]


def _terms(query: str) -> set[str]:
    return {t for t in re.split(r"[^\w\u4e00-\u9fff]+", (query or "").lower()) if len(t) >= 2}


def _relevance(f: UserFact, terms: set[str]) -> float:
    """层内排序用。只认多字词命中——原来那个「单字命中 0.05/字」在中文里
    会让一句话的每个字都命中一堆无关事实，基本是噪声，已去掉。"""
    text = f"{f.key} {f.value}".lower()
    hits = sum(1 for t in terms if t in text)
    if f.key.lower() in terms:
        hits += 1.5          # 用户原话直接点名了这个 key
    # 硬证据优先。层内坑位不够时，成绩单推出来的事实应该压过自述和推断——
    # 「修过 3 门数学类课程，加权平均 88.3」比「我觉得我数学还行」更该被看见。
    # 0.9 是刻意小于 1.0：相关度仍然能压过它（用户直接问到某个自述时，
    # 那条应该排前面），但同等相关度时硬证据赢。
    if f.source == "derived":
        hits += 0.9
    return float(hits)


# 项目属性的固定集合。顺序就是界面上的显示顺序。
# 它不只是显示用的排序表——下面 `_project_parts` 靠它来切分 key，
# 所以它是**格式定义**的一部分，增删要一起想。
PROJECT_ATTRS: tuple[str, ...] = ("what", "traction", "stage", "stack", "blocker", "next")
PROJECT_ATTR_LABEL = {"what": "是什么", "traction": "成果", "stage": "阶段",
                      "stack": "技术", "blocker": "卡点", "next": "下一步"}


def _project_parts(key: str) -> tuple[str, str]:
    """把 project:<实体>[.<属性>] 切成 (实体, 属性)。不是项目就返回 ("", "")。

    为什么不能简单按第一个点切：key 里**允许出现点**
    （`_SLUG_RE` 明确放行 `.` 和 `-`），所以
        project:my.app.blocker
    按第一个点切会得到实体 "my"、属性 "app.blocker"——
    于是 `project:my.app` 和 `project:my.other` 会塌成同一个项目，
    两张卡合成一张，属性互相串。
    按最后一个点切又会在 `project:kotoba.next` 上出错（实体变 "kotoba.next"）。

    做法：**只在最后一段是已知属性时才切**。这不是猜，是用格式定义消歧：
      project:kotoba.blocker → ("kotoba", "blocker")
      project:my.app         → ("my.app", "")        ← app 不是属性，整段是实体
      project:my.app.blocker → ("my.app", "blocker")
      project:my.app.why     → ("my.app.why", "")    ← 未知属性，整段当实体
                                                       （宁可建一张新卡，也不要把
                                                        两条无关的东西并到一起）
    """
    if not key.startswith("project:"):
        return "", ""
    rest = key.split(":", 1)[1]
    if not rest:
        return "", ""
    if "." in rest:
        head, _, tail = rest.rpartition(".")
        if head and tail in PROJECT_ATTRS:
            return head, tail
    return rest, ""


def _project_slug(key: str) -> str:
    """project:kotoba → kotoba；project:kotoba.blocker → kotoba；其它 → ""。"""
    return _project_parts(key)[0]


def _complete_project_groups(selected: list[UserFact], alive: list[UserFact]) -> list[UserFact]:
    """项目整卡进出。

    项目是整体：只知道「KotobaAI 是什么」而不知道「卡在哪」，会得出错误的下一步；
    反过来只知道卡点不知道是什么更糟。所以只要某项目有任何一条进了上下文，
    就把这个项目的全部属性一起带上——**允许超出该层预算**，这是有意的。

    这和「按相关度部分注入」不冲突：那条规则管的是**不同事实之间**谁该进来，
    项目内部则是一个整体，不能切。
    """
    slugs = {s for s in (_project_slug(f.key) for f in selected) if s}
    if not slugs:
        return selected
    have = {f.id for f in selected}
    extra = [f for f in alive
             if f.id not in have and _project_slug(f.key) in slugs]
    return selected + extra


def recall_grouped(uid: str, query: str = "",
                   budgets: dict[str, int] | None = None) -> tuple[dict[str, list[UserFact]], list[str]]:
    """按层召回，每层给固定预算。返回 ({layer: [facts]}, 被过滤的过期 id)。

    为什么不再用「平表按关键词取 top N」：全局抢坑位时，一门课的成绩可能挤掉他的方向，
    而且没有任何信号告诉模型「记忆被截断了」。按时间跨度分层后，身份/当前实践/约束
    这几层小且必带，倾向/经历按相关度填——这正是「不是全量注入，是每层给预算」。
    """
    facts = store.list_facts(uid, statuses=list(DECISION_STATUSES))
    now = datetime.now(timezone.utc)
    expired = [f.id for f in facts if is_expired(f, now)]
    alive = [f for f in facts if not is_expired(f, now)]
    caps = {**LAYER_BUDGET, **(budgets or {})}
    terms = _terms(query)

    grouped: dict[str, list[UserFact]] = {name: [] for name, _ in LAYERS}
    for name, _ in LAYERS:
        members = [f for f in alive if layer_of(f.key) == name]
        # 层内：相关度优先，其次新近——新近只在平局时起作用，不喧宾夺主。
        members.sort(key=lambda f: (_relevance(f, terms), f.created_at or ""), reverse=True)
        grouped[name] = _complete_project_groups(members[:caps.get(name, 4)], alive)
    return grouped, expired


def project_cards(uid: str) -> list[dict[str, Any]]:
    """把 project:* 聚成「一个项目一张卡」，给界面用。

    返回 [{slug, name, facts: [...]}]，属性按固定顺序排。
    存的时候是分开的事实，这里只做展示聚合——不改存储，所以证据、TTL、
    单独改删都还在每一条上。
    """
    facts = [f for f in store.list_facts(uid, statuses=list(DECISION_STATUSES))
             if _project_slug(f.key)]
    order = list(PROJECT_ATTRS)
    label = PROJECT_ATTR_LABEL
    by_slug: dict[str, list[UserFact]] = {}
    for f in facts:
        by_slug.setdefault(_project_slug(f.key), []).append(f)

    out = []
    for slug, group in by_slug.items():
        def attr_of(f: UserFact) -> str:
            return _project_parts(f.key)[1]

        def rank(f: UserFact) -> int:
            a = attr_of(f)
            return order.index(a) if a in order else len(order)

        group.sort(key=rank)
        # 项目名：优先实体那条（属性为空的那条），否则用 slug
        entity = next((f for f in group if not attr_of(f)), None)
        out.append({
            "slug": slug,
            "name": (entity.value if entity else slug) or slug,
            # 属性名要**从同一个切分函数**取，否则卡片名和分组会对不上
            # （这正是 my.app 那类 key 会踩的坑：一边切第一个点、一边切最后一个点）
            # 没有属性的那条是实体本身，显示成「是什么」。
            "attr_label": {f.id: (label.get(attr_of(f), "其它") if attr_of(f) else "是什么")
                           for f in group},
            "facts": group,
        })
    out.sort(key=lambda c: c["slug"])
    return out


def recall(uid: str, query: str, limit: int = 8) -> tuple[list[UserFact], list[str]]:
    """兼容旧签名：按层召回后拉平。limit 只作为兜底上限，不再决定选谁。"""
    grouped, expired = recall_grouped(uid, query)
    flat: list[UserFact] = []
    for name, _ in LAYERS:
        flat.extend(grouped.get(name) or [])
    return (flat[:limit] if limit and limit > 0 else flat), expired


# ---------- 用户自己看/改记忆 ----------
#
# 为什么用户能改：画像里的每一条都会影响之后给他的建议。如果一条是错的而他又看不见，
# 他只能吃下去——「个性化必须有依据」要求这个依据是可查、可纠正的。


def board(uid: str) -> dict[str, Any]:
    """按层返回全部生效记忆，供界面分列展示。每层附上「这层是干什么的」。"""
    now = datetime.now(timezone.utc)
    all_facts = store.list_facts(uid, statuses=list(DECISION_STATUSES))
    alive = [f for f in all_facts if not is_expired(f, now)]
    expired = [f for f in all_facts if is_expired(f, now)]

    layers = []
    for name, label in LAYERS:
        items = [f for f in alive if layer_of(f.key) == name]
        items.sort(key=lambda f: f.created_at or "")
        layers.append({
            "layer": name,
            "label": label,
            # hint 描述的是「这一层」，所以挂在层上；挂在每条 fact 上前端会取不到。
            "layer_hint": LAYER_HINT.get(name, ""),
            "facts": [{
                **f.to_dict(),
                "layer": name,
                "layer_label": label,
                "affects_label": AFFECT_LABELS.get(f.affects or "", ""),
            } for f in items],
        })
    return {
        "layers": layers,
        # 项目文件夹：一个项目一张卡。存的时候是分开的事实，这里只做展示聚合。
        "projects": project_cards(uid),
        "memory_version": store.get_memory_version(uid),
        "expired_count": len(expired),
        "expired": [{"id": f.id, "key": f.key, "value": f.value,
                     "valid_until": f.valid_until} for f in expired],
    }


LAYER_HINT: dict[str, str] = {
    "identity": "你是谁：年级、院系、专业。几乎不会变。",
    "practice": "你此刻手头在做的事。变化最快，过期后我会重新问。",
    "capability": "你的底子：数学、编程、学过的课。",
    "experience": "你实际完成过的事，只能由提交记录写入。",
    "interest": "你想往哪走：兴趣、目标、方向。",
    "constraint": "临时的限制，到点自动失效。",
}

# 提问阶梯。顺序 = LAYERS 的顺序，这里只写「问到什么算这层有数了」。
# 为什么要有阶梯：用户实测反馈「我只说了个大二，怎么跳过学校先问课程了」——
# 追问不自然，本质上就是**跳级**：还没弄清他是谁、在做什么，就问到了抽象偏好。
#
# 只放 allow-ask 的 key：gender/age 这类 ask=False 的不能算进「这层有数了没有」，
# 否则阶梯会一直卡在身份层等一个我们根本不该问的字段。
LADDER_PROBE: dict[str, tuple[str, ...]] = {
    # school 不在这里：默认北大，不问。department 要算——「我是信管的大二学生」
    # 已经答了「你是谁」，却因为只认 major 而被判成身份层还空着，模型就会接着
    # 问一个用户已经答过的问题（实测问出了「你是哪个学校的」）。
    "identity": ("grade", "department", "major", "enroll_year"),
    # project: 也算「在做什么」——一个在做的项目本身就是最实的当前实践
    "practice": ("current:", "project:", "research_group"),
    "capability": ("base:", "capability:"),
    "experience": ("experience:", "role:"),
    "interest": ("direction:", "goal:", "interest:", "field:", "pace"),
    "constraint": ("constraint:",),
}


def ladder_state(uid: str) -> dict[str, Any]:
    """各层「有数了没有」，以及最早一个还没数的层。

    代码只负责给出事实（哪层空着），**问还是不问、怎么问，交给模型**。
    这里刻意不做成硬闸门：问题是一句自由文本，靠关键词判它「在问哪一层」很脆，
    而且本轮只有两次模型调用，没有余量再去分类一次。
    所以设计是：**代码给真相，模型定措辞，评测管结果**。

    只有 `ask=True` 的 key 参与「这层有数了没有」的判断：
    `gender`/`age` 这种存得下但不该主动问的字段，不能把阶梯卡住。
    """
    alive = active_facts(uid)
    keys = [f.key for f in alive]
    layers = []
    for name, label in LAYERS:
        probes = LADDER_PROBE.get(name, ())
        # 属于这一层的全部 key（含 ask=False 的）
        in_layer = [k for k in keys if layer_of(k) == name]
        # 能靠「问」拿到的那部分——这些才决定阶梯走不走得下去
        hit = [k for k in in_layer
               if (spec_for(k) is None or spec_for(k).ask)
               and any(k == p or k.startswith(p) for p in probes)]
        layers.append({
            "layer": name,
            "label": label,
            "known": bool(hit),
            "have": hit[:4],
            # 有、但不靠问拿到的（例如用户主动说了性别）
            "stored_only": [k for k in in_layer if k not in hit][:4],
            "hint": LAYER_HINT.get(name, ""),
        })
    nxt = next((x["layer"] for x in layers if not x["known"]), None)
    return {
        "layers": layers,
        "next_layer": nxt,
        "next_label": (LAYER_LABELS.get(nxt, nxt) if nxt else None),
    }


def user_edit(uid: str, fact_id: str, value: str) -> dict[str, Any] | None:
    """用户亲手改一条记忆。返回改后的事实；不属于这个画像则返回 None。

    用户自己说的算最高可信（1.0）——他是关于自己的最终权威，
    这比模型从对话里推断出来的任何东西都硬。
    """
    f = store.get_fact(fact_id)
    if not f or f.user_id != uid:
        return None
    new_value = (value or "").strip()[:200]
    if not new_value:
        return None
    old = f.value
    evidence = list(f.evidence) + [{"type": "user_edit", "quote": new_value, "decision_id": ""}]
    store.update_fact(fact_id, value=new_value, status="confirmed", evidence=evidence)
    # 用户直接改的：来源升级为 user_edit，置信度 1.0，并且不再挂「模型推断」的标注。
    with store._LOCK, store._conn() as c:  # noqa: SLF001 — 单字段更新，避免为它开新 API
        c.execute("UPDATE facts SET source=?, confidence=?, affects=? WHERE id=?",
                  ("user_edit", 1.0, f.affects or "", fact_id))
    store.add_revision(uid, fact_id=fact_id, operation="replace", old_value=old,
                       new_value=new_value, evidence=evidence, decision_id="")
    store.bump_memory_version(uid)
    updated = store.get_fact(fact_id)
    return updated.to_dict() if updated else None


def user_retract(uid: str, fact_id: str) -> bool:
    """用户删掉一条记忆。不是硬删除：置为 retracted 并留 revision，可追溯。"""
    f = store.get_fact(fact_id)
    if not f or f.user_id != uid:
        return False
    store.retract_fact(fact_id)
    # 成绩单推出来的结论要额外记一笔「用户否掉了」。
    # 否则他删掉之后，下次成绩单一动，sync 会把它**原样加回来**——
    # 用户会发现自己删不掉一条系统认定的东西，这比少一条记忆糟得多。
    if str(f.key).startswith("transcript:"):
        store.add_revision(uid, fact_id=fact_id, operation="user_reject",
                           old_value=f.value, new_value=None,
                           evidence=list(f.evidence))
    store.bump_memory_version(uid)
    return True


# ---------- 从成绩单推导能力（transcript:*）----------

def sync_transcript_facts(uid: str) -> dict[str, Any]:
    """按当前成绩单重新推导 `transcript:*` 事实。**幂等**，可以反复调。

    增 / 改 / 撤 三件事一起做。撤这一步最要紧：
    成绩单改了之后，**过期的推导结论必须撤掉**。用户把那些课删了，
    而「他修过 3 门数学类课程」还留着——那比没有更糟，
    因为它看起来是**最硬的那类证据**，模型和用户都会信它。

    这条事实的 value 由 transcript.py 确定性拼出来（只写「修过哪几门、多少分、
    加权平均多少」），模型写不了（registry 里 sources=("derived",)）。
    这是 base:code 那起事故的正面修法：**能力不再是模型凭一段话编的判断。**
    """
    from schemas import UserFact  # 延迟导入，和其它写路径保持一致

    desired = {d["key"]: d for d in
               transcript.derive_capabilities(store.list_enrollments(uid))}
    # 同一个 key 可能有几条（老库）：原来只看最后一条，其余的永远不撤，删了课「Python 90」还挂着（Codex 复现）。
    # 每个 key 留一条（用户改过的优先），多出来的撤掉（用户改过的不动）。
    groups: dict[str, list] = {}
    for f in active_facts(uid):
        if str(f.key).startswith("transcript:"):
            groups.setdefault(str(f.key), []).append(f)
    existing = {}
    dup_removed: list[str] = []
    for key, fs in groups.items():
        fs.sort(key=lambda f: (f.source != "user_edit", str(f.created_at)))
        existing[key] = fs[0]
        for extra in fs[1:]:
            if extra.source == "user_edit":
                continue
            store.retract_fact(extra.id)
            store.add_revision(uid, fact_id=extra.id, operation="retract", old_value=extra.value,
                               new_value=None, evidence=list(extra.evidence))
            dup_removed.append(key)

    # 两种「用户已经表过态」的情况，sync 必须让路，否则就是系统在覆盖用户：
    #   1. 他改过这条 —— 来源变成 user_edit，他才是关于他自己的权威。
    #   2. 他删过这条 —— revision 里记了 user_reject，永久生效。
    # 让路的代价只是少一条注入的结论（成绩单还在，工具照样查得到）；
    # 不让路的代价是他发现有一条东西删不掉、也改不了。
    #
    # 注意两点：user_reject 是**按 key** 记的，不是按 fact id——
    # 用户否掉之后我们可能删掉旧行、以后又新建一行，id 会变，key 不会。
    # 另外被保护的 key 既不能加、不能改，**也不能撤**（他改过的那条要留着）。
    protected: set[str] = set()
    for rev in store.list_revisions(uid):
        if rev.get("operation") != "user_reject":
            continue
        f = store.get_fact(rev["fact_id"])
        if f and str(f.key).startswith("transcript:"):
            protected.add(str(f.key))
    for key, f in existing.items():
        if f.source == "user_edit":
            protected.add(key)

    added: list[str] = []
    updated: list[str] = []
    removed: list[str] = []

    for key, d in desired.items():
        if key in protected:
            continue
        evidence = [{"type": "transcript", **e} for e in d["enrollments"]]
        cur = existing.get(key)
        if cur is None:
            store.add_fact(UserFact(
                user_id=uid, category="capability", key=key, value=d["value"],
                confidence=_CONFIDENCE_BY_SOURCE["derived"], source="derived",
                evidence=evidence, status="active",
                affects=d["affects"]))
            store.add_revision(uid, fact_id=key, operation="derive", old_value=None,
                               new_value=d["value"], evidence=evidence)
            added.append(key)
        elif cur.value != d["value"]:
            store.update_fact(cur.id, value=d["value"], evidence=evidence)
            store.add_revision(uid, fact_id=cur.id, operation="replace",
                               old_value=cur.value, new_value=d["value"], evidence=evidence)
            updated.append(key)

    for key, f in existing.items():
        if key in protected or key in desired:
            continue
        # 「以前推得出来、现在推不出来」的正常过期
        store.retract_fact(f.id)
        store.add_revision(uid, fact_id=f.id, operation="retract",
                           old_value=f.value, new_value=None,
                           evidence=list(f.evidence))
        removed.append(key)

    if added or updated or removed or dup_removed:
        store.bump_memory_version(uid)
    return {"added": added, "updated": updated, "removed": removed,
            "protected": sorted(protected), "keys": sorted(desired)}
