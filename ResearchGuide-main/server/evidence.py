# -*- coding: utf-8 -*-
"""记忆写入的引文核对：模型按字段给结构化的值，代码只拿固定的表和规则去学生原话里对。

分工（docs/DIALOGUE_CONTRACT.md §7）：
- 模型负责抽：年级给（阶段, 第几年），数量给 {value, unit, per}，学校/院系/专业给名字，兴趣/目标抄原话；
- 代码负责对：原话里得有一处说法按这里的表解析出同一个值，而且这一处不在否定、过去、假设、改口的范围里。
表里没有的说法就算没有着落：漏记一条下次再问，记错一条会悄悄带偏之后每个决策。
不再给每种新说法补一条正则（十七轮审查一直在补）；新说法进表，范围规则只有一套。
所有扫描都是一遍过的、量词有上限：学生可能贴进来几万字。
"""
from __future__ import annotations

import bisect
import re
import unicodedata
from functools import lru_cache
from typing import Any, NamedTuple

# ---------- 预处理 ----------

_VULGAR = re.compile(r"(?:(\d{1,6})[ \t]?)?([¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])")
# 分数两头都得是完整的整数：「3.7/4.0」里的「7/4」不是分数
_SLASH = re.compile(r"(?<![\d.])(\d{1,3})[ \t]?[/⁄∕][ \t]?(\d{1,3})(?![\d.])")
_ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


def dec(x: float) -> str:
    return f"{x:.4f}".rstrip("0").rstrip(".")


def prep(text: str) -> str:
    """「1½」先整体算成 1.5（NFKC 会把它拼成「11⁄2」），再全角转半角、分数算成小数、英文转小写。
    之后所有位置都按这份文本算。"""
    t = _VULGAR.sub(lambda m: dec(int(m[1] or 0) + unicodedata.numeric(m[2])), str(text or ""))
    t = unicodedata.normalize("NFKC", t)
    t = _SLASH.sub(lambda m: dec(int(m[1]) / int(m[2])) if int(m[2]) else m[0], t)
    return t.translate(_ASCII_LOWER)


# ---------- 分句和范围 ----------

# 否定、过去、假设只管到这一分句为止；转折词也算断开（「以前是大一，现在大二」「不确定，但对 NLP 感兴趣」）
_BOUNDARY = re.compile(r"[,，。;；!！?？:：\n\r]|\.(?!\d)|(?<![a-z])(?:but|however|though|although|whereas|instead)(?![a-z])"
                       r"|但是|但|可是|不过|然而|而是|只是|却|现在|目前|如今")

NEG, PAST, IRREALIS, CORRECTED = "neg", "past", "irrealis", "corrected"
# 说的是不是他「现在的状态」：年级、学校院系、数量都要四样都不沾；兴趣和目标本来就是「想」，只查否定、过去、改口
STATE = frozenset({NEG, PAST, IRREALIS, CORRECTED})
WISH = frozenset({NEG, PAST, CORRECTED})

_EN_NEG = r"(?<![a-z])(?:not|no|never|neither|nor|without|except|cannot)(?![a-z])|n['’]t(?![a-z])"
_NEG_FWD = re.compile(r"不再是|并不是|也不是|并非|不是|不算|算不上|谈不上|称不上|从来没有|从来没|从没有|从没|从未|未曾|毫无|没有|没|不|除了|除去|而非|"
                      + _EN_NEG)
# 长得像否定、其实不是：程度和比较（不错、不到五小时）、关联词（不仅、不过）、客套、A不A 问句在下面单独判
_NEG_PSEUDO = re.compile(r"不错|不少|不同|不断|不仅|不只|不止|不但|不过|不管|不论|不久|不然|不如|不得不|不禁|不免|不到|不超过|不足|不低于|不少于|"
                         r"不多于|不高于|不对|不好意思|不客气|没错|没关系|没事|没准|毫无疑问|除了.{0,8}?(?:还|也)|"
                         r"not only|not just|no matter|no doubt")
# 双重否定：「不是不喜欢」「没有不想学的」——两个都不算
_NEG_DOUBLE = re.compile(r"(?:不是|并非|并不是|没有|不能|不会|不可能|不可)[ \t]?(?:不|没)")
# 外层「不是」管着的范围里又有一个否定，而且不是「也不是」这种并列：「我不是对人工智能没有兴趣」
_NEG_COPULA = ("不是", "并不是", "并非", "不再是")
_COORD = re.compile(r"也|又|还|、|和|或|及")
# 后置的否定：「对机器学习没有兴趣」「Python 我没学过」——只在分句末尾时往前管，管到这一分句开头或最近的「对」
_NEG_BACK = re.compile(r"(?:没有?|毫无|不太?|并不|一点都不|一点也不|都不|也不)(?:什么|太大|多大|啥|太多|很大)?"
                       r"(?:兴趣|感兴趣|喜欢|想学|想做|想碰|想搞|考虑|打算|会|懂|熟|熟悉|了解|学过|碰过|接触过|用过|写过|做过|好|行|擅长|在行|熟练|扎实|精通)"
                       r"|(?:兴趣|好感)(?:都|也)?(?:没有?|不大)|无感|没感觉|不感冒|算了|一窍不通")
_TAIL = re.compile(r"[了啊吧呢的呀哈过吗嘛啦哦耶 \t~～…]*")
_PAST = re.compile(r"以前|之前|原来|原本|本来|去年|前年|曾经|当时|那时|那会儿?|上学期|上个学期|小时候|"
                   r"(?<![a-z])(?:used to|last year|previously|formerly|back then|was|were)(?![a-z])")
_PAST_PSEUDO = re.compile(r"本来就|原来如此|原来是这样")
_IRREALIS = re.compile(r"(?<![思理感联回猜幻梦构妄])想(?!法)|打算|准备|计划|希望|将来|以后|未来|毕业后|如果|假如|要是|万一|争取|考虑|申请|报考|"
                       r"考研|保研|(?<![a-z])(?:want|wants|plan|plans|hope|hopes|going to|will|would|if|apply|applying)(?![a-z])")
# 改口：「大二，哦打错了我是大三」「我大二，不对，我大三」。「打错」这类在哪都算；「不对」「错了」只在分句开头算（「作业错了三题」不是改口）
_CORR_ANY = re.compile(r"打错|说错|写错|输错|口误|笔误|更正一下|纠正一下|(?<![a-z])(?:i meant|typo|correction)(?![a-z])")
_CORR_HEAD = re.compile(r"[哦噢啊呃嗯额哎诶唉 \t]*(?:不对|错了|说反了|sorry)(?=$|[我是应其啊吧呢哦嗯 \t])")
_INTERJ = re.compile(r"[哦噢啊呃嗯额哎诶唉 \t]*")


class Scope(NamedTuple):
    start: int
    end: int
    kind: str
    cue_start: int
    cue_end: int


class Scan(NamedTuple):
    text: str
    clauses: list[tuple[int, int]]
    scopes: list[Scope]
    by_cue: list[int]          # scopes 按 cue_start 排好的下标，找「提示词在这一处里面」用
    cue_starts: list[int]      # 和 by_cue 一一对应的 cue_start，二分用
    cover: dict[str, list[int]]  # 每种范围覆盖到每个位置的个数（差分数组求和）


def _clauses(t: str) -> list[tuple[int, int]]:
    out, prev = [], 0
    for m in _BOUNDARY.finditer(t):
        out.append((prev, m.start()))
        prev = m.end()
    out.append((prev, len(t)))
    return out


def _clause_at(clauses: list[tuple[int, int]], starts: list[int], pos: int) -> int:
    return max(0, bisect.bisect_right(starts, pos) - 1)


def _neg_cues(t: str) -> list[tuple[int, int]]:
    """真的否定词（去掉看着像的、A不A 问句、双重否定）。"""
    cues, cancelled = [], set()
    for m in _NEG_FWD.finditer(t):
        s, e = m.span()
        if s in cancelled or _NEG_PSEUDO.match(t, s) or (t[s] in "不没" and 0 < s and t[s - 1:s] == t[s + 1:s + 2]) \
                or (t[s] == "不" and t[s - 1:s] in ("差", "了", "要")):
            continue
        d = _NEG_DOUBLE.match(t, s)
        if d:
            cancelled.add(d.end() - 1)
            continue
        cues.append((s, e))
    return cues


@lru_cache(maxsize=32)  # 同一轮几条 op 共用一句原话；每条要存几个和原话一样长的数组，别多存
def scan(text: str) -> Scan:
    """把原话分句，标出否定、过去、假设、改口各自管到哪里。text 必须已经 prep 过。"""
    t = text
    clauses = _clauses(t)
    starts = [a for a, _ in clauses]
    scopes: list[Scope] = []

    def clause_of(pos: int) -> tuple[int, int]:
        return clauses[_clause_at(clauses, starts, pos)]

    des = [i for i, c in enumerate(t) if c == "的"]

    def fwd_end(e: int, cut_de: bool) -> int:
        end = clause_of(e)[1]
        if cut_de:  # 「不需要太多数学的机器学习」：否定管不到「的」后面被修饰的那个词
            k = bisect.bisect_left(des, e)
            if k < len(des) and des[k] < end:
                end = des[k]
        return end

    neg = _neg_cues(t)
    neg_starts = [s for s, _ in neg]
    dead = set()
    for i, (s, e) in enumerate(neg):  # 外层「不是」里面又有否定、中间不是并列 → 两个都不算
        if t[s:e] not in _NEG_COPULA:
            continue
        end = fwd_end(e, True)
        j = bisect.bisect_left(neg_starts, e)
        if j < len(neg) and neg[j][0] < end and not _COORD.search(t, e, neg[j][0]):
            dead.update((i, j))
    dead_at = {p for i in dead for p in range(*neg[i])}
    for i, (s, e) in enumerate(neg):
        if i not in dead:
            scopes.append(Scope(e, fwd_end(e, True), NEG, s, e))
    for m in _NEG_BACK.finditer(t):
        s, e = m.span()
        a, b = clause_of(s)
        if _TAIL.fullmatch(t, e, b) and s not in dead_at:
            dui = t.rfind("对", a, s)
            scopes.append(Scope(dui if dui != -1 else a, s, NEG, s, e))
    for m in _PAST.finditer(t):
        if not _PAST_PSEUDO.match(t, m.start()):
            scopes.append(Scope(m.end(), fwd_end(m.end(), False), PAST, m.start(), m.end()))
    for m in _IRREALIS.finditer(t):
        scopes.append(Scope(m.end(), fwd_end(m.end(), False), IRREALIS, m.start(), m.end()))
    for k, (a, b) in enumerate(clauses):
        h = _CORR_HEAD.match(t, a, b)
        if h and k > 0:
            scopes.append(Scope(clauses[k - 1][0], clauses[k - 1][1], CORRECTED, a, h.end()))
    for m in _CORR_ANY.finditer(t):
        k = _clause_at(clauses, starts, m.start())
        a = clauses[k][0]
        if _INTERJ.fullmatch(t, a, m.start()) and k > 0:
            a = clauses[k - 1][0]
        scopes.append(Scope(a, m.start(), CORRECTED, m.start(), m.end()))

    cover: dict[str, list[int]] = {}
    for kind in (NEG, PAST, IRREALIS, CORRECTED):
        diff = [0] * (len(t) + 1)
        for sc in scopes:
            if sc.kind == kind and sc.end > sc.start:
                diff[sc.start] += 1
                diff[sc.end] -= 1
        run, acc = 0, []
        for x in diff:
            run += x
            acc.append(run)
        cover[kind] = acc
    by_cue = sorted(range(len(scopes)), key=lambda i: scopes[i].cue_start)
    return Scan(t, clauses, scopes, by_cue, [scopes[i].cue_start for i in by_cue], cover)


def affirmed(sc: Scan, start: int, end: int, kinds: frozenset[str]) -> bool:
    """这一处（start..end）不在给定的几种范围里。提示词本身在这一处里面的不算（「不确定性量化」里的「不」）。"""
    lo, hi = bisect.bisect_left(sc.cue_starts, start), bisect.bisect_left(sc.cue_starts, end)
    cues = [c for c in (sc.scopes[i] for i in sc.by_cue[lo:hi]) if c.cue_end <= end]
    for p in range(start, max(end, start + 1)):
        if p >= len(sc.text):
            break
        n = sum(sc.cover[k][p] for k in kinds)
        if n and n > sum(1 for c in cues if c.kind in kinds and c.start <= p < c.end):
            return False
    return True


_POST_PAST = re.compile(r"的?(?:时候|时|那会儿?|那年|期间|毕业)")


def is_current(sc: Scan, start: int, end: int, kinds: frozenset[str] = STATE) -> bool:
    """说的是现在：不在否定/过去/假设/改口里，后面也没跟「的时候」「毕业」。"""
    if PAST in kinds and _POST_PAST.match(sc.text, end):
        return False
    return affirmed(sc, start, end, kinds)


def has_negation(text: str) -> bool:
    t = prep(text)
    return bool(_neg_cues(t) or _NEG_BACK.search(t))


# ---------- 年级：固定的表 ----------

STAGES = ("本科", "硕士", "博士", "高中")
_MAX_YEAR = {"本科": 6, "硕士": 3, "博士": 6, "高中": 3, None: 6}
_STAGE_OF = {"本科": "本科", "本科生": "本科", "本": "本科", "大学": "本科", "大学生": "本科", "大": "本科",
             "undergrad": "本科", "undergraduate": "本科", "bachelor": "本科", "college": "本科", "university": "本科",
             "硕士": "硕士", "硕士生": "硕士", "硕士研究生": "硕士", "硕": "硕士", "研究生": "硕士", "研": "硕士", "读研": "硕士",
             "master": "硕士", "masters": "硕士", "master's": "硕士", "graduate": "硕士", "grad": "硕士",
             "博士": "博士", "博士生": "博士", "博士研究生": "博士", "博": "博士", "读博": "博士", "在读博": "博士",
             "phd": "博士", "ph.d": "博士", "ph.d.": "博士", "doctoral": "博士", "doctorate": "博士",
             "高中": "高中", "高中生": "高中", "高": "高中"}
_YEAR_OF = {c: i + 1 for i, c in enumerate("一二三四五六")} | {str(i): i for i in range(1, 7)} | \
           {w: i + 1 for i, w in enumerate(("first", "second", "third", "fourth", "fifth", "sixth"))} | \
           {w: i + 1 for i, w in enumerate(("1st", "2nd", "3rd", "4th", "5th", "6th"))}
_Y = "[一二三四五六1-6]"
_NOT_COUNT = r"(?![0-9.个门项次篇倍月天周小分万千百十点些统])"  # 「大2个」「大一点」不是年级
_EN_STAGE = r"undergrad(?:uate)?|ph\.?d\.?|doctoral|master'?s|masters|graduate|grad|college|university"
# （正则, 阶段：固定值或取自第几组, 年份所在组）
_GRADE_FORMS: tuple[tuple[re.Pattern, Any, int | None], ...] = (
    (re.compile(r"(?<![最很较更太超扩放增加伟强远广宏盛重巨庞北])大[ \t]?(" + _Y + ")" + _NOT_COUNT), "本科", 1),
    (re.compile(r"(?<![钻科考保读攻])研[ \t]?(" + _Y + ")" + _NOT_COUNT), "硕士", 1),
    (re.compile(r"硕[ \t]?(" + _Y + ")" + _NOT_COUNT), "硕士", 1),
    (re.compile(r"(?<![赌])博[ \t]?(" + _Y + ")" + _NOT_COUNT), "博士", 1),
    (re.compile(r"(?<![提升身最很较更太增拔])高[ \t]?(" + _Y + ")" + _NOT_COUNT), "高中", 1),
    # 「本科二年级」「本科第2年」「本科二年」；「本科四年里」是学制不是年级
    (re.compile(r"(本科|大学|研究生|硕士|博士|高中)[ \t]?(?:第[ \t]?)?(" + _Y + r")[ \t]?(?:年级|年(?![代份级里内中制间期来半多前后左]))"), 1, 2),
    # 「二年级」「二年级的研究生」
    (re.compile(r"(?<![0-9一二三四五六七八九十])(" + _Y + r")[ \t]?年级(?:[ \t]?的?[ \t]?(本科生|研究生|硕士生|博士生|本科|硕士|博士))?"), 2, 1),
    (re.compile(r"第[ \t]?(" + _Y + r")[ \t]?年(?![代份度级])"), None, 1),
    (re.compile(r"本科生|本科|大学生|硕士研究生|硕士生|硕士|研究生|博士研究生|博士生|博士(?!后)|在读博(?!士后)|读博(?!士后)|读研|高中生|高中"), 0, None),
    (re.compile(r"(?<![a-z])(freshman|sophomore|junior|senior)(?![a-z])"), "本科", 1),
    # 英文：只看紧跟在 year 后面的阶段词（「not first-year, I am a sophomore」不吞后面的）；PhD 优先于 graduate
    (re.compile(r"(?<![a-z])(first|second|third|fourth|fifth|sixth|1st|2nd|3rd|4th|5th|6th)[ \t-]?year(?![a-z])"
                r"((?:[ \t-]{1,3}(?:" + _EN_STAGE + r")(?![a-z])){0,3})(?:[ \t]{1,3}(?:student|candidate))?"), 2, 1),
    (re.compile(r"(?<![a-z])year[ \t]?([1-6])(?![0-9])((?:[ \t-]{1,3}(?:" + _EN_STAGE + r")(?![a-z])){0,3})"), 2, 1),
    (re.compile(r"(?<![a-z])(undergrad(?:uate)?|ph\.?d\.?|doctoral|master'?s|masters|graduate|grad)(?:[ \t]{1,3}(?:student|candidate))(?![a-z])"), 1, None),
    (re.compile(r"(?<![a-z])(undergrad(?:uate)?|ph\.?d\.?)(?![a-z])"), 1, None),
)
_EN_RANK = {"freshman": 1, "sophomore": 2, "junior": 3, "senior": 4}


class Grade(NamedTuple):
    stage: str | None
    year: int | None
    start: int
    end: int


def _stage_word(words: str) -> str | None:
    if re.search(r"ph\.?d|doctoral", words):
        return "博士"
    if re.search(r"undergrad|college|university", words):
        return "本科"
    if re.search(r"master|graduate|grad", words):
        return "硕士"
    return None


def grade_mentions(t: str) -> list[Grade]:
    """原话（已 prep）里按表认得出的每一处年级说法；互相包含的只留最长那处。"""
    found: list[Grade] = []
    for rx, stage, ygroup in _GRADE_FORMS:
        for m in rx.finditer(t):
            word = m.group(ygroup) if ygroup else None
            year = _EN_RANK.get(word or "") or _YEAR_OF.get(word or "")
            if stage == 0:
                st = _STAGE_OF.get(m.group(0))
            elif isinstance(stage, int):
                g = m.group(stage) or ""
                st = _STAGE_OF.get(g) or _stage_word(g)
            else:
                st = stage
            if year and year > _MAX_YEAR[st]:
                continue
            found.append(Grade(st, year, m.start(), m.end()))
    found.sort(key=lambda g: (g.start, -(g.end - g.start)))
    out: list[Grade] = []
    for g in found:
        if not any(o.start <= g.start and g.end <= o.end and (o.end - o.start) > (g.end - g.start) for o in out[-4:]):
            out.append(g)
    return out


def current_grades(text: str) -> list[Grade]:
    t = prep(text)
    sc = scan(t)
    return [g for g in grade_mentions(t) if is_current(sc, g.start, g.end)]


BAD = object()  # 结构化的值形状不对


def _year(v: Any) -> int | None | object:
    if v is None:
        return None
    if isinstance(v, bool):
        return BAD
    if isinstance(v, int):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, str) and v.strip() in _YEAR_OF:
        return _YEAR_OF[v.strip()]
    return BAD


def parse_grade(value: Any) -> tuple[str | None, int | None] | None | object:
    """{"stage", "year"} 或者一个整句就是年级的字符串（「大二」「本科二年级」「sophomore」）→（阶段, 第几年）。
    字符串认不出、或者年级后面还夹着别的（「本科二年级，GPA4.0」）→ None；字典形状不对 → BAD。"""
    if isinstance(value, dict):
        if not value or set(value) - {"stage", "year"}:
            return BAD
        st, yr = value.get("stage"), _year(value.get("year"))
        if st is not None:
            if not isinstance(st, str):
                return BAD
            st = _STAGE_OF.get(prep(st).strip())
            if st is None:
                return BAD
        if yr is BAD or (st is None and yr is None) or (yr is not None and not 1 <= yr <= _MAX_YEAR[st]):
            return BAD
        return st, yr
    t = re.sub(r"(?:在读|学生|在读生)$", "", prep(str(value or "")).strip()).strip()
    ms = grade_mentions(t)
    if len(ms) == 1 and ms[0].start == 0 and ms[0].end == len(t):
        return ms[0].stage, ms[0].year
    if len(ms) > 1 and all(m.start == 0 or t[ms[0].end:m.start].strip() == "" for m in ms) and ms[-1].end == len(t) \
            and len({(m.stage, m.year) for m in ms}) == 1:
        return ms[0].stage, ms[0].year
    return None


def render_grade(stage: str | None, year: int | None) -> str:
    cn = "一二三四五六"
    if stage and year:
        return {"本科": "大", "硕士": "研", "博士": "博", "高中": "高"}[stage] + cn[year - 1]
    return stage or f"{cn[(year or 1) - 1]}年级"


def grade_supported(stage: str | None, year: int | None, quote: str) -> bool:
    """原话里有一处说的是现在的年级，阶段和第几年都对得上。值写了第几年，原话就得说了同一年；
    原话没说阶段（「二年级」「second-year」）只撑得住本科（本产品默认本科生）或不写阶段的值。"""
    for g in current_grades(quote):
        if year is not None and g.year != year:
            continue
        if stage is None or g.stage == stage or (g.stage is None and stage == "本科"):
            return True
    return False


# ---------- 数量：数 + 单位 ----------

# 单位 → (量纲, 换成该量纲基本单位的倍数)。钟点按分钟、日历按天、月和年按月：一天不等于 24 小时的投入，一个月也不是 30 天
_UNIT: dict[str, tuple[str, float]] = {
    "秒": ("clock", 1 / 60), "秒钟": ("clock", 1 / 60), "分钟": ("clock", 1), "分": ("clock", 1), "min": ("clock", 1),
    "mins": ("clock", 1), "minute": ("clock", 1), "minutes": ("clock", 1), "小时": ("clock", 60), "钟头": ("clock", 60),
    "钟": ("clock", 60), "h": ("clock", 60), "hr": ("clock", 60), "hrs": ("clock", 60), "hour": ("clock", 60), "hours": ("clock", 60),
    "天": ("day", 1), "日": ("day", 1), "day": ("day", 1), "days": ("day", 1), "周": ("day", 7), "星期": ("day", 7),
    "礼拜": ("day", 7), "week": ("day", 7), "weeks": ("day", 7),
    "月": ("month", 1), "month": ("month", 1), "months": ("month", 1), "年": ("month", 12), "year": ("month", 12), "years": ("month", 12),
    "学期": ("term", 1), "semester": ("term", 1), "semesters": ("term", 1),
    "岁": ("age", 1), "周岁": ("age", 1), "years old": ("age", 1), "year old": ("age", 1), "yrs old": ("age", 1),
    "学分": ("credit", 1), "credits": ("credit", 1), "credit": ("credit", 1), "%": ("pct", 1), "percent": ("pct", 1), "倍": ("times", 1),
    "级": ("level", 1),
}
COUNTERS = ("个", "门", "项", "篇", "次", "期", "章", "节", "页", "题", "人", "本", "道", "场", "份")
_UNIT.update({c: ("count", 1) for c in COUNTERS})
_UNIT_MAX = max(map(len, _UNIT))
_PER_WORD = {"周": "w", "星期": "w", "礼拜": "w", "week": "w", "天": "d", "日": "d", "day": "d", "月": "mo", "month": "mo",
             "年": "y", "year": "y", "学期": "term", "semester": "term"}
_EN_NUM = {w: i for i, w in enumerate(("zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
                                        "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
                                        "eighteen", "nineteen", "twenty"))} | {"thirty": 30, "forty": 40, "fifty": 50, "sixty": 60}
_TOKEN = re.compile(r"半(?=[ \t]?(?:个[ \t]?)?(?:小时|钟头|天|年|月|学期|周|星期))|\d{1,9}(?:\.\d{1,4})?|[零〇一二两三四五六七八九十百千万几]{1,12}|(?<![a-z])(?:" + "|".join(_EN_NUM) + r")(?![a-z])")
_RANGE = re.compile(r"[ \t]?(?:到|至|~|～|-|—|–|或)[ \t]?")
_MOD = re.compile(r"[ \t]?(多|来|余)?(个)?(多)?(半)?[ \t]?")
_JOIN = re.compile(r"[ \t]?(?:零|又)?[ \t]?")
_PER_BEFORE = re.compile(r"每[ \t]?(?:个)?(周|星期|礼拜|天|日|月|年|学期)|[一1][ \t]?(?:个)?(周|星期|礼拜|天|月)(?:里|内|中|下来)?|(周|日|月)均"
                         r"|(?<![a-z])(?:per|every|a|each)[ \t](week|day|month|semester)(?![a-z])|(?<![a-z])(week|dai)ly(?![a-z])")
_PER_AFTER = re.compile(r"[ \t]?(?:/|每|一|per |a |an |each )(?:个)?(周|星期|礼拜|天|日|月|学期|week|day|month|semester)")
_AGE_CTX = re.compile(r"(?:今年|年龄|年纪|虚岁|周岁|age|aged|i'm|i am)[ \t:]?(?:是|有|才|刚|已经)?[ \t]?$")
_CN_D = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
_CN_MUL = {"十": 10, "百": 100, "千": 1000}


class Qty(NamedTuple):
    lo: float          # 原样的数（换算前）
    hi: float
    dim: str           # "" = 没带单位
    base_lo: float     # 换成量纲基本单位后的数
    base_hi: float
    label: str         # 单位原样（计数单位门/篇/个之间要分开）
    per: str           # 「每周」= w；没说 = ""
    start: int
    end: int
    ctx: str = ""      # 没带单位、但跟在「今年」「年龄」后面 = "age"


def _cn_value(run: str) -> tuple[float, float] | None:
    """中文数：「十九」「二十一」「两千零二十四」「二〇二四」；「三四」「两三」是范围、「十几」是 11 到 19。认不出返回 None。"""
    if "几" in run:
        m = re.fullmatch(r"([一二两三四五六七八九]?)十几", run)
        if not m:
            return None
        d = _CN_D[m[1]] if m[1] else 1
        return d * 10 + 1, d * 10 + 9
    if all(c in _CN_D for c in run):
        if len(run) == 1:
            return float(_CN_D[run]), float(_CN_D[run])
        a, b = _CN_D[run[0]], _CN_D[run[1]]
        if len(run) == 2 and b == a + 1 and a > 0:
            return float(a), float(b)
        n = int("".join(str(_CN_D[c]) for c in run))
        return float(n), float(n)
    m = re.fullmatch(r"([一二两三四五六七八九])([一二两三四五六七八九])十", run)
    if m and _CN_D[m[2]] == _CN_D[m[1]] + 1:
        return _CN_D[m[1]] * 10.0, _CN_D[m[2]] * 10.0
    total = section = cur = 0
    for c in run:
        if c in _CN_D:
            cur = _CN_D[c]
        elif c in _CN_MUL:
            section += (cur or 1) * _CN_MUL[c]
            cur = 0
        elif c == "万":
            total += (section + cur or 1) * 10000
            section = cur = 0
        else:
            return None
    n = float(total + section + cur)
    return n, n


def _tok_value(tok: str) -> tuple[float, float] | None:
    if tok == "半":  # 「半小时」「半个月」
        return 0.5, 0.5
    if tok[0].isdigit():
        return float(tok), float(tok)
    if tok in _EN_NUM:
        return float(_EN_NUM[tok]), float(_EN_NUM[tok])
    return _cn_value(tok)


def _unit_at(t: str, pos: int) -> str:
    for n in range(min(_UNIT_MAX, len(t) - pos), 0, -1):
        u = t[pos:pos + n]
        if u in _UNIT and not (u[-1].isascii() and u[-1].isalpha() and t[pos + n:pos + n + 1].isascii()
                               and t[pos + n:pos + n + 1].isalpha()):
            if u == "年" and t[pos + 1:pos + 2] in ("级", "代", "份", "度"):
                return ""
            return u
    return ""


def _per_before(t: str, start: int, clause_start: int) -> str:
    """数前面不远处的「每周」「一天」「weekly」；中间隔着别的数就不算这个数的（「每周2小时，总共20周」）。"""
    last = None
    for m in _PER_BEFORE.finditer(t, max(clause_start, start - 10), start):
        last = m
    if last is None or _TOKEN.search(t, last.end(), start):
        return ""
    word = next(g for g in last.groups() if g)
    return "d" if word == "dai" else _PER_WORD.get(word, "")


def quantities(text: str) -> list[Qty]:
    """原话里的每个「数 + 单位」。复合时长（「一小时二十分钟」）只算总数；范围两头都算；没带单位的阿拉伯数字也算，
    中文数要带单位、在括号里或跟在「今年」后面才算（「一些」不是 1）。逐个数往后看，不回溯。"""
    t = prep(text)
    clauses = _clauses(t)
    starts = [a for a, _ in clauses]
    out: list[Qty] = []
    skip_to = 0
    for m in _TOKEN.finditer(t):
        s, e = m.span()
        if s < skip_to:
            continue
        tok = m.group()
        val = _tok_value(tok)
        if val is None or (tok == "十" and t[e:e + 1] == "分" and t[e + 1:e + 2] != "钟"):  # 「十分喜欢」
            continue
        lo, hi = val
        pos = e
        r = _RANGE.match(t, pos)
        if r:
            m2 = _TOKEN.match(t, r.end())
            v2 = _tok_value(m2.group()) if m2 else None
            if v2 is not None:
                hi, pos = v2[1], m2.end()
        mod = _MOD.match(t, pos)
        half = 0.5 if mod.group(4) else 0.0
        upos = mod.end()
        unit = _unit_at(t, upos)
        if not unit and mod.group(4) is None:
            upos, unit = pos, _unit_at(t, pos)
        if half and not unit:
            half, unit = 0.0, ""
        lo, hi = lo + half, hi + half
        k = _clause_at(clauses, starts, s)
        cl_a, cl_b = clauses[k]
        if not unit:
            bracketed = t[s - 1:s] in ("(", "（") and t[pos:pos + 1] in (")", "）")
            age = bool(_AGE_CTX.search(t, max(cl_a, s - 8), s))
            spelled = len(tok) >= 2 and any(c in "十百千万" for c in tok)  # 「两百」「二十」没单位也是数；「一些」不是
            if tok[0].isdigit() or bracketed or age or spelled:
                year = tok.isdigit() and len(tok) == 4 and 1900 <= lo <= 2100  # 「2024入学」
                out.append(Qty(lo, hi, "", lo, hi, "", "", s, pos, "age" if age else "calyear" if year else ""))
            skip_to = pos
            continue
        dim, factor = _UNIT[unit]
        end = upos + len(unit)
        if t[s - 3:s] == "百分之":
            dim, factor = "pct", 1
        if unit == "年" and lo == hi and lo.is_integer() and 1900 <= lo <= 2100:
            dim, factor = "calyear", 1
        elif unit == "级" and lo >= 10:
            dim, factor = "calyear", 1
            lo, hi = (lo + 2000 if lo < 100 else lo), (hi + 2000 if hi < 100 else hi)
        if dim in ("clock", "day", "month") and t[end:end + 1] == "半" and not half:  # 「一年半」「两天半」
            lo, hi, end = lo + 0.5, hi + 0.5, end + 1
        base_lo, base_hi = lo * factor, hi * factor
        # 复合时长：后面紧跟同一量纲、更小的单位（「一小时二十分钟」「一年零三个月」）→ 合成一个总数
        j = _JOIN.match(t, end)
        m3 = _TOKEN.match(t, j.end())
        if m3 and lo == hi and dim in ("clock", "day", "month"):
            v3 = _tok_value(m3.group())
            mod3 = _MOD.match(t, m3.end())
            u3 = _unit_at(t, mod3.end())
            if v3 and u3 and _UNIT[u3][0] == dim and _UNIT[u3][1] < factor and v3[0] == v3[1]:
                base_lo = base_hi = base_lo + v3[0] * _UNIT[u3][1]
                end = mod3.end() + len(u3)
                lo = hi = base_lo / factor
        per = _per_before(t, s, cl_a)
        pa = _PER_AFTER.match(t, end)
        if not per and pa:
            per = _PER_WORD.get(pa.group(1), "")
        out.append(Qty(lo, hi, dim, base_lo, base_hi, unit, per, s, end))
        skip_to = end
    return out


def _close(a: float, b: float) -> bool:
    return abs(a - b) <= 0.005  # 只容下四位小数的舍入（⅓ 小时 = 19.998 分钟）；按比例容差会让 2023 等于 2024


def qty_match(want: Qty, have: Qty, strict: bool = False) -> bool:
    """want（值里的）和 have（原话里的）是不是同一个量。值的每一头都得是原话那一处的一头。
    strict：结构化的数量字段（年龄、入学年份、每周时间），量纲必须一样，不认「值带单位、原话光一个数」。"""
    if not want.dim:
        ends = {have.lo, have.hi}
        return any(_close(want.lo, x) for x in ends) and any(_close(want.hi, x) for x in ends)
    if not have.dim:
        if strict and have.ctx != want.dim:
            return False
        ends = {have.lo, have.hi}
        return any(_close(want.lo, x) for x in ends) and any(_close(want.hi, x) for x in ends)
    if want.dim != have.dim:
        return False
    if want.dim == "count" and want.label != have.label and "个" not in (want.label, have.label):
        return False  # 「个」和别的量词互通，「门」和「篇」不通
    if want.per and have.per and want.per != have.per:
        return False
    ends = (have.base_lo, have.base_hi)
    return any(_close(want.base_lo, x) for x in ends) and any(_close(want.base_hi, x) for x in ends)


def numbers_supported(value: str, quote: str) -> bool:
    """值里写的每个数，原话里都得有同一个数、单位对得上（值没写单位就只比数）。"""
    have = quantities(quote)
    return all(any(qty_match(w, h) for h in have) for w in quantities(value))


# ---------- 实体：学校、院系、专业 ----------

# 学校名 → 常见叫法。只收确定的简称；「交大」「中大」「南大」一叫多校，不收
SCHOOLS: dict[str, tuple[str, ...]] = {
    "北京大学": ("北大", "pku", "peking university"), "清华大学": ("清华", "thu", "tsinghua"),
    "复旦大学": ("复旦", "fudan"), "上海交通大学": ("上交", "上海交大", "sjtu"), "浙江大学": ("浙大", "zju"),
    "中国科学技术大学": ("中科大", "ustc"), "南京大学": ("nju",), "中国人民大学": ("人民大学", "人大", "ruc"),
    "北京航空航天大学": ("北航", "buaa"), "北京师范大学": ("北师大", "bnu"), "北京理工大学": ("北理工", "北理"),
    "武汉大学": ("武大", "whu"), "华中科技大学": ("华科", "华中科大", "hust"), "南开大学": ("南开",), "同济大学": ("同济",),
    "西安交通大学": ("西交", "西安交大", "xjtu"), "哈尔滨工业大学": ("哈工大",), "中山大学": ("sysu",), "厦门大学": ("厦大",),
    "四川大学": ("川大",), "山东大学": ("山大",), "吉林大学": ("吉大",), "东南大学": (), "天津大学": ("天大",),
    "中国科学院大学": ("国科大", "ucas"), "香港大学": ("港大", "hku"), "香港中文大学": ("港中文", "cuhk"),
    "香港科技大学": ("港科大", "hkust"), "国立台湾大学": ("台大",), "新加坡国立大学": ("新国立", "nus"),
    "麻省理工学院": ("mit",), "斯坦福大学": ("斯坦福", "stanford"), "哈佛大学": ("哈佛", "harvard"),
    "加州大学伯克利分校": ("伯克利", "berkeley"), "卡内基梅隆大学": ("cmu",), "牛津大学": ("牛津", "oxford"),
    "剑桥大学": ("剑桥", "cambridge"),
}
# 简称藏在别的校名里：「东北大学」里有「北大」
_CONFUSABLE = {"北大": ("东北大学", "西北大学", "湖北大学", "河北大学", "华北大学", "北大荒"), "人大": ("人大代表",),
               "山大": ("中山大学", "山大学"), "天大": ("天大学",), "华科": (), "同济": ()}
# 学科词本身不是院系：「我喜欢数学」不能撑「数学科学学院」，得是「数学系」「数学学院」「数学专业」
_SUBJECTS = {"数学", "物理", "化学", "生物", "经济", "法学", "心理", "社会", "社会学", "历史", "历史学", "哲学", "艺术", "新闻",
             "中文", "外国语", "信息管理", "信息科学技术", "政府管理", "工学", "考古"}
_DEPT_SUFFIX = ("系", "学院", "院", "专业", "的学生")


def _school_of(v: str) -> str | None:
    for name, short in SCHOOLS.items():
        if v == name or v in short:
            return name
    return None


def _depts() -> set[str]:
    import curriculum
    out = set()
    for c in curriculum.cards():
        out.update(x for x in str(c.get("院系") or "").split("/") if x)
    return out


def _dept_of(v: str) -> str | None:
    import curriculum
    depts = _depts()
    if v in depts:
        return v
    if curriculum.DEPT_ALIAS.get(v) in depts:
        return curriculum.DEPT_ALIAS[v]
    hit = [d for d in depts if len(v) >= 2 and v in d]
    return hit[0] if len(hit) == 1 else None


def _major_names(v: str) -> set[str]:
    import curriculum
    names: set[str] = set()
    for c in curriculum.cards():
        ns = {n for n in (c.get("专业", ""), c.get("目录专业名", ""), *c.get("检索别名", [])) if n}
        ns |= {n.replace("专业", "") for n in ns}
        if v in ns or v + "专业" in ns:
            names |= ns
    return {n for n in names if len(n) >= 2}


def entity_forms(key: str, value: str) -> tuple[str | None, set[str]]:
    """学校/院系/专业的值 →（库里的规范名，原话里可以出现的叫法）。库里没有的，只认原样。"""
    v = re.sub(r"\s+", "", prep(value))
    if key == "school":
        name = _school_of(v)
        return name, ({prep(name), *SCHOOLS[name]} if name else {v})
    if key == "department":
        import curriculum
        name = _dept_of(v)
        if not name:
            return None, {v}
        return name, {name, *(k for k, d in curriculum.DEPT_ALIAS.items() if d == name)}
    names = _major_names(v)
    return (v, names) if names else (None, {v})


def _find(t: str, form: str) -> list[tuple[int, int]]:
    """form 在 t 里出现的每一处：中文字之间可以夹一两个空格，英文要有词界。"""
    form = form.strip()
    if not form:
        return []
    body = "[ \t]{0,2}".join(re.escape(c) for c in form if not c.isspace())
    if form.isascii():
        body = r"(?<![a-z0-9])" + body + r"(?![a-z0-9])"
    return [m.span() for m in re.finditer(body, t)]


def entity_occurrences(key: str, value: str, quote: str) -> list[tuple[int, int]]:
    t = prep(quote)
    _, forms = entity_forms(key, value)
    out = []
    for f in forms:
        for s, e in _find(t, f):
            if key == "school" and any(t.find(c, max(0, s - len(c)), e + len(c)) != -1 for c in _CONFUSABLE.get(f, ())):
                continue
            if key == "department" and f in _SUBJECTS and not t.startswith(_DEPT_SUFFIX, e):
                continue
            out.append((s, e))
    return out


# ---------- 原话片段：兴趣、目标 ----------

# 同一样东西的几种叫法。值抄原话最好；写成这里的另一种叫法也认
ALIAS_GROUPS: tuple[tuple[str, ...], ...] = (
    ("ai", "人工智能"), ("ml", "机器学习"), ("nlp", "自然语言处理"), ("cv", "计算机视觉"), ("rl", "强化学习"),
    ("dl", "深度学习"), ("llm", "llms", "大模型", "大语言模型"), ("hci", "人机交互"), ("econ", "经济学"),
    ("cs", "计算机科学", "计算机"), ("读研", "读研究生", "读硕士", "读硕"), ("读博", "读博士", "攻读博士", "phd"),
    ("出国", "留学", "出国留学"), ("就业", "工作", "找工作"),
)


def _has(text: str, form: str) -> bool:
    return bool(_find(text, form))


def span_forms(value: str) -> set[str]:
    """值本身，加上把里面的缩写换成同组别的叫法（「AI安全」也找「人工智能安全」）。"""
    v = re.sub(r"\s+", " ", prep(value)).strip()
    forms = {v}
    for group in ALIAS_GROUPS:
        for a in group:
            if not _has(v, a):
                continue
            for f in list(forms)[:8]:
                for b in group:
                    if b != a:
                        forms.add(re.sub((r"(?<![a-z0-9])" + re.escape(a) + r"(?![a-z0-9])") if a.isascii() else re.escape(a), b, f))
    return forms


def span_occurrences(value: str, quote: str) -> list[tuple[int, int]]:
    t = prep(quote)
    return sorted({o for f in span_forms(value) for o in _find(t, f)})


def runs(value: str) -> list[str]:
    """值里能拿去原话里找的片段：两个字以上的连续中文、两个字母以上的英文词。"""
    return [r for r in re.findall(r"[一-鿿]{2,}|[a-z][a-z0-9+#.]{1,}", prep(value)) if r]


def anchors(value: str, quote: str, min_len: int = 4) -> list[str]:
    """值和原话共有的片段：从左往右每次取原话里也有的最长一段中文（至少 min_len 个字），加上原话里也有的英文词。"""
    t = prep(quote)
    out = []
    for r in runs(value):
        if r.isascii():
            if _has(t, r):
                out.append(r)
            continue
        i = 0
        while i <= len(r) - min_len:
            j = i + min_len
            if r[i:j] not in t:
                i += 1
                continue
            while j < len(r) and r[i:j + 1] in t:
                j += 1
            out.append(r[i:j])
            i = j
    return out
