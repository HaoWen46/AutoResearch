/* 启研 · 前端（无构建、经典脚本；设计规范 docs/DESIGN_SPEC.md）
   对话页的结构约定见 审计与方案/09-对话前端框架.md —— 改样式前先读那一篇，
   里面写清了哪些是「结构契约」（不能动）、哪些是「视觉表现」（随便换）。 */
"use strict";

/* ---------- 状态 ---------- */

const S = {
  uid: localStorage.getItem("rg_uid") || "",
  token: localStorage.getItem("rg_token") || "",
  nickname: localStorage.getItem("rg_nick") || "",
  wechat: false,
  guest: true,
  auth: null,
  view: "home",
  resume: "login",
  onboard: { facts: [], messages: [] },
  lastTask: null,
  lastFeedback: null,
  newFactIds: [],
  portraitTab: "dialogue",
  cardsPane: "direction",
  kitId: localStorage.getItem("rg_kit") || "",
  readTab: "kit",
  cardId: "",
  posTab: "edges",
  posDraft: null,
  mapSort: "order",
};

/* ---------- 进 HTML 之前先消毒 ----------
   页面里大约一百六十处把字符串当 HTML 塞进去（innerHTML、el() 的第三个参数）。里面有模型写的理由、
   学生粘的成绩单课名、外面抓来的论文标题。Codex 用一个 <img onerror> 课名就让脚本跑起来了。
   逐处 esc 是本分（下面也逐处补了），这里再兜一层：所有写 innerHTML 的地方都先在一个不会执行的
   <template> 里解析，删掉脚本类元素、on* 事件属性、javascript: 之类的链接，再放进页面。
   我们没有第三方前端库，所以直接接管 Element 的 innerHTML 写入是安全的。 */
const HTML_BLOCK = new Set(["SCRIPT", "IFRAME", "FRAME", "OBJECT", "EMBED", "LINK", "META", "BASE", "STYLE", "FORM", "NOSCRIPT", "TEMPLATE"]);
const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "poster", "background", "srcset"]);
const SAFE_URL = /^(?:https?:|mailto:|#|\/(?!\/)|\.{0,2}\/|data:image\/(?:png|jpe?g|gif|webp);)/i;
const _htmlSetter = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML").set;

function sanitizeInto(holder, html) {
  const t = document.createElement("template");
  _htmlSetter.call(t, String(html ?? ""));  // template 的内容是惰性的：脚本不跑、图片不加载
  t.content.querySelectorAll("*").forEach((n) => {
    if (HTML_BLOCK.has(n.tagName.toUpperCase())) { n.remove(); return; }
    for (const a of [...n.attributes]) {
      const name = a.name.toLowerCase();
      const value = a.value.replace(/[\u0000- ]/g, "");
      if (name.startsWith("on") || name === "srcdoc" || name === "formaction"
        || (URL_ATTRS.has(name) && value && !SAFE_URL.test(value))) {
        n.removeAttribute(a.name);
      }
    }
  });
  return t.content;
}

Object.defineProperty(Element.prototype, "innerHTML", {
  configurable: true,
  get: Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML").get,
  set(html) {
    // template 本身、SVG 里的元素（模板按 HTML 解析会把 <path> 变成普通元素）走原生写法；页面里的 SVG 都是 createElementNS 画的
    if (this instanceof HTMLTemplateElement || this.namespaceURI !== "http://www.w3.org/1999/xhtml") {
      _htmlSetter.call(this, html);
      return;
    }
    if (html === "" || html == null) { this.textContent = ""; return; }
    this.replaceChildren(sanitizeInto(this, html));
  },
});
Element.prototype.insertAdjacentHTML = function (where, html) {
  const frag = sanitizeInto(this, html);  // 直接放消过毒的节点，不再序列化后重新解析
  const at = String(where).toLowerCase();
  if (at === "beforebegin") this.before(frag);
  else if (at === "afterbegin") this.prepend(frag);
  else if (at === "beforeend") this.append(frag);
  else if (at === "afterend") this.after(frag);
  else throw new SyntaxError(`insertAdjacentHTML: ${where}`);
};

const $app = document.getElementById("app");
const $nav = document.getElementById("mainNav");
const $header = document.getElementById("headerRight");

/* ---------- API ---------- */

/* 后端报错体可能是字符串、数组或对象——FastAPI 的 422 detail 是数组。
   直接 String() 会变成 "[object Object]"，曾经把「缺 action_id」显示成这个，白白多花时间排查。
   这里统一成人能读的一句话。 */
function errText(data, status) {
  const d = data && data.detail;
  if (typeof d === "string" && d) return d;
  if (Array.isArray(d)) {
    const parts = d.map((x) => (typeof x === "string" ? x : x && (x.msg || x.message)))
      .filter(Boolean);
    if (parts.length) return parts.join("；");
  }
  if (d && typeof d === "object") {
    try { return JSON.stringify(d); } catch (_) { /* 循环引用等，落到下面 */ }
  }
  return `请求失败 (${status})`;
}

/* 接口地址：同源部署时为空。页面放在 GitHub Pages、接口在别的域名时，index.html 里先设 window.QIYAN_API。 */
const API_BASE = String(window.QIYAN_API || "").replace(/\/$/, "");
function apiUrl(path) { return API_BASE + path; }

/* 登录凭证是会话令牌，放在请求头里（页面和接口不同源，cookie 会被浏览器拦）。
   所有请求都走 apiFetch；接口回 401 说明令牌失效了（退出、过期、删号），回到登录页。 */
function authHeaders(extra) {
  const h = Object.assign({}, extra || {});
  if (S.token && !h.Authorization) h.Authorization = `Bearer ${S.token}`;  // 调用方指定了就用调用方的（吊销旧令牌时）
  return h;
}

/* 吊销一个已经不用的令牌（比如访客令牌换成微信登录的新令牌之后）。失败也无所谓：它最多三十天后自己过期。 */
function revokeToken(token) {
  if (!token) return;
  apiFetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
}

async function apiFetch(path, opt = {}) {
  const res = await fetch(apiUrl(path), { ...opt, headers: authHeaders(opt.headers) });
  if (res.status === 401 && S.token && !path.startsWith("/api/auth/")) signedOut("登录过期了，请重新登录");
  return res;
}

async function api(method, path, body) {
  const opt = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await apiFetch(path, opt);
  let data = null;
  try { data = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) {
    const err = new Error(errText(data, res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- 工具 ---------- */

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(msg, ms = 2600) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = el("div", "toast", esc(msg));
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
const CAT_CN = { background: "背景", interest: "兴趣", capability: "能力", preference: "偏好", experience: "经历" };
const SRC_CN = { declared: "自述", inferred: "推断", behavior: "行为" };

const WORKSPACE = {
  today: "today",
  dialogue: "portrait",
  confirm: "portrait",
  cards: "cards",
  workbench: "workbench",
  projects: "projects",
  project: "projects",
  position: "position",
  read: "read",
  card: "read",
  me: "me",
};

/* ---------- 视图切换 ---------- */

function setView(name) {
  S.view = name;
  if (name === "dialogue" || name === "confirm") S.portraitTab = name;
  document.body.dataset.view = name;
  const home = name === "home";
  const inApp = !home && name !== "login" && !!S.uid;
  document.body.classList.toggle("is-home", home);
  document.body.classList.toggle("app-mode", inApp);
  if (!home && stopField) { stopField(); stopField = null; }
  if (name !== "cards") document.getElementById("nodeSheet")?.remove();
  document.querySelectorAll(".nav-btn").forEach((b) => {
    const on = b.dataset.workspace === WORKSPACE[name];
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    b.disabled = !S.uid;
  });
  $nav.hidden = !inApp;
  $header.hidden = !inApp;
  render();
  window.scrollTo({ top: 0 });
}

/* 每次切换视图都有一个序号。异步渲染在每个 await 之后用 stale(seq) 检查：
   用户已经切走了，就不再往页面上写，避免两个视图叠在一起。 */
function stale(seq) {
  return seq !== S.renderSeq;
}

async function render() {
  S.renderSeq = (S.renderSeq || 0) + 1;
  if (S.view === "home") { renderHome(); return; }
  if (!S.uid && S.view !== "login") { renderLogin(); return; }
  switch (S.view) {
    case "login": renderLogin(); break;
    case "dialogue": ChatView.render($app); break;
    case "confirm": await renderConfirm(); break;
    case "cards": await renderCards(); break;
    case "workbench": await renderWorkbench(); break;
    case "projects": await renderProjects(); break;
    case "project": await renderProject(); break;
    case "position": await renderPosition(); break;
    case "read": await renderRead(); break;
    case "card": await renderCard(); break;
    case "me": await renderMe(); break;
    case "today":
    default: await renderToday(); break;
  }
}

/* ---------- 首页：六屏下滑，点线图随滚动重画 ---------- */

const HOME_PAGES = [
  {
    kicker: "启研 · AI RESEARCH MENTOR",
    title: "先认识你，<br>再走下一步。",
    lead: "面向本科一、二年级。它不是问答框，而是一条可以回头看的科研入门。",
    hint: "向下滚动",
  },
  {
    kicker: "01",
    title: "问答画像",
    lead: "几轮对话，勾出你现在的位置、基础和好奇。它只记你自己说的，不替你编一段人设。",
    points: [
      ["位置", "年级、专业，或者你现在停在哪一步。"],
      ["基础", "已经会的，和明确还没碰过的。"],
      ["好奇", "想试的问题。说不清也可以选「不知道」，它会如实记下。"],
    ],
  },
  {
    kicker: "02",
    title: "方向推荐",
    lead: "直接给出此刻值得试的方向。每条都要能对上你刚说过的话，不拿通用介绍来凑。",
    points: [
      ["为什么是你", "理由引用你的原话，至少对上位置、基础或好奇中的一件。"],
      ["真实课程", "从北大教务公开课里找。找不到就说找不到，不编课名和老师。"],
      ["入门读物", "先给读得动的那一篇，用来上手，不是一份书单。"],
    ],
  },
  {
    kicker: "03",
    title: "小任务",
    lead: "方向先不展开成阅读清单。它只给你一件二十分钟内能做完的事。",
    points: [
      ["做完", "读一小节、跑一个小例子，或回答一个具体问题。"],
      ["留下", "一段话、一张图或一个输出。结果要能被看见。"],
      ["记下", "实际做了什么，写回你的画像。"],
    ],
  },
  {
    kicker: "04",
    title: "获取反馈",
    lead: "按事先说好的标准逐条看你的提交。评价的是这件事做成了没有，不是你这个人。",
    points: [
      ["对事", "只看这一次交上来的内容，不推测你的潜力。"],
      ["标准", "做到哪条、缺哪条，分开写，并指出下一步改哪里。"],
      ["证据", "没有结果，就明确说缺证据。"],
    ],
  },
  {
    kicker: "05",
    title: "持续成长",
    lead: "记住这次证据，再决定下一件最值得做的事。下一步仍然只是一件事，不是一份新计划。",
    points: [
      ["认识", "你说过的位置、基础和好奇还在，不用每次从头介绍。"],
      ["记住", "反馈写回画像，下一次先看这些证据再开口。"],
      ["再下一步", "只给一件最值得做的事。做完，再进入下一轮。"],
    ],
  },
];

let stopField = null;

function renderHome() {
  if (stopField) stopField();
  $app.innerHTML = "";
  const land = el("div", "land");
  const canvas = el("canvas", "land-field");
  canvas.setAttribute("aria-hidden", "true");
  const snap = el("div", "land-snap");
  HOME_PAGES.forEach((page, i) => {
    const sec = el("section", "snap");
    sec.dataset.index = String(i);
    const points = (page.points || [])
      .map(([k, v]) => `<li><b>${k}</b><span>${v}</span></li>`).join("");
    sec.innerHTML = `<p class="hero-kicker">${page.kicker}</p><h2>${page.title}</h2>`
      + `<p class="land-lead">${page.lead}</p>`
      + (points ? `<ul class="land-points">${points}</ul>` : "")
      + (page.hint ? `<p class="snap-hint">${page.hint}</p>` : "");
    if (i === HOME_PAGES.length - 1) {
      const btn = el("button", "btn land-cta", "立即开始体验");
      btn.type = "button";
      btn.onclick = beginExperience;
      sec.appendChild(btn);
    }
    snap.appendChild(sec);
  });
  const rail = el("div", "fella-index");
  rail.appendChild(el("span", "fella-mark"));
  HOME_PAGES.forEach((page, i) => {
    const b = el("button", "fella-no" + (i === 0 ? " on" : ""), String(i).padStart(2, "0"));
    b.type = "button";
    b.setAttribute("aria-label", `第 ${i + 1} 屏`);
    b.onclick = () => {
      const sec = snap.querySelectorAll(".snap")[i];
      snap.scrollTo({ top: sec ? sec.offsetTop : 0, behavior: "smooth" });
    };
    rail.appendChild(b);
  });
  const progress = el("div", "home-progress");
  progress.appendChild(el("i"));
  land.append(canvas, snap, rail, progress);
  $app.appendChild(land);
  stopField = mountSketch(canvas, snap, rail, progress);
}

function beginExperience() {
  if (stopField) stopField();
  if (S.uid) {
    document.getElementById("userNickname").textContent = S.nickname || "";
    setView("today");
    return;
  }
  setView("login");
}

/* 图形：[-1, 1] 坐标系，y 向下。每张图是若干笔画（折线），accent 笔画用主色。
   粒子按笔画顺序均匀排布，换图时第 i 颗粒子从旧图第 i 个位置走到新图第 i 个位置，
   看起来像一支笔把旧图擦掉、再把新图画出来。 */

function unitHash(i, salt) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function arcPts(cx, cy, r, a0, a1, n = 48) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * (i / n);
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

function ring(cx, cy, r, n = 72) {
  return arcPts(cx, cy, r, 0, Math.PI * 2, n);
}

function curve(a, b, bend = 0.5) {
  const pts = [];
  const mx = a[0] + (b[0] - a[0]) * bend;
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const u = 1 - t;
    pts.push([
      u * u * u * a[0] + 3 * u * u * t * mx + 3 * u * t * t * mx + t * t * t * b[0],
      u * u * u * a[1] + 3 * u * u * t * a[1] + 3 * u * t * t * b[1] + t * t * t * b[1],
    ]);
  }
  return pts;
}

function rrect(x0, y0, x1, y1, r) {
  const pts = [];
  [[x1 - r, y0 + r, -Math.PI / 2, 0], [x1 - r, y1 - r, 0, Math.PI / 2],
    [x0 + r, y1 - r, Math.PI / 2, Math.PI], [x0 + r, y0 + r, Math.PI, Math.PI * 1.5]]
    .forEach(([cx, cy, a0, a1]) => arcPts(cx, cy, r, a0, a1, 8).forEach((p) => pts.push(p)));
  pts.push(pts[0]);
  return pts;
}

function bubble(x0, y0, x1, y1, r, tx, dir) {
  // 圆角气泡，尾巴开在底边 tx 处，dir = -1 朝左下，1 朝右下
  const pts = [];
  const corner = (cx, cy, a0, a1) => arcPts(cx, cy, r, a0, a1, 8).forEach((p) => pts.push(p));
  corner(x0 + r, y0 + r, Math.PI, Math.PI * 1.5);
  corner(x1 - r, y0 + r, -Math.PI / 2, 0);
  corner(x1 - r, y1 - r, 0, Math.PI / 2);
  pts.push([tx + 0.1, y1], [tx + dir * 0.12 + (dir > 0 ? 0.1 : 0), y1 + 0.16], [tx - 0.02, y1]);
  corner(x0 + r, y1 - r, Math.PI / 2, Math.PI);
  pts.push(pts[0]);
  return pts;
}

const SKETCHES = [
  // 00 台阶通向一扇门：先认识你，再走下一步
  () => {
    const door = [[0.22, 0.12], [0.22, -0.46], ...arcPts(0.5, -0.46, 0.28, Math.PI, Math.PI * 2, 32), [0.78, 0.12]];
    const inner = [[0.3, 0.12], [0.3, -0.44], ...arcPts(0.5, -0.44, 0.2, Math.PI, Math.PI * 2, 28), [0.7, 0.12]];
    const stairs = [[-0.95, 0.74], [-0.62, 0.74], [-0.62, 0.53], [-0.3, 0.53], [-0.3, 0.32], [0.02, 0.32], [0.02, 0.12], [0.95, 0.12]];
    return [
      { pts: stairs },
      { pts: door },
      { pts: inner, accent: true },
      { pts: ring(-0.46, 0.38, 0.05, 20), accent: true },
    ];
  },
  // 01 一问一答的两个气泡
  () => {
    const q = [...arcPts(-0.36, -0.5, 0.1, Math.PI * 1.05, Math.PI * 2.25, 28), [-0.36, -0.33], [-0.36, -0.28]];
    return [
      { pts: bubble(-0.92, -0.78, 0.18, -0.12, 0.12, -0.62, -1) },
      { pts: q, accent: true },
      { pts: ring(-0.36, -0.2, 0.018, 8), accent: true },
      { pts: bubble(-0.18, 0.06, 0.92, 0.62, 0.12, 0.56, 1) },
      { pts: [[0.0, 0.22], [0.72, 0.22]] },
      { pts: [[0.0, 0.34], [0.6, 0.34]] },
      { pts: [[0.0, 0.46], [0.38, 0.46]] },
    ];
  },
  // 02 罗盘：指针指向一个方向
  () => {
    const out = [{ pts: ring(0, 0.04, 0.74, 96) }];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 - Math.PI / 2;
      const r0 = k % 2 === 0 ? 0.6 : 0.66;
      out.push({ pts: [[Math.cos(a) * r0, 0.04 + Math.sin(a) * r0], [Math.cos(a) * 0.74, 0.04 + Math.sin(a) * 0.74]] });
    }
    const a = -Math.PI / 4;
    const tip = (ang, r) => [Math.cos(ang) * r, 0.04 + Math.sin(ang) * r];
    const n = tip(a, 0.52);
    const s = tip(a + Math.PI, 0.52);
    const l = tip(a - Math.PI / 2, 0.1);
    const rr = tip(a + Math.PI / 2, 0.1);
    out.push({ pts: [l, n, rr], accent: true });
    out.push({ pts: [l, s, rr] });
    out.push({ pts: ring(0, 0.04, 0.035, 12) });
    out.push({ pts: [[-0.05, -0.8], [-0.05, -0.96], [0.05, -0.8], [0.05, -0.96]] });
    return out;
  },
  // 03 秒表：二十分钟
  () => {
    const c = [0, 0.14];
    const out = [
      { pts: ring(c[0], c[1], 0.66, 96) },
      { pts: [[0, -0.52], [0, -0.62]] },
      { pts: rrect(-0.11, -0.76, 0.11, -0.62, 0.03) },
      { pts: [[0.47, -0.36], [0.55, -0.44]] },
    ];
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 - Math.PI / 2;
      const r0 = k % 3 === 0 ? 0.5 : 0.56;
      out.push({ pts: [[c[0] + Math.cos(a) * r0, c[1] + Math.sin(a) * r0], [c[0] + Math.cos(a) * 0.62, c[1] + Math.sin(a) * 0.62]] });
    }
    out.push({ pts: arcPts(c[0], c[1], 0.4, -Math.PI / 2, Math.PI / 6, 40), accent: true });
    out.push({ pts: [c, [c[0] + Math.cos(Math.PI / 6) * 0.44, c[1] + Math.sin(Math.PI / 6) * 0.44]], accent: true });
    out.push({ pts: ring(c[0], c[1], 0.03, 12) });
    return out;
  },
  // 04 一页提交，逐条打勾
  () => {
    const page = [[-0.58, -0.8], [0.2, -0.8], [0.44, -0.56], [0.44, 0.8], [-0.58, 0.8], [-0.58, -0.8]];
    const out = [{ pts: page }, { pts: [[0.2, -0.8], [0.2, -0.56], [0.44, -0.56]] }];
    [-0.3, 0.02, 0.34].forEach((y, i) => {
      if (i < 2) out.push({ pts: [[-0.42, y], [-0.35, y + 0.07], [-0.22, y - 0.08]], accent: true });
      else out.push({ pts: ring(-0.33, y, 0.06, 20) });
      out.push({ pts: [[-0.1, y], [0.28, y]] });
    });
    out.push({ pts: [[-0.42, 0.6], [0.1, 0.6]] });
    return out;
  },
  // 05 一棵往右长的树，走过的路用主色
  () => {
    const R = [-0.82, 0.06];
    const A = [-0.3, -0.38];
    const B = [-0.3, 0.5];
    const A1 = [0.24, -0.64];
    const A2 = [0.24, -0.12];
    const B1 = [0.24, 0.34];
    const B2 = [0.24, 0.74];
    const C1 = [0.8, -0.34];
    const C2 = [0.8, 0.1];
    const node = (p, r, accent) => ({ pts: ring(p[0], p[1], r, 24), accent });
    const edge = (a, b, accent) => ({ pts: curve([a[0] + 0.06, a[1]], [b[0] - 0.06, b[1]]), accent });
    return [
      node(R, 0.06, true), edge(R, A, true), node(A, 0.055, true), edge(A, A2, true), node(A2, 0.055, true),
      edge(A2, C2, true), node(C2, 0.05, true),
      edge(A, A1), node(A1, 0.05), edge(A2, C1), node(C1, 0.05),
      edge(R, B), node(B, 0.055), edge(B, B1), node(B1, 0.05), edge(B, B2), node(B2, 0.05),
    ];
  },
];

function strokeLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

function sampleSketch(strokes, n) {
  // 沿全部笔画等距取 n 个点；返回 {xy, acc}，顺序即笔画顺序
  const lens = strokes.map((s) => strokeLength(s.pts));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const xy = new Float32Array(n * 2);
  const acc = new Uint8Array(n);
  let k = 0;
  strokes.forEach((s, si) => {
    const want = si === strokes.length - 1 ? n - k : Math.max(2, Math.round((lens[si] / total) * n));
    const count = Math.min(want, n - k);
    let seg = 1;
    let walked = 0;
    for (let j = 0; j < count; j++) {
      const d = count === 1 ? 0 : (j / (count - 1)) * lens[si];
      while (seg < s.pts.length - 1 && walked + Math.hypot(s.pts[seg][0] - s.pts[seg - 1][0], s.pts[seg][1] - s.pts[seg - 1][1]) < d) {
        walked += Math.hypot(s.pts[seg][0] - s.pts[seg - 1][0], s.pts[seg][1] - s.pts[seg - 1][1]);
        seg += 1;
      }
      const a = s.pts[seg - 1];
      const b = s.pts[seg];
      const sl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const t = Math.min(1, Math.max(0, (d - walked) / sl));
      xy[k * 2] = a[0] + (b[0] - a[0]) * t;
      xy[k * 2 + 1] = a[1] + (b[1] - a[1]) * t;
      acc[k] = s.accent ? 1 : 0;
      k += 1;
    }
  });
  return { xy, acc, length: total };
}

function scrollTarget(scroller) {
  // 每屏前 40% 停住不动（读字），40%–85% 之间换图，之后停在新图上
  const secs = [...scroller.querySelectorAll(".snap")];
  const st = scroller.scrollTop;
  let a = 0;
  while (a < secs.length - 2 && st >= secs[a + 1].offsetTop) a += 1;
  const span = Math.max(1, secs[a + 1].offsetTop - secs[a].offsetTop);
  const raw = (st - secs[a].offsetTop) / span;
  const t = Math.min(1, Math.max(0, (raw - 0.4) / 0.45));
  return Math.min(secs.length - 1, a + t);
}

function mountSketch(canvas, scroller, rail, progress) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const nos = [...rail.querySelectorAll(".fella-no")];
  const mark = rail.querySelector(".fella-mark");
  const bar = progress.querySelector("i");
  const INK = "rgb(237, 241, 238)";
  const ACCENT = "rgb(127, 209, 194)";
  let W = 0; let H = 0; let cx = 0; let cy = 0; let size = 0; let dot = 1.35;
  let figs = [];
  let N = 0;
  let shown = [];
  let phase = 0;
  let target = 0;
  let intro = still ? 1 : 0;
  let raf = 0;
  let introStart = 0;

  const build = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const narrow = W < 920;
    size = narrow ? Math.min(W * 0.34, H * 0.2) : Math.min(H * 0.32, W * 0.2);
    cx = narrow ? W * 0.5 : W * 0.66;
    cy = narrow ? H * 0.27 : H * 0.5;
    dot = narrow ? 1.15 : 1.35;
    const spacing = narrow ? 4.2 : 4.6;
    const raws = SKETCHES.map((f) => f());
    const need = raws.map((st) => Math.ceil((st.reduce((s, x) => s + strokeLength(x.pts), 0) * size) / spacing));
    N = Math.max(...need);
    figs = raws.map((st, k) => {
      const f = sampleSketch(st, N);
      // 每张图只点亮 need[k] 颗，保证各图点距一致；其余粒子跟着走但不可见
      const vis = new Uint8Array(N);
      for (let j = 0; j < need[k]; j++) vis[Math.floor((j * N) / need[k])] = 1;
      f.vis = vis;
      return f;
    });
    shown = Array.from({ length: N }, (_, i) => {
      const ang = unitHash(i, 2) * Math.PI * 2;
      const rad = 1.2 + unitHash(i, 3) * 0.9;
      return [Math.cos(ang) * rad, Math.sin(ang) * rad];
    });
  };

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    const a = Math.min(figs.length - 1, Math.floor(phase));
    const b = Math.min(figs.length - 1, a + 1);
    const T = phase - a;
    const A = figs[a];
    const B = figs[b];
    const introE = ease(intro);
    let lastStyle = "";
    for (let i = 0; i < N; i++) {
      const f = i / N;
      const local = still ? (T > 0.5 ? 1 : 0) : ease(Math.min(1, Math.max(0, (T - f * 0.35) / 0.65)));
      const ax = A.xy[i * 2]; const ay = A.xy[i * 2 + 1];
      const bx = B.xy[i * 2]; const by = B.xy[i * 2 + 1];
      let x = ax + (bx - ax) * local;
      let y = ay + (by - ay) * local;
      const lift = Math.sin(Math.PI * local);
      if (lift > 0.001) {
        const dx = bx - ax; const dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        const amp = (0.08 + unitHash(i, 7) * 0.14) * (unitHash(i, 9) > 0.5 ? 1 : -1) * lift;
        x += (-dy / len) * amp;
        y += (dx / len) * amp;
      }
      if (introE < 1) {
        x = shown[i][0] + (x - shown[i][0]) * Math.min(1, Math.max(0, (intro - f * 0.3) / 0.7));
        y = shown[i][1] + (y - shown[i][1]) * Math.min(1, Math.max(0, (intro - f * 0.3) / 0.7));
      }
      const vis = A.vis[i] + (B.vis[i] - A.vis[i]) * local;
      const alpha = vis * (1 - 0.35 * lift) * Math.min(1, intro * 1.4);
      if (alpha < 0.03) continue;
      const style = (local < 0.5 ? A.acc[i] : B.acc[i]) ? ACCENT : INK;
      if (style !== lastStyle) { ctx.fillStyle = style; lastStyle = style; }
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(cx + x * size, cy + y * size, dot * (1 - 0.2 * lift), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  const syncRail = () => {
    const active = Math.min(nos.length - 1, Math.round(phase));
    nos.forEach((d, i) => d.classList.toggle("on", i === active));
    if (mark && nos[active]) mark.style.transform = `translateY(${nos[active].offsetTop}px)`;
    const limit = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    if (bar) bar.style.width = `${Math.min(1, scroller.scrollTop / limit) * 100}%`;
  };

  const tick = (now) => {
    raf = 0;
    if (!canvas.isConnected) return;
    let moving = false;
    if (intro < 1) {
      if (!introStart) introStart = now;
      intro = Math.min(1, (now - introStart) / 1600);
      moving = true;
    }
    const gap = target - phase;
    if (Math.abs(gap) > 0.0005) {
      phase += still ? gap : gap * 0.14;
      moving = true;
    } else {
      phase = target;
    }
    draw();
    syncRail();
    if (moving) raf = requestAnimationFrame(tick);
  };
  const wake = () => { if (!raf) raf = requestAnimationFrame(tick); };
  const onScroll = () => { target = scrollTarget(scroller); wake(); };
  const onResize = () => { build(); onScroll(); };

  build();
  target = scrollTarget(scroller);
  phase = target;
  scroller.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize);
  wake();

  return () => {
    cancelAnimationFrame(raf);
    raf = 0;
    scroller.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onResize);
  };
}

function workspaceHead(title, lead) {
  const h = el("header", "ws-head");
  h.appendChild(el("h2", "", title));
  if (lead) h.appendChild(el("p", "", lead));
  return h;
}

function portraitTabs(active) {
  const nav = el("nav", "ws-tabs");
  [["dialogue", "对话"], ["confirm", "核对"]].forEach(([view, label]) => {
    const b = el("button", `ws-tab${view === active ? " on" : ""}`, label);
    b.type = "button";
    b.onclick = () => setView(view);
    nav.appendChild(b);
  });
  return nav;
}

/* ---------- 账号：微信登录（公众号发数字）、访客、隐私说明 ---------- */

/* 换人（退出、删号、登录过期、登进另一个账号）一律整页重载：S 里有几十个字段、对话视图里有进行中的流，
   逐个清容易漏，上一个人没发的草稿就会出现在下一个人的表单里。要去哪一页、要提示什么，经 sessionStorage 带过去。 */
const PARK_KEY = "rg_parked";  // 停在这台浏览器上的另一个会话，见 parkedSession

function reloadInto(view, msg) {
  try {
    sessionStorage.setItem("rg_next_view", view || "home");
    if (msg) sessionStorage.setItem("rg_toast", msg);
  } catch (_) { /* 存不了就回首页、不提示 */ }
  location.reload();
}

/* 记下会话。原来是另一个人（uid 变了）就返回 true，并且已经开始重载：调用方要立刻停手。 */
function setSession(r, nextView, msg) {
  const switching = !!S.uid && r.uid !== S.uid;
  S.uid = r.uid;
  if (r.token) S.token = r.token;
  S.nickname = r.nickname || S.nickname;
  S.wechat = !!r.wechat;
  S.guest = !!r.guest;
  try {
    localStorage.setItem("rg_uid", S.uid);
    localStorage.setItem("rg_token", S.token);
    localStorage.setItem("rg_nick", S.nickname);
  } catch (_) { /* 存不了就只在这一页有效 */ }
  if (switching) {
    // 上一个人的草稿不留给这个人；这个人自己的、停在这台浏览器上的另一个号（parkedSession）的留着
    let parked = "";
    try { parked = (JSON.parse(localStorage.getItem(PARK_KEY) || "null") || {}).uid || ""; } catch (_) { /* 坏数据当没有 */ }
    clearLocalDrafts(["rg_uid", "rg_token", "rg_nick", PARK_KEY], [S.uid, parked]);
    reloadInto(nextView || "today", msg);
    return true;
  }
  const chip = document.getElementById("userNickname");
  if (chip) chip.textContent = S.guest ? `${S.nickname} · 访客` : S.nickname;
  return false;
}

/* 这台浏览器里存的个人草稿（任务草稿、阅读卡草稿、教程进度）。退出、删号、换人时清掉：
   公用电脑上，上一个人没交的阅读卡草稿原来会出现在下一个人的表单里。keep 是要留下的键（界面偏好、新登录的身份）。 */
function clearLocalDrafts(keep, owners) {
  try {
    const drop = [];
    const mine = (k) => (owners || []).some((u) => u && k.includes(u));  // 草稿的键都带着 uid
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith("rg_") && k !== "rg_kit" && !(keep || []).includes(k) && !mine(k)) drop.push(k);
    }
    drop.forEach((k) => localStorage.removeItem(k));
  } catch (_) { /* 无痕模式等 */ }
}

/* purge：连这台浏览器里这个人的草稿一起清。只在明确退出、删号时清；登录过期（401）不清——
   草稿的键带着 uid，别人看不到，同一个人重新登录还能接着写。 */
function clearSession(purge) {
  S.uid = ""; S.token = ""; S.wechat = false; S.guest = true;
  S.myDir = undefined; S.portraitId = "";
  if (purge) clearLocalDrafts();
  else ["rg_uid", "rg_token", "rg_nick"].forEach((k) => {
    try { localStorage.removeItem(k); } catch (_) { /* 无痕模式等 */ }
  });
}

function signedOut(msg) {
  clearSession();
  reloadInto("login", msg);
}

/* 回到一个已有的账号：读它的画像状态，决定「对话」页落在哪一格 */
async function resumeUser() {
  const st = await api("GET", `/api/onboard/result?uid=${S.uid}`);
  S.portraitTab = st.state && st.state.phase === "done" ? "confirm" : "dialogue";
  S.resume = "today";
  await ensurePortrait();
}

async function afterLogin(isNew) {
  if (isNew) {
    await api("POST", "/api/onboard/start", { uid: S.uid });
    setView("dialogue");
    return;
  }
  await resumeUser();
  setView("today");
}

/* 隐私说明：改了这里就把 server/auth.py 的 PRIVACY_VERSION 换成今天的日期，老用户会再看到一次 */
const PRIVACY_HTML = `
  <h4>存了什么</h4>
  <ul>
    <li><b>账号</b>：昵称；用微信登录的话还有公众号给的 openid——一串只对「启研」公众号有效的编号，不是你的微信号。我们拿不到你的手机号和微信资料，也不用密码。</li>
    <li><b>你写下和做过的</b>：对话；从对话里记下的画像（每条都标来源，在「记录」里能改能删）；你粘贴的成绩单；任务和项目提交；阅读卡；定位里的边、陈述和下注。</li>
    <li><b>登录会话</b>：只存令牌的哈希，三十天不用就失效。</li>
  </ul>
  <h4>谁能看到</h4>
  <ul>
    <li>只有登录的你能看到自己的记录。开发团队能在服务器上看到原始数据，只用来排查问题，不给别人。</li>
    <li>公众号只用来登录，不推营销消息。</li>
    <li>对话和成绩单会发给大模型服务（DeepSeek）生成回复。</li>
    <li>「定位」的竞争地图和稀有度用的是所有人的匿名计数，只出数字，不出名字和原话。</li>
  </ul>
  <h4>存在哪、存多久</h4>
  <ul>
    <li>存在团队租用的阿里云服务器上。不卖数据，不做广告。</li>
    <li>「记录」页随时可以导出全部数据或删除账号。删除会立刻清掉库里你的所有记录，备份最多再留 7 天。</li>
  </ul>`;

/* gate=true：老用户或说明更新后必须先同意才能继续用 */
function openPrivacy(gate) {
  document.querySelectorAll(".connect-mask").forEach((n) => n.remove());
  const mask = el("div", "connect-mask");
  const box = el("div", "connect-box privacy-box");
  box.appendChild(el("p", "hero-kicker", "PRIVACY"));
  box.appendChild(el("h3", "", gate ? "继续之前，看一眼我们存什么" : "我们存什么"));
  box.appendChild(el("div", "privacy-body", PRIVACY_HTML));
  const acts = el("div", "connect-actions");
  if (gate) {
    const out = el("button", "btn secondary", "退出登录");
    out.type = "button";
    out.onclick = async () => { mask.remove(); await logout(); };
    const ok = el("button", "btn", "同意并继续");
    ok.type = "button";
    ok.onclick = async () => {
      try {
        await api("POST", "/api/auth/consent", { version: S.auth ? S.auth.privacy_version : "" });
        mask.remove();
      } catch (e) { toast(e.message); }
    };
    acts.append(out, ok);
  } else {
    const ok = el("button", "btn", "知道了");
    ok.type = "button";
    ok.onclick = () => mask.remove();
    acts.appendChild(ok);
    mask.addEventListener("click", (e) => { if (e.target === mask) mask.remove(); });
  }
  box.appendChild(acts);
  mask.appendChild(box);
  document.body.appendChild(mask);
}

function consentRow() {
  const row = el("label", "consent-row");
  const box = el("input");
  box.type = "checkbox";
  const read = el("button", "linkish", "我们存什么");
  read.type = "button";
  read.onclick = (e) => { e.preventDefault(); openPrivacy(false); };
  row.append(box, document.createTextNode("我读过"), read, document.createTextNode("，同意按这个方式保存我的记录"));
  return { row, ok: () => box.checked };
}

let wxPoll = 0;  // 微信登录的轮询；离开登录页或换数字时停掉

let wxAttempt = 0;  // 第几次微信登录尝试；旧尝试的响应回来时编号对不上就丢掉

function stopWxPoll() {
  clearTimeout(wxPoll);
  wxPoll = 0;
  wxAttempt += 1;  // 清掉定时器拦不住已经发出去的请求：靠编号让它回来时作废
}

/* 微信登录：网页拿一个 6 位数字，学生在公众号里发它，网页轮询到了就登进去 */
async function startWechat(box, opts) {
  stopWxPoll();
  const attempt = wxAttempt;
  const live = () => attempt === wxAttempt && box.isConnected;
  box.innerHTML = "";
  box.hidden = false;
  let r;
  try {
    r = await api("POST", "/api/auth/wechat/start", { nickname: opts.nickname, consent: true });
  } catch (e) { if (live()) { box.hidden = true; toast(e.message); } return; }
  if (!live()) return;
  const name = r.account_name ? `「${esc(r.account_name)}」` : "启研";
  if (r.qr_url) {
    const qr = el("img", "wx-qr");
    qr.src = r.qr_url;
    qr.alt = "公众号二维码";
    box.appendChild(qr);
  }
  const steps = el("ol", "wx-steps");
  steps.appendChild(el("li", "", `微信扫码关注${name}公众号（已经关注的，直接打开它）`));
  const li = el("li", "", "在公众号里发送这个数字：");
  li.appendChild(el("b", "wx-code", `${r.code.slice(0, 3)} ${r.code.slice(3)}`));
  steps.appendChild(li);
  box.appendChild(steps);
  const status = el("p", "wx-status", "等你在微信里发送…");
  box.appendChild(status);
  const acts = el("div", "account-actions");
  const again = el("button", "btn small secondary", "换一个数字");
  again.type = "button";
  again.onclick = () => startWechat(box, opts);
  acts.appendChild(again);
  if (S.auth && S.auth.dev) {  // 本机开发没有公众号：假装从微信发了这个数字
    const dev = el("button", "btn small ghost", "（开发）模拟微信发送");
    dev.type = "button";
    dev.onclick = () => api("POST", "/api/auth/wechat/dev-send", { code: r.code }).catch((e) => toast(e.message));
    acts.appendChild(dev);
  }
  box.appendChild(acts);

  const deadline = Date.now() + r.expires_in * 1000;
  const tick = async () => {
    if (!live()) return;  // 换了数字、走了访客、离开了登录页
    let res;
    try {
      res = await api("POST", "/api/auth/wechat/poll", { ticket: r.ticket });
    } catch (e) {
      if (live()) status.textContent = `${e.message}`;
      return;  // 过期或用过了：不再轮询，等学生点「换一个数字」
    }
    if (!live()) return;  // 请求在路上时用户已经换了别的登录方式：这个结果不能再生效
    if (res.pending) {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      status.textContent = `等你在微信里发送…（还剩 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}）`;
      wxPoll = setTimeout(tick, 2000);
      return;
    }
    stopWxPoll();
    if (res.left_guest && S.uid && S.guest && res.uid !== S.uid) { askLeaveGuest(box, res); return; }
    const previous = S.token;  // 采用新令牌之后再吊销旧的；被当成过期尝试丢掉的结果不会走到这里
    if (previous && previous !== res.token) revokeToken(previous);
    if (setSession(res, "today")) return;
    toast(res.bound ? "绑定好了，记录都在" : `你好，${res.nickname}`);
    if (res.bound) { setView("me"); return; }
    await afterLogin(res.created);
  };
  wxPoll = setTimeout(tick, 2000);
}

/* 访客来绑微信，这个微信却已经有账号：访客的记录不会合并过去。先问；要登进微信账号，访客号的会话停在这台浏览器上，
   「记录」页可以切回去。原来直接切走、吊销访客令牌、清掉草稿，访客的记录再也进不去（Codex 复现）。 */
function askLeaveGuest(box, res) {
  box.innerHTML = "";
  box.appendChild(el("p", "wx-status",
    `这个微信已经有账号「${esc(res.nickname)}」了。访客号「${esc(S.nickname)}」的记录不会合并过去。`));
  const acts = el("div", "account-actions");
  const go = el("button", "btn small", "登进微信账号");
  const stay = el("button", "btn small secondary", "留在访客号");
  go.type = "button"; stay.type = "button";
  go.onclick = () => {
    parkCurrent(res.uid);
    setSession(res, "me", "已登进微信账号。访客号的记录还在，在这一页可以切回去看");
  };
  stay.onclick = () => {
    revokeToken(res.token);
    box.hidden = true;
    toast("还在访客号里");
  };
  acts.append(go, stay);
  box.appendChild(acts);
}

/* 停在这台浏览器上的另一个会话（目前只有上面这种情况会停）。只给停放它的那个账号看：
   公用电脑上，下一个人登进自己的号看不到、也切不过去。退出、删号时跟着清掉。键 PARK_KEY 在 reloadInto 上面。 */
function parkedSession() {
  try {
    const p = JSON.parse(localStorage.getItem(PARK_KEY) || "null");
    return p && p.owner === S.uid && p.uid && p.token && p.uid !== S.uid ? p : null;
  } catch (_) { return null; }
}
function parkCurrent(owner) {
  try {
    localStorage.setItem(PARK_KEY, JSON.stringify({
      uid: S.uid, token: S.token, nickname: S.nickname, guest: S.guest, wechat: S.wechat, owner }));
  } catch (_) { /* 存不了：切过去之后就切不回来了，和原来一样 */ }
}

function renderLogin() {
  $nav.hidden = true; $header.hidden = true;
  $app.innerHTML = "";
  stopWxPoll();
  const binding = !!(S.uid && S.guest);  // 访客来绑微信：start 时带着访客会话，记录跟着走
  const wxOn = !S.auth || S.auth.wechat_login;
  const hero = el("section", "hero stagger");
  hero.appendChild(el("p", "hero-kicker", binding ? "启研 · 绑定微信" : "启研 · 登录"));
  hero.appendChild(el("h2", "", binding ? "绑定微信" : "微信登录"));
  hero.appendChild(el("p", "hero-lead", binding
    ? "绑定后换设备、清了浏览器也能接着用，访客期间的记录都会带过去。"
    : "换手机、清了浏览器也能接着用。不用密码，也不要手机号。"));
  const consent = consentRow();
  const need = () => { if (consent.ok()) return true; toast("先勾选同意隐私说明"); return false; };

  const wxStep = el("div", "login-step");
  const nick = el("input", "login-nick");
  nick.placeholder = "怎么称呼你（选填，新账号用）"; nick.maxLength = 24;
  nick.setAttribute("aria-label", "昵称");
  const go = el("button", "btn", binding ? "绑定微信" : "用微信登录");
  go.type = "button";
  const wxBox = el("div", "wx-box");
  wxBox.hidden = true;
  go.onclick = () => { if (need()) startWechat(wxBox, { nickname: nick.value.trim() }); };
  if (!binding) wxStep.appendChild(nick);
  wxStep.append(go, wxBox);

  // 访客：只要昵称，记录只能在这台浏览器里找回；之后可以绑微信
  const guestBox = el("div", "login-step");
  const guestRow = el("div", "login-row");
  const gname = el("input");
  gname.placeholder = "你的昵称，例如：小北"; gname.maxLength = 24;
  gname.setAttribute("aria-label", "访客昵称");
  const gbtn = el("button", "btn", "以访客进入");
  gbtn.type = "button";
  gbtn.onclick = async () => {
    if (!need()) return;
    const n = gname.value.trim();
    if (!n) { toast("先起个昵称吧"); gname.focus(); return; }
    gbtn.disabled = true;
    stopWxPoll();  // 走访客就作废正在等的微信登录，免得它的结果回来盖掉访客会话
    try {
      if (setSession(await api("POST", "/api/auth/login", { nickname: n, consent: true }), "dialogue")) return;
      toast(`你好，${S.nickname}`);
      await afterLogin(true);
    } catch (e) { toast(e.message); gbtn.disabled = false; }
  };
  gname.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) gbtn.click(); });
  guestRow.append(gname, gbtn);
  guestBox.append(guestRow, el("p", "form-note", "访客的记录只能在这台浏览器里找回，之后可以在「记录」页绑定微信。"));

  if (binding) {
    hero.append(consent.row, wxStep);
  } else if (wxOn) {
    guestBox.hidden = true;
    hero.append(consent.row, wxStep, guestBox);
  } else {
    hero.append(el("p", "login-note", "微信登录还没开通，先以访客进入。"), guestBox, consent.row);
  }

  const links = el("div", "hero-links");
  if (!binding && wxOn) {
    const asGuest = el("button", "linkish", "先不登录，以访客进入");
    asGuest.type = "button";
    asGuest.onclick = () => { guestBox.hidden = false; asGuest.remove(); gname.focus(); };
    links.appendChild(asGuest);
  }
  const link = el("button", "linkish", "连接模型 API");
  link.type = "button";
  link.onclick = () => openConnect();
  const back = el("button", "linkish", binding ? "返回" : "返回首页");
  back.type = "button";
  back.onclick = () => setView(binding ? "me" : "home");
  links.append(link, back);
  hero.appendChild(links);
  $app.appendChild(hero);
  if (!wxOn) gname.focus();
}

async function logout() {
  stopWxPoll();
  try { await api("POST", "/api/auth/logout"); } catch (_) { /* 会话已经没了也照样退 */ }
  clearSession(true);
  reloadInto("home");
}

function accountPanel() {
  const box = el("section", "panel account-panel");
  box.appendChild(el("h3", "section-label", "账号"));
  box.appendChild(el("p", "panel-sub", S.guest
    ? `访客「${esc(S.nickname)}」：记录只能在这台浏览器里找回。绑定微信后换设备也能接着用。`
    : `已用微信登录：${esc(S.nickname)}`));
  const acts = el("div", "account-actions");
  const add = (label, cls, fn) => {
    const b = el("button", cls, label);
    b.type = "button";
    b.onclick = fn;
    acts.appendChild(b);
  };
  if (S.guest) add("绑定微信", "btn small", () => setView("login"));
  const parked = parkedSession();
  if (parked) {
    box.appendChild(el("p", "form-note", parked.guest
      ? `这台浏览器上还有访客号「${esc(parked.nickname)}」的记录（绑微信时这个微信已经有账号，没有合并过去）。`
      : `这台浏览器上还登着微信账号「${esc(parked.nickname)}」。`));
    add(parked.guest ? "切回访客号" : "切回微信账号", "btn small secondary", () => {
      parkCurrent(parked.uid);
      setSession(parked, "me", parked.guest ? "已切回访客号" : "已切回微信账号");
    });
  }
  add("我们存什么", "btn small ghost", () => openPrivacy(false));
  add("导出我的数据", "btn small secondary", async () => {
    const res = await apiFetch("/api/me/export");
    if (!res.ok) { toast("导出失败"); return; }
    downloadBlob(await res.blob(), "启研-我的数据.json");
  });
  add("退出登录", "btn small secondary", async () => {
    if (S.guest && !window.confirm("访客退出后，这些记录就找不回来了（除非先绑定微信）。确定退出？")) return;
    if (parked && parked.guest && !window.confirm(`退出后，访客号「${parked.nickname}」的记录就找不回来了。确定退出？`)) return;
    if (parked) revokeToken(parked.token);
    await logout();
  });
  add("删除账号", "btn small ghost danger", async () => {
    const back = parked && parked.guest ? `删的只是这个账号；这台浏览器上停着的访客号「${parked.nickname}」不受影响，删完切回它。` : "";
    const typed = window.prompt(`删除后，库里你的所有记录会立刻清掉，不能恢复。${back}确定的话输入「删除」两个字：`);
    if (typed === null) return;
    if (typed.trim() !== "删除") { toast("没有删除：输入的不是「删除」"); return; }
    try {
      await api("DELETE", "/api/me");
      if (back) {
        // 停着的访客号是它唯一的凭证：原来跟着一起清掉，访客的记录还在库里却再也进不去（Codex 复现）
        try { localStorage.removeItem(PARK_KEY); } catch (_) { /* 无痕模式等 */ }
        setSession(parked, "me", `账号删了，已切回访客号「${parked.nickname}」`);
        return;
      }
      clearSession(true);
      reloadInto("home", "账号和记录都删了");
    } catch (e) { toast(e.message); }
  });
  box.appendChild(acts);
  return box;
}

function openConnect() {
  document.querySelectorAll(".connect-mask").forEach((n) => n.remove());
  const mask = el("div", "connect-mask");
  const box = el("form", "connect-box");
  box.innerHTML = `
    <p class="hero-kicker">MODEL</p>
    <h3>连接模型</h3>
    <p class="panel-sub">OpenAI 兼容接口，改的是整台服务器用的模型。密钥只写在服务器的 .env，不会出现在页面回显里。只有在服务器本机，或填了管理员口令才能改。</p>
    <label>接口地址<input name="base" value="https://api.deepseek.com/v1" /></label>
    <label>API Key<input name="key" type="password" placeholder="sk-…" autocomplete="off" /></label>
    <label>模型名<input name="model" value="deepseek-flash" /></label>
    <label>管理员口令<input name="admin" type="password" placeholder="服务器设了 ADMIN_TOKEN 才需要" autocomplete="off" /></label>
    <div class="connect-actions">
      <button type="button" class="btn secondary" id="connectCancel">取消</button>
      <button type="submit" class="btn" id="connectGo">测试并保存</button>
    </div>`;
  mask.appendChild(box);
  document.body.appendChild(mask);
  box.querySelector("#connectCancel").onclick = () => mask.remove();
  mask.addEventListener("click", (e) => { if (e.target === mask) mask.remove(); });
  box.onsubmit = async (e) => {
    e.preventDefault();
    const go = box.querySelector("#connectGo");
    go.disabled = true; go.textContent = "正在连通…";
    try {
      // 管理员口令走请求头，所以这里不用 api()
      const res = await apiFetch("/api/llm/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Token": box.admin.value.trim() },
        body: JSON.stringify({ base_url: box.base.value.trim(), api_key: box.key.value.trim(), model: box.model.value.trim() }),
      });
      let r = null;
      try { r = await res.json(); } catch (_) { /* no body */ }
      if (!res.ok) throw new Error((r && r.detail) || `请求失败 (${res.status})`);
      applyLlmPill({ enabled: true, model: r.model });
      toast(`已连接 ${r.model}`);
      mask.remove();
    } catch (err) {
      toast(err.message);
      go.disabled = false; go.textContent = "测试并保存";
    }
  };
}

function applyLlmPill(llm) {
  const pill = document.getElementById("llmPill");
  if (!pill || !llm) return;
  pill.textContent = llm.enabled ? `模型 · ${llm.model}` : "连接模型";
  pill.classList.toggle("on", !!llm.enabled);
  pill.onclick = () => openConnect();
}

/* ---------- 画像切换 ---------- */

async function portraitBar() {
  const r = await api("GET", `/api/portraits?uid=${S.uid}`);
  const bar = el("div", "portrait-bar");
  (r.portraits || []).forEach((p) => {
    const chip = el("div", "portrait-chip" + (p.active ? " on" : ""));
    const name = el("button", "portrait-name", esc(p.name));
    name.type = "button";
    name.onclick = () => portraitOp(async () => {
      if (p.active) return null;
      // 服务器切成功了才改前端记着的画像：原来先改，切失败时任务区显示 B 的教程、却在 A 里建任务（Codex 复现）
      return api("POST", "/api/portraits/activate", { uid: S.uid, id: p.id });
    }, S.view === "confirm" ? "confirm" : "dialogue");
    const del = el("button", "portrait-x", "删除");
    del.type = "button";
    del.onclick = async () => {
      if (!window.confirm(`删除「${p.name}」？这份画像的对话和记录都会清掉，不能恢复。`)) return;
      await portraitOp(() => api("DELETE", `/api/portraits/${encodeURIComponent(p.id)}?uid=${S.uid}`), "dialogue");
    };
    chip.append(name, del);
    bar.appendChild(chip);
  });
  const add = el("button", "portrait-add", "新建");
  add.type = "button";
  add.onclick = () => portraitOp(() => api("POST", "/api/portraits", { uid: S.uid }), "dialogue");
  bar.appendChild(add);
  return bar;
}

/* ② 原「问卷」视图已删除：问卷现在全靠对话实现（server/onboarding.py 的固定五问
   已由 dialogue 内核的提问阶梯取代）。原来的事实写入、待核对列表都在对话页里做完了，
   所以这一页只剩重复劳动，删掉可以少维护一份流程。
   后端 /api/onboard/* 仍然保留：它现在是「读画像事实」的通用出口，
   核对页、方向页、任务页都在用它拿 facts。 */

/* ---------- ③ 确认页 ---------- */

async function renderConfirm() {
  const seq = S.renderSeq;
  const [r, bar] = await Promise.all([api("GET", `/api/onboard/result?uid=${S.uid}`), portraitBar()]);
  if (stale(seq)) return;
  $app.innerHTML = "";
  $app.appendChild(workspaceHead("画像"));
  $app.appendChild(bar);
  $app.appendChild(portraitTabs("confirm"));
  const main = el("div", "panel");

  const list = el("div", "fact-list");
  const drafts = r.facts.filter((f) => f.status === "draft");
  const others = r.facts.filter((f) => f.status === "confirmed" || f.status === "active");
  const edits = {};
  const dismissed = new Set();

  if (drafts.length) {
    main.appendChild(el("p", "panel-sub", "这些是它从对话里记下的。说得不对就直接改，不属实就划掉。保存之后才会用来推荐方向。"));
  } else if (!others.length) {
    main.appendChild(el("div", "note-box", "还没有可核对的记录。先在「对话」里回答几问。"));
  }

  drafts.forEach((f) => {
    const card = factCard(f, true);
    const input = card.querySelector("input");
    input.value = f.value;
    input.setAttribute("aria-label", "修改这条记录");
    input.addEventListener("input", () => { edits[f.id] = input.value; });
    const del = el("button", "linkish danger", "不属实，划掉");
    del.type = "button";
    del.onclick = () => {
      if (dismissed.has(f.id)) dismissed.delete(f.id); else dismissed.add(f.id);
      const off = dismissed.has(f.id);
      card.classList.toggle("is-dismissed", off);
      input.disabled = off;
      del.textContent = off ? "恢复" : "不属实，划掉";
    };
    card.querySelector(".fact-actions").appendChild(del);
    list.appendChild(card);
  });
  if (others.length) {
    if (drafts.length) list.appendChild(el("p", "section-label", "已核对"));
    others.forEach((f) => list.appendChild(factCard(f, false)));
  }
  main.appendChild(list);

  const actions = el("div", "submit-actions");
  if (drafts.length) {
    const ok = el("button", "btn", "保存核对");
    ok.type = "button";
    ok.onclick = async () => {
      const payload = Object.entries(edits).map(([id, value]) => ({ id, value }))
        .concat([...dismissed].map((id) => ({ id, dismissed: true })));
      ok.disabled = true;
      try {
        await api("POST", "/api/onboard/confirm", { uid: S.uid, edits: payload });
        toast("已保存，接下来看方向");
        setView("cards");
      } catch (e) { toast(e.message); ok.disabled = false; }
    };
    actions.appendChild(ok);
  }
  const later = el("button", drafts.length ? "btn ghost" : "btn", "去方向区");
  later.type = "button";
  later.onclick = () => setView("cards");
  actions.appendChild(later);
  main.appendChild(actions);
  $app.appendChild(main);

  // 字段清单按九大类分列：填了的给值，没填的显示成空格 + 「填了有什么用」。
  main.appendChild(coverageBoard());
}

/* 把「还缺什么、填了能得到什么」摊开给用户看。
   空格本身是邀请，但只列空格不说收益，就变成一张逼人填的表——
   所以每个空格都带一句 why（来自后端 memory.COVERAGE_GROUPS）。 */
function coverageBoard() {
  const box = el("div", "coverage");
  box.appendChild(el("p", "section-label", "这些填得越全，我给的科研方向越准"));
  const hintRow = el("p", "coverage-hint", "下面每一格都可以点。空着的也可以先在「对话」里随口说一句。");
  box.appendChild(hintRow);
  const grid = el("div", "cov-grid");
  box.appendChild(grid);

  (async () => {
    let cov;
    try {
      cov = await api("GET", `/api/me/coverage?uid=${encodeURIComponent(S.uid)}`);
    } catch (e) {
      // 取不到**要说出来**，不能悄悄把自己删掉。
      // 之前这里写的是 box.remove()，接口一有问题用户就只看到一片空白，
      // 既不知道发生了什么、也没法告诉我——「核对没有分类」就是这么来的。
      grid.innerHTML = "";
      const err = el("p", "cov-bad",
        `字段清单没加载出来：${e && e.message ? e.message : "接口没有响应"}。`
        + "刷新一下试试；如果一直这样，把这个提示截图给我。");
      grid.appendChild(el("div", "cov-col cov-col-transcript")).appendChild(err);
      return;
    }
    const head = el("p", "cov-total",
      `已填 ${cov.filled} / ${cov.total} 项` + (cov.missing ? `，还差 ${cov.missing} 项` : "，都齐了"));
    box.insertBefore(head, grid);

    (cov.groups || []).forEach((G) => {
      const col = el("div", `cov-col cov-col-${G.group}`);
      const h = el("p", "cov-head");
      h.appendChild(el("span", "cov-title", esc(G.label)));
      h.appendChild(el("span", "cov-count", `${G.filled}/${G.total}`));
      col.appendChild(h);
      if (G.why) col.appendChild(el("p", "cov-why", esc(G.why)));

      (G.slots || []).forEach((s) => {
        const row = el("div", "cov-slot" + (s.filled ? " on" : ""));
        row.appendChild(el("span", "cov-mark", s.filled ? "✓" : "○"));
        const body = el("div", "cov-body");
        const line = el("p", "cov-label");
        line.appendChild(el("span", "", esc(s.label)));
        if (s.filled && s.value) {
          line.appendChild(el("span", "cov-value", esc(String(s.value))));
          // 默认前提（学校=北京大学）：显示出来，但标清它是默认值、不是他说的
          if (s.presumed) line.appendChild(el("span", "cov-value", "（默认）"));
        }
        body.appendChild(line);
        // 已填的不再重复「填了有什么用」，省得整页都是废话
        if (!s.filled && s.why) body.appendChild(el("p", "cov-tip", esc(s.why)));
        row.appendChild(body);
        // 点空格 → 去对话里补。不在核对页做输入框：
        // 这些字段大多需要上下文（成绩单要粘贴、方向要聊），
        // 摆一排输入框只会让人填一半就走。
        row.onclick = () => {
          if (s.presumed) { toast(`「${s.label}」是默认前提（${s.value}），不用填。`); return; }
          toast(s.filled ? `「${s.label}」已经记下了，想改就去左边侧栏改。`
            : `去对话里说一句就行——${s.why}`);
          if (!s.filled) setView("dialogue");
        };
        col.appendChild(row);
      });
      grid.appendChild(col);
    });

    // 成绩单单独给一个粘贴入口：它是一条记录变多条，聊天里说不清楚
    const tcol = el("div", "cov-col cov-col-transcript");
    tcol.appendChild(el("p", "cov-head", "粘贴成绩单"));
    tcol.appendChild(el("p", "cov-why", "一次贴上，我就知道你修过哪些课、绩点多少，后面难度判断都靠它。"));
    const ta = el("textarea", "cov-paste");
    ta.rows = 4;
    ta.placeholder = "从树洞或教务复制成绩单，整段粘进来即可。\n形如：\n25-26学年度1学期\n3\n学分\n线性代数 (B)\n专业必修\n88";
    const act = el("div", "cov-actions");
    const btn = el("button", "btn small", "识别");
    btn.type = "button";
    const report = el("div", "cov-report");
    btn.onclick = async () => {
      const text = ta.value.trim();
      if (!text) { toast("先把成绩单粘进来"); return; }
      btn.disabled = true;
      try {
        const r = await api("POST", "/api/me/transcript/parse", { uid: S.uid, text });
        report.innerHTML = "";
        if (!r.courses || !r.courses.length) {
          report.appendChild(el("p", "cov-bad",
            "没识别到课程。" + ((r.warnings || [])[0] || "请检查格式。")));
          btn.disabled = false;
          return;
        }
        const s = r.summary || {};
        report.appendChild(el("p", "cov-ok",
          `识别到 ${r.courses.length} 门课，涉及 ${(r.terms || []).length} 个学期` +
          (s.gpa != null ? `；总绩点 ${s.gpa.toFixed(3)}，均分 ${s.avg_score.toFixed(1)}` : "") +
          `；通过学分 ${s.passed_credits}，其中计 GPA ${s.gpa_credits}。`));
        // 少算了什么必须自己说出来。字母等级不进 GPA 是我们的选择，
        // 用户看到的总绩点是少算过的——不说就成了一个「看起来完整其实是错的数」。
        if ((s.ungraded || []).length) {
          report.appendChild(el("p", "cov-warn",
            `有 ${s.ungraded.length} 门是字母等级/五级制（`
            + s.ungraded.map((u) => `${esc(u.course)} ${esc(u.grade)}`).join("、")
            + `，共 ${s.ungraded_credits} 学分），学分已计入，但**没有算进绩点**——`
            + "教务的换算口径我不敢替你定，你确认后我再加上。"));
        }
        if ((s.in_progress || []).length) {
          report.appendChild(el("p", "cov-warn",
            `有 ${s.in_progress.length} 门成绩还没出（`
            + s.in_progress.map((u) => esc(u.course)).join("、")
            + `），我按「在修」记下来了，不计入已修学分。`));
        }
        // 把「我从成绩单读出了什么」先给用户看。落库前就能判断我们有没有读错。
        (r.preview || []).forEach((d) => {
          report.appendChild(el("p", "cov-derived", `会记下：${esc(d.value)}`));
        });
        (r.warnings || []).forEach((w) => report.appendChild(el("p", "cov-warn", esc(w))));
        const ok = el("button", "btn small", "就用这份");
        ok.type = "button";
        ok.onclick = async () => {
          ok.disabled = true;
          try {
            const w = await api("POST", "/api/me/transcript",
              { uid: S.uid, text, mode: "replace" });
            toast(`已记下 ${w.written} 门课`);
            setView("confirm");
          } catch (e) { toast(e.message); ok.disabled = false; }
        };
        act.appendChild(ok);
        btn.disabled = false;
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
    act.appendChild(btn);
    tcol.appendChild(ta);
    tcol.appendChild(act);
    tcol.appendChild(report);
    grid.appendChild(tcol);
  })();

  return box;
}

/* ---------- ④ 方向：生长的边界 ---------- */

function twig(label, intro, children) {
  return { label, intro, children: children || [] };
}

function stampTree(node, id) {
  node.id = id;
  (node.children || []).forEach((child, i) => stampTree(child, `${id}.${i}`));
  return node;
}

const FIELD_TREES = {
  ai: {
    name: "人工智能",
    query: "人工智能",
    root: stampTree(twig("看懂机器学习", "机器学习是让程序从例子里找出规律，而不是把每条规则手写死。入门先分清：数据是什么、模型在学什么、你怎么知道它学对了。", [
      twig("数据", "没有数据就没有可检查的结果。先弄清例子从哪来、每个例子长什么样，再谈模型。", [
        twig("例子从哪来", "数据可以是你自己收集的，也可以是别人公开的。来源决定你能下什么结论。", [
          twig("自己标一份", "拿二三十条真实例子，自己写下标签。你会立刻碰到：标准含糊、两类例子长得很像。"),
          twig("公开数据集", "先读数据说明，而不是直接训练。看它收集了谁、缺了谁、标签是谁打的。"),
        ]),
        twig("特征", "特征是你决定让模型看见的那一部分。选错了，后面的模型再复杂也学不到你想问的事。", [
          twig("表格", "一行一个例子，一列一个属性。先画分布，再决定哪一列能用、哪一列不该用。"),
          twig("文本和图像", "文字和图片要先变成数字。这一步叫表示，入门时知道它存在即可，不必先写网络。"),
        ]),
      ]),
      twig("模型怎么学", "模型把「猜错了多少」变成一个数，再按这个数改自己。你要看的是它改完以后，对新例子还对不对。", [
        twig("损失", "损失是猜错的程度。训练就是想把这个数变小，但变小不等于真正学会了。", [
          twig("过拟合", "训练例子上很准、新例子上很差。通常是记得太死，而不是方法更高级。"),
          twig("训练曲线", "把损失随步数画出来。一直降、突然炸、或者很快不动，分别是三种不同的问题。"),
        ]),
        twig("评价", "先定「怎样算做对」，再跑模型。标准要在看结果之前写下来。", [
          twig("别只看准确率", "某一类特别多时，全猜那一类也会有很高的准确率。要看每一类分别怎样。"),
          twig("误差从哪来", "把判错的例子摊开。是标签有问题、特征没覆盖，还是这类例子根本太少。"),
        ]),
      ]),
      twig("用起来", "先做一个小而完整的预测，再碰生成。生成看起来聪明，但更难核对它有没有胡说。", [
        twig("预测一件事", "选一个能在二十分钟里核对的问题，比如一段话是积极还是消极。留下输入、输出和你不同意的例子。"),
        twig("生成", "生成是在续写，不是在检索事实。你要单独检查它说的每件可核对的事。", [
          twig("提示", "把任务、例子和限制写进提示。改一个词，输出就会变，所以提示本身也是实验条件。"),
          twig("幻觉", "说得流畅不等于有依据。对课程名、论文、数字，要回到原处核对，查不到就当没有。"),
        ]),
      ]),
    ]), "ai"),
  },
  math: {
    name: "数学",
    query: "数学",
    root: stampTree(twig("证明是什么", "数学入门不是多做题，而是把一句「显然」拆成别人能检查的步骤。先从定义出发，再谈证明和例子。", [
      twig("定义", "定义规定一个词在这里到底指什么。后面的证明只能用已经定义过的东西。", [
        twig("对象", "先说清你在谈论哪一类东西：数、集合、函数，还是一种关系。", [
          twig("集合", "集合是把对象放在一起的一种说法。属于、子集、空集，是后面所有话的地基。"),
          twig("函数", "函数是一条对应规则：每个输入对应唯一输出。先别急着算，先说清定义域。"),
        ]),
        twig("说法", "把日常句子改成「对所有」或「存在一个」。这句话的范围变了，真假也会变。", [
          twig("量词", "「所有人都会」和「有人会」不是同一句话。写证明前先把量词写对。"),
          twig("反例", "要否定「所有」，举一个不行的例子就够了。这个例子必须真的落在定义里。"),
        ]),
      ]),
      twig("证明", "证明是从定义和已知走到结论的一条路。每一步都要能指出它用了哪一条。", [
        twig("直接证", "假设条件成立，按定义推出结论。写的时候别跳步，跳步通常藏着还没定义的词。", [
          twig("一步一由", "每写一行，旁边注明用的是定义、上一步，还是一条已经证过的事实。"),
        ]),
        twig("反证", "先假设结论不成立，推出和已知矛盾。矛盾必须是明确的，不能只是「看起来怪」。", [
          twig("矛盾要落地", "写出互相否定的那两句话。说「这不可能」之前，先指出不可能的是哪一句。"),
        ]),
      ]),
      twig("结构", "很多新对象其实是旧对象加上一种运算或关系。看懂结构，就是看懂什么被保留了。", [
        twig("关系", "相等、大小、整除，都是关系。先问它是否自反、对称、传递。"),
        twig("不变量", "操作之后仍然不变的量，常常就是问题真正在问的东西。"),
      ]),
    ]), "math"),
  },
  stat: {
    name: "统计",
    query: "统计",
    root: stampTree(twig("数据在说什么", "统计是在不确定里做判断：这批数据支持哪一种说法，以及这个支持有多不稳。", [
      twig("描述", "先把数据本身看清楚，再谈推断。均值会掩盖少数极端值。", [
        twig("分布", "看数据堆在哪里、散得有多开、有没有孤零零的点。", [
          twig("中心", "均值、中位数回答「典型值在哪」。有极端值时，两者会分开。"),
          twig("散开", "同一均值可以很集中，也可以很散。散开程度决定你敢不敢用这个典型值。"),
        ]),
        twig("图", "直方图、散点图比一张表更容易看见形状。图的坐标和分组会改变你看见的故事。", [
          twig("分组", "直方图的箱子宽度变了，峰的个数可能也变。先试两种宽度再下结论。"),
        ]),
      ]),
      twig("推断", "你手里的是样本，想说的是更大的总体。样本不是总体的缩小复印件。", [
        twig("抽样", "谁有机会被抽到，决定你能把结论推到谁身上。", [
          twig("偏差", "方便抽到的人，往往不是你想代表的那群人。先写出没被抽到的是谁。"),
          twig("样本量", "样本越大，波动通常越小，但不能自动消除收集方式带来的偏差。"),
        ]),
        twig("不确定", "用区间或误差说明「还可能差多少」，而不是只给一个点。", [
          twig("区间", "区间越窄不一定越好。要看它是在什么假设下算出来的。"),
        ]),
      ]),
      twig("相关不是因果", "两件事一起变化，可能是第三件事在推动，也可能只是一起出现。", [
        twig("混杂", "找出一个同时影响两边的因素，再问：扣掉它之后，关系还在不在。"),
        twig("实验", "如果能主动分组而不是只观察，因果才比较站得住。分组方式本身要先写清。"),
      ]),
    ]), "stat"),
  },
  psy: {
    name: "认知",
    query: "心理",
    root: stampTree(twig("人如何做判断", "认知科学用可重复的任务，看人在知觉、记忆和决定上实际怎么做，而不是只问他觉得自己怎么做。", [
      twig("知觉", "你看见的不是原始刺激的复印件。大脑会补全、会忽略、会受上下文影响。", [
        twig("注意", "注意是选择。没被选中的信息，常常进不了后面的判断。", [
          twig("漏看", "专心找一件东西时，明显的另一件也可能看不见。这是任务设计，不是粗心的道德问题。"),
        ]),
        twig("错觉", "错觉说明知觉规则在什么时候会给出和物理事实不同的结果。", [
          twig("上下文", "同一个灰块，放在不同背景里明暗会变。判断依赖周围，不依赖孤立的一点。"),
        ]),
      ]),
      twig("记忆", "记忆是重建，不是回放。提问方式和间隔会改变你「记得」的内容。", [
        twig("编码", "当时怎么理解，决定后来能提取出什么。只反复读，不如试着回忆。", [
          twig("提取练习", "合上材料试着写出来，比再看一遍更能暴露你其实没记住的部分。"),
        ]),
        twig("扭曲", "事后信息会改写原先的记忆。问句里的一个词就可能改变回答。", [
          twig("误导提问", "「撞碎」和「碰到」问的不是同一件事。记录原始用词，再比较回答。"),
        ]),
      ]),
      twig("决策", "人常用快捷判断。快捷在熟悉情境里有用，在概率和罕见事件上容易偏。", [
        twig("直觉", "直觉是很快的模式匹配。它擅长你见过很多次的情况。"),
        twig("偏差", "容易想到的例子会被觉得更常见。先把基数写下来，再相信感觉。", [
          twig("基数", "一百个人里真正有多少，比你刚听到的一个生动故事更该先看。"),
        ]),
      ]),
    ]), "psy"),
  },
  econ: {
    name: "经济",
    query: "经济学",
    root: stampTree(twig("选择与激励", "经济学看人在约束下怎么选，以及规则一变，选择会怎么变。先别背模型名字，先写清谁在选、成本是什么。", [
      twig("约束", "任何选择都有放弃的另一项。没写出放弃了什么，就还没开始分析。", [
        twig("机会成本", "成本是你为此没做成的最好的那件事，不只是花出去的钱。", [
          twig("时间也算", "免费的活动如果占掉唯一的晚上，成本就是那个晚上能做的另一件事。"),
        ]),
        twig("预算", "预算是硬边界。边界内怎么分配，取决于每一元换来的增量，不是总价值。", [
          twig("边际", "再多一单位值不值得，和前面已经消费的不是同一个问题。"),
        ]),
      ]),
      twig("激励", "人会对规则做出反应，而且常常反应在你没写进规则的那一面。", [
        twig("奖励", "奖励什么，人们就多做什么。如果指标和你真正想要的不是一回事，行为会对着指标走。", [
          twig("指标被对付", "只奖数量时，质量可能下降。改规则之前，先猜人们会钻哪一个空。"),
        ]),
        twig("Tradeoff", "多得到一项，通常要少得到另一项。政策争论常常是在争这个交换值不值。"),
      ]),
      twig("市场", "价格把分散的信息收成一个信号：哪里缺、哪里多。价格也会漏掉没有被买卖的影响。", [
        twig("供需", "一边更想要、另一边更难提供，价格通常会动。先说清动的是需求还是供给。"),
        twig("外部性", "一笔交易影响到没参加的人时，价格里没有这部分。拥堵、噪音、污染是典型例子。", [
          twig("谁没被算进去", "列出没付钱也没收款、但被影响到的人。他们的损益不在价格里。"),
        ]),
      ]),
    ]), "econ"),
  },
  se: {
    name: "系统",
    query: "软件",
    root: stampTree(twig("程序到底在做什么", "系统入门是把「我写的东西」和「机器实际做的事」对上。先走通一条小路径，再谈结构和可靠性。", [
      twig("表示", "所有数据在机器里都是位。文字、数字、图片只是不同的解释方式。", [
        twig("位和字节", "八个位是一个字节。数字溢出、符号搞反，都发生在这个很底层的约定上。", [
          twig("整数范围", "固定位数能表示的整数有上限。再加一会绕回去，这不是数学里的整数。"),
        ]),
        twig("文本", "一个字对应哪个数字，由编码决定。编码不一致，看到的就是乱码，不是内容变了。", [
          twig("编码", "同一串字节，用 UTF-8 和用别的编码读，会得到不同的字。读写两边要说好。"),
        ]),
      ]),
      twig("执行", "程序是一条条指令。调用函数、读文件、发请求，都是在某个时刻真正发生的事。", [
        twig("调用", "函数调用会把参数和返回地址压进一条路径。你要能说出：谁调用了谁，结果回到哪。", [
          twig("调用栈", "出错时从上往下读栈，最上面是真正炸的地方，下面是谁把它叫起来的。"),
        ]),
        twig("状态", "程序记住的东西会变。同一个函数，状态不同，结果就不同。", [
          twig("可变数据", "改了一处共享的数据，另一处会跟着变。先找出这份数据被谁拿着。"),
        ]),
      ]),
      twig("可靠", "能跑一次不算完成。输入变一点、失败一次、两个人同时用，系统还是否说得通。", [
        twig("边界", "空的、特别长的、刚好差一的输入，最容易露出你没处理的假设。"),
        twig("失败", "网络、文件、用户输入都会失败。失败时留下能看懂的记录，比假装成功有用。", [
          twig("说清楚失败", "告诉使用者失败了什么、你已经知道什么、什么还不知道。不要编一个正常结果。"),
        ]),
      ]),
    ]), "se"),
  },
  med: {
    name: "基础医学",
    query: "基础医学",
    root: stampTree(twig("从分子到症状", "基础医学先问结构在哪、反应怎么维持、哪一环偏离，而不是先背病名。本路径不含临床各科。", [
      twig("结构", "解剖名词是位置和连接，不是病因。先能指到，再谈功能。", [
        twig("系统与局部", "同一结构可以按功能归进系统，也可以按位置归进局部。两套说法都要能对上。"),
        twig("连接", "管道、神经、相邻器官：写不清和谁连着，后面的机制没有落点。"),
      ]),
      twig("分子", "生化把「能活」写成一串可检查的反应。少了哪一步，要能猜会在哪个结构上先出问题。", [
        twig("通路", "底物、产物、酶。通路是步骤，不是一个词。"),
      ]),
      twig("稳态", "正常是一个范围。身体用反馈把自己拉回来，数字不是对错题。", [
        twig("反馈", "感受、整合、效应。断在不同位置，先看到的偏离不一样。"),
      ]),
      twig("机制", "免疫、微生物、病理是同一条证据链上的三种角色：宿主、外来物或损伤、组织上的偏离。", [
        twig("三角", "三侧都要能指回结构或分子。只写病名，还没有机制。"),
      ]),
    ]), "med"),
  },
};

Object.entries(FIELD_TREES).forEach(([code, f]) => { f.code = code; });

/* 任务 4 的方向路径（docs/paths/）：有路径的方向画成「6 步主干 + 原有节点」。
   主干讲「这一学期走到哪」，原有节点讲「二十分钟能做什么」，两种尺度分开画。
   原有节点挂到哪一步，照 docs/paths/改树建议.md §3、§4、§7、§8 的改动清单。 */
const CHAIN_ATTACH = {
  math: { 1: ["定义", "证明"], 3: ["结构"] },
  ai: { 2: ["数据", "模型怎么学/评价"], 3: ["模型怎么学/损失"], 6: ["用起来"] },
  psy: { 1: ["知觉/错觉"], 2: ["知觉/注意", "记忆", "决策"] },
  econ: { 1: ["约束"], 2: ["激励"], 3: ["市场"] },
  med: { 1: ["结构"], 2: ["分子"], 3: ["稳态"], 4: ["机制"] },
};

function findTwig(root, labelPath) {
  let node = root;
  for (const label of labelPath.split("/")) {
    node = (node.children || []).find((c) => c.label === label);
    if (!node) return null;
  }
  return node;
}

function cloneTwig(node) {
  return { label: node.label, intro: node.intro, children: (node.children || []).map(cloneTwig) };
}

function applyPaths(paths) {
  Object.entries(CHAIN_ATTACH).forEach(([code, attach]) => {
    const field = FIELD_TREES[code];
    const path = paths && paths[code];
    if (!field || !path || field.chain || !(path.steps || []).length) return;
    const old = field.root;
    const steps = path.steps.map((st) => ({
      label: st.name,
      intro: `先弄懂：${st.focus}`,
      done_when: st.done_when,
      stage: st.step,
      main: true,
      // 挂上来的整支和这一步同名（如经济第 2 步「激励」挂「激励」）时，直接挂它的子节点，免得出现「激励 — 激励」
      children: (attach[st.step] || []).map((lp) => findTwig(old, lp)).filter(Boolean).map(cloneTwig)
        .flatMap((tw) => (tw.label === st.name.split("：")[0] && tw.children.length ? tw.children : [tw])),
    }));
    field.root = stampTree({ label: path.name, intro: path.goal, virtual: true, children: steps }, code);
    field.chain = true;
    field.sourceDoc = path.source_doc;
  });
}

const BACKEND_CODES = ["ai", "math", "stat", "psy", "econ", "se", "med"];
const TUTORIALS = {};

function chainFromSpec(code, spec) {
  const steps = (spec.steps || []).map((row, i) => ({
    label: row[0],
    intro: `先弄懂：${row[1]}`,
    done_when: row[2],
    stage: i + 1,
    main: true,
    children: [],
  }));
  return {
    code,
    name: spec.name,
    query: spec.query,
    chain: true,
    root: stampTree({ label: spec.name, intro: spec.goal, virtual: true, children: steps }, code),
  };
}

function buildTutorials() {
  Object.keys(TUTORIALS).forEach((k) => { delete TUTORIALS[k]; });
  Object.assign(TUTORIALS, FIELD_TREES);
  const extra = (window.RG_DIR && RG_DIR.extra) || {};
  Object.entries(extra).forEach(([key, spec]) => {
    TUTORIALS[key] = chainFromSpec(key, spec);
  });
}

function tutorialOf(dirId) {
  if (window.RG_DIR && dirId) {
    const key = RG_DIR.tutorialKey(dirId);
    if (key && TUTORIALS[key]) return TUTORIALS[key];
  }
  return FIELD_TREES[dirId] || null;
}

function activeField(t) {
  return tutorialOf(t && t.dir) || FIELD_TREES[t && t.code] || null;
}

function dirTitle(dirId, field) {
  if (window.RG_DIR && dirId && RG_DIR.displayName(dirId)) return RG_DIR.displayName(dirId);
  return (field && field.name) || "";
}

function entryNode(field) {
  return pathNodes(field)[0];
}

function stepOf(field, nodeId) {
  // 节点所在的主干步骤：主干步骤的 id 是「方向.序号」，往下的节点都以它为前缀
  if (!field.chain || !nodeId) return null;
  const parts = nodeId.split(".");
  return flattenField(field.root).byId[parts.slice(0, 2).join(".")] || null;
}

function findProjectsForStep(code, step) {
  S.projectForm = { direction: code, stage: { 1: 0, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3 }[step] || 0, pathStep: step, keywords: "" };
  S.projectResult = null;
  S.projectTab = "find";
  setView("projects");
}

function flattenField(root) {
  const levels = [];
  const byId = {};
  const walk = (node, depth, parent) => {
    const item = { ...node, depth, parent, children: node.children || [] };
    byId[node.id] = item;
    (levels[depth] = levels[depth] || []).push(item);
    item.children.forEach((child) => walk(child, depth + 1, node.id));
  };
  walk(root, 0, null);
  return { levels, byId };
}

function trailStorageKey() {
  return "rg_trail_" + S.uid + (S.portraitId ? "_" + S.portraitId : "");
}

/* 新建、切换、删除画像一次只做一件：连点 B 再点 C，两个请求的响应可能倒着回来，
   原来按回来的顺序记，前端停在 B、服务器在 C，任务区就拿 B 的教程在 C 里建任务（Codex 复现）。
   做完以服务器回的「哪一份是当前的」为准，不以点了哪个为准。 */
let portraitBusy = false;
async function portraitOp(run, nextView) {
  if (portraitBusy) { toast("正在切换画像，稍等"); return; }
  portraitBusy = true;
  try {
    const r = await run();
    if (r === null) return;
    const active = ((r && r.portraits) || []).find((item) => item.active);
    S.portraitId = active ? active.id : "";
    S.myDir = undefined;  // 方向是画像的：换了画像要重新问（原来切到数学画像，研读和信息源还按 AI 提示，Codex 复现）
    setView(nextView);
  } catch (e) {
    toast(e.message);
  } finally {
    portraitBusy = false;
  }
}

async function ensurePortrait() {
  if (S.portraitId) return S.portraitId;
  try {
    const r = await api("GET", `/api/portraits?uid=${S.uid}`);
    const active = (r.portraits || []).find((p) => p.active);
    S.portraitId = active ? active.id : "";
  } catch (_) {
    S.portraitId = "";
  }
  if (S.portraitId) adoptLegacyTrail(S.portraitId);
  return S.portraitId;
}

function adoptLegacyTrail(pid) {
  const ownerKey = "rg_trail_owner_" + S.uid;
  if (localStorage.getItem(ownerKey)) return;
  const legacy = localStorage.getItem("rg_trail_" + S.uid);
  if (legacy) localStorage.setItem("rg_trail_" + S.uid + "_" + pid, legacy);
  localStorage.setItem(ownerKey, pid);
}

function trail() {
  try {
    const t = JSON.parse(localStorage.getItem(trailStorageKey()) || "null");
    if (t && typeof t === "object") {
      const code = t.code || "";
      const mapped = window.RG_DIR && RG_DIR.legacyDir[code];
      return {
        code,
        dir: t.dir || mapped || "",
        done: Array.isArray(t.done) ? t.done : [],
        tasks: t.tasks && typeof t.tasks === "object" ? t.tasks : {},
      };
    }
  } catch (_) { /* 坏数据就当没有进度 */ }
  return { code: "", dir: "", done: [], tasks: {} };
}

function saveTrail(t, force) {
  const prev = trail();
  const code = t.code || "";
  let done = t.done || [];
  const field = FIELD_TREES[code];
  if (!force && prev.code === code && field) {
    const path = pathNodes(field);
    const prevAt = currentOnPath(field, prev.done);
    const nextAt = currentOnPath(field, done);
    const prevI = prevAt ? path.findIndex((n) => n.id === prevAt.id) : path.length;
    const nextI = nextAt ? path.findIndex((n) => n.id === nextAt.id) : path.length;
    if (nextI < prevI) done = prev.done;
  }
  localStorage.setItem(trailStorageKey(), JSON.stringify({
    code,
    dir: t.dir || (force ? "" : prev.dir) || (window.RG_DIR && RG_DIR.legacyDir[code]) || "",
    done,
    tasks: force ? (t.tasks || {}) : Object.assign({}, prev.code === code && prev.dir === (t.dir || prev.dir) ? prev.tasks : {}, t.tasks || {}),
  }));
}

function inferredDone(code, tasks) {
  const field = FIELD_TREES[code];
  if (!field) return [];
  const path = pathNodes(field);
  let furthest = -1;
  path.forEach((node, i) => {
    const title = node.label.slice(0, 40);
    if ((tasks || []).some((tk) => tk.direction === code && tk.title === title)) furthest = i;
  });
  if (furthest <= 0) return [];
  return path.slice(0, furthest).map((n) => n.id);
}

function mergeTrail(code, tasks) {
  const local = trail();
  const field = FIELD_TREES[code];
  const inferred = inferredDone(code, tasks);
  if (!field) return local;
  if (local.code !== code) {
    return { code, dir: local.dir || (window.RG_DIR && RG_DIR.legacyDir[code]) || "", done: inferred, tasks: {} };
  }
  const path = pathNodes(field);
  const localAt = currentOnPath(field, local.done);
  const inferredAt = currentOnPath(field, inferred);
  const localI = localAt ? path.findIndex((n) => n.id === localAt.id) : path.length;
  const inferredI = inferredAt ? path.findIndex((n) => n.id === inferredAt.id) : path.length;
  if (inferredI > localI) return { code, dir: local.dir, done: inferred, tasks: local.tasks || {} };
  return local;
}

function adoptDirection(facts) {
  // 方向写在事实里（服务端），进度写在本机；本机还没有进度时，从事实里接过方向
  const t = trail();
  if (t.code) return t;
  const dirs = (facts || []).filter((f) => (f.key || "").startsWith("direction:")
    && (f.status === "confirmed" || f.status === "active"));
  const chosen = dirs[dirs.length - 1];
  const code = chosen ? chosen.key.split(":")[1] : "";
  if (!code || !FIELD_TREES[code]) return t;
  const next = { code, dir: (window.RG_DIR && RG_DIR.legacyDir[code]) || "", done: [], tasks: {} };
  saveTrail(next);
  return next;
}

function pathNodes(field) {
  const out = [];
  const walk = (node) => {
    if (!node.virtual) out.push(node);  // 主干的虚拟根只用来挂六步，不算一个节点
    (node.children || []).forEach(walk);
  };
  walk(field.root);
  return out;
}

function currentOnPath(field, done) {
  const seen = new Set(done || []);
  return pathNodes(field).find((node) => !seen.has(node.id)) || null;
}

function drawFieldTree(field, picked, onPick, progress, animate) {
  // 整齐树布局：叶子各占一行，父节点落在子节点的中线上，连线不会交叉
  const { byId } = flattenField(field.root);
  const narrow = window.innerWidth < 920;
  const COL = narrow ? 128 : 168;
  const ROW = narrow ? 42 : 50;
  const NODE_W = narrow ? 104 : 128;
  const MAIN_W = narrow ? 140 : 212;
  const NODE_H = 34;
  const PAD = narrow ? 24 : 30;
  const shift = field.root.virtual ? 1 : 0;
  const colX = (depth) => {
    const d = depth - shift;
    if (!field.chain) return d * COL;
    return d === 0 ? 0 : MAIN_W + (COL - NODE_W) + (d - 1) * COL;
  };
  const wOf = (node) => (node.main ? MAIN_W : NODE_W);
  const pos = {};
  let row = 0;
  let depthMax = 0;
  const place = (node, depth) => {
    depthMax = Math.max(depthMax, depth);
    const kids = node.children || [];
    if (!kids.length) {
      pos[node.id] = { x: colX(depth), y: row * ROW };
      row += 1;
      return;
    }
    kids.forEach((k) => place(k, depth + 1));
    const first = pos[kids[0].id].y;
    const last = pos[kids[kids.length - 1].id].y;
    // 主干步骤放在它那组节点的第一行，六步从上到下排成一条线
    pos[node.id] = { x: colX(depth), y: node.main ? first : (first + last) / 2 };
  };
  place(field.root, 0);
  const width = colX(depthMax) + (depthMax - shift === 0 ? MAIN_W : NODE_W) + PAD * 2;
  const height = (row - 1) * ROW + NODE_H + PAD * 2;

  const box = el("div", "frontier");
  box.style.width = width + "px";
  box.style.height = height + "px";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "frontier-svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  const layer = el("div", "frontier-nodes");
  const done = new Set((progress && progress.done) || []);
  const here = progress && progress.here;
  const onPickPath = (id) => picked && (picked === id || picked.startsWith(id + "."));

  if (field.chain) {
    // 主干：六步之间一条粗线，走过的部分用主色
    const mains = Object.values(byId).filter((n) => n.main).sort((m, n) => m.stage - n.stage);
    mains.slice(1).forEach((node, i) => {
      const a = pos[mains[i].id];
      const b = pos[node.id];
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(PAD + 18)); line.setAttribute("x2", String(PAD + 18));
      line.setAttribute("y1", String(PAD + a.y + NODE_H)); line.setAttribute("y2", String(PAD + b.y));
      const passed = done.has(mains[i].id) && (done.has(node.id) || here === node.id || (here || "").startsWith(node.id + "."));
      line.setAttribute("class", "frontier-trunk" + (passed ? " is-past" : ""));
      svg.appendChild(line);
    });
  }

  Object.values(byId).forEach((node) => {
    if (!node.parent || byId[node.parent].virtual) return;
    const a = pos[node.parent];
    const b = pos[node.id];
    const x1 = PAD + a.x + wOf(byId[node.parent]);
    const y1 = PAD + a.y + NODE_H / 2;
    const x2 = PAD + b.x;
    const y2 = PAD + b.y + NODE_H / 2;
    const mid = x1 + (x2 - x1) * 0.5;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
    const cls = ["frontier-link"];
    if (onPickPath(node.id)) cls.push("is-hot");
    else if (done.has(node.id) || here === node.id) cls.push("is-past");
    if (animate) { cls.push("reveal"); path.style.setProperty("--d", String(node.depth)); }
    path.setAttribute("class", cls.join(" "));
    svg.appendChild(path);
  });

  Object.values(byId).forEach((node) => {
    if (node.virtual) return;
    const flags = [
      "frontier-node",
      node.main ? "is-main" : "",
      node.id === picked ? "is-pick" : "",
      onPickPath(node.id) && node.id !== picked ? "is-path" : "",
      done.has(node.id) ? "is-past" : "",
      here === node.id ? "is-now" : "",
      animate ? "reveal" : "",
    ].filter(Boolean).join(" ");
    const short = node.main ? node.label.split("：")[0] : node.label;
    const btn = el("button", flags, node.main ? `<b class="step-no">${node.stage}</b><span>${esc(short)}</span>` : esc(node.label));
    btn.type = "button";
    btn.title = node.main ? `第 ${node.stage} 步 · ${node.label}` : node.label;
    btn.style.left = PAD + pos[node.id].x + "px";
    btn.style.top = PAD + pos[node.id].y + "px";
    btn.style.width = wOf(node) + "px";
    if (animate) btn.style.setProperty("--d", String(node.depth));
    if (here === node.id) btn.setAttribute("aria-current", "step");
    btn.onclick = () => onPick(byId[node.id]);
    layer.appendChild(btn);
  });
  box.append(svg, layer);
  return box;
}

function openNodeSheet(field, node, ctx) {
  let sheet = document.getElementById("nodeSheet");
  if (!sheet) {
    sheet = el("aside", "node-sheet");
    sheet.id = "nodeSheet";
    document.body.appendChild(sheet);
  }
  // 这里原来写的是 "node-sheet open"，但 styles.css 里没有 `.open` 这条规则：
  // 抽屉的样式是无条件生效的，关掉是把这个元素 remove 掉。
  // 一个不起作用的类名会让人以为存在开/关两态，去掉。
  sheet.className = "node-sheet";
  sheet.innerHTML = "";
  const head = el("div", "sheet-head");
  const x = el("button", "sheet-x", "关闭");
  x.type = "button";
  x.onclick = () => sheet.remove();
  head.append(el("p", "sheet-kicker", esc(field.name)), x);
  sheet.appendChild(head);
  const entry = entryNode(field);
  if (node.main) sheet.appendChild(el("p", "sheet-label", `主干 · 第 ${node.stage} 步（这一学期走到哪）`));
  sheet.appendChild(el("h3", "", esc(node.label)));
  sheet.appendChild(el("p", "sheet-intro", esc(node.intro || "")));
  if (node.main && node.done_when) {
    sheet.appendChild(el("div", "why-box", `<b>做完怎样算过了　</b>${esc(node.done_when)}`));
    const find = el("button", "btn secondary", "找能交出这一步的项目");
    find.type = "button";
    find.onclick = () => { document.getElementById("nodeSheet")?.remove(); findProjectsForStep(field.backend || field.code, node.stage); };
    sheet.appendChild(find);
  }
  if (node.id === entry.id && ctx.why) {
    sheet.appendChild(el("p", "sheet-why", esc(ctx.why)));
  }
  if (node.children && node.children.length) {
    sheet.appendChild(el("p", "sheet-label", "往下"));
    const row = el("div", "sheet-nexts");
    node.children.forEach((child) => {
      const b = el("button", "sheet-next", esc(child.label));
      b.type = "button";
      b.onclick = () => ctx.onPick(child.id);
      row.appendChild(b);
    });
    sheet.appendChild(row);
  }
  if (ctx.here === node.id && ctx.chosen) {
    const go = el("button", "btn", "去做这一步");
    go.type = "button";
    go.onclick = () => setView("workbench");
    sheet.appendChild(go);
  }
  const courses = el("div", "course-block");
  courses.appendChild(el("h4", "", "课程"));
  courses.appendChild(el("div", "course-status", "检索中"));
  sheet.appendChild(courses);
  loadCourses(courses, node.label || field.query);
  if (node.id === entry.id && !ctx.chosen) {
    const choose = el("button", "btn", ctx.hasCurrent ? "确认切换方向" : "确认这个方向");
    choose.type = "button";
    choose.onclick = () => ctx.onChoose();
    sheet.appendChild(choose);
  }
  sheet.querySelector(".sheet-x").focus({ preventScroll: true });
}

function cloneDirNode(node) {
  return {
    id: node.id,
    label: node.label,
    intro: node.blurb || "",
    query: node.query,
    name: node.name,
    children: (node.children || []).map(cloneDirNode),
  };
}

function visibleTaxonomy(branch) {
  const children = ((window.RG_DIR && RG_DIR.tree) || []).map((l1) => {
    const copy = cloneDirNode(l1);
    if (l1.id !== branch) copy.children = [];
    return copy;
  });
  return {
    name: "学科方向",
    query: "学科",
    root: { id: "dir-root", label: "学科", intro: "", virtual: true, children },
  };
}

function recDirIds(recommended) {
  const out = new Set();
  if (!window.RG_DIR) return out;
  recommended.forEach((code) => {
    const id = RG_DIR.legacyDir[code];
    if (id) out.add(id);
    if (id && RG_DIR.l1Of(id)) out.add(RG_DIR.l1Of(id));
  });
  return out;
}

function openDirSheet(node, ctx) {
  let sheet = document.getElementById("nodeSheet");
  if (!sheet) {
    sheet = el("aside", "node-sheet");
    sheet.id = "nodeSheet";
    document.body.appendChild(sheet);
  }
  sheet.className = "node-sheet open";
  sheet.innerHTML = "";
  const head = el("div", "sheet-head");
  const x = el("button", "sheet-x", "关闭");
  x.type = "button";
  x.onclick = () => sheet.remove();
  const meta = window.RG_DIR && RG_DIR.byId[node.id];
  const level = meta ? (["", "一级", "二级", "三级"][meta.depth] || "方向") : "方向";
  head.append(el("p", "sheet-kicker", `${level}${meta && meta.parent ? ` · 上属${esc(dirTitle(meta.parent))}` : ""}`), x);
  sheet.appendChild(head);
  sheet.appendChild(el("h3", "", esc(node.name || node.label)));
  if (node.name && node.label && node.name !== node.label) {
    sheet.appendChild(el("p", "sheet-kicker", esc(node.label)));
  }
  sheet.appendChild(el("p", "sheet-intro", esc(node.intro || (meta && meta.blurb) || "")));
  if (ctx.why) sheet.appendChild(el("p", "sheet-why", esc(ctx.why)));
  if (node.children && node.children.length) {
    sheet.appendChild(el("p", "sheet-label", "往下"));
    const row = el("div", "sheet-nexts");
    node.children.forEach((child) => {
      const b = el("button", "sheet-next", esc(child.label));
      b.type = "button";
      b.onclick = () => ctx.onPick(child.id);
      row.appendChild(b);
    });
    sheet.appendChild(row);
  }
  const courses = el("div", "course-block");
  courses.appendChild(el("h4", "", "课程"));
  courses.appendChild(el("div", "course-status", "检索中"));
  sheet.appendChild(courses);
  loadCourses(courses, (meta && meta.query) || node.query || node.label);
  if (!ctx.chosen) {
    const choose = el("button", "btn", ctx.hasCurrent ? "确认切换方向" : "确认这个方向");
    choose.type = "button";
    choose.onclick = () => ctx.onChoose();
    sheet.appendChild(choose);
  } else {
    const go = el("button", "btn", "看这个方向的教程");
    go.type = "button";
    go.onclick = () => { sheet.remove(); S.cardsPane = "tutorial"; render(); };
    sheet.appendChild(go);
  }
  sheet.querySelector(".sheet-x").focus({ preventScroll: true });
}

async function renderCards() {
  const seq = S.renderSeq;
  await ensurePortrait();
  if (stale(seq)) return;
  if (!Object.keys(TUTORIALS).length) buildTutorials();
  let saved = trail();
  let serverTasks = [];
  try {
    const taskRes = await api("GET", `/api/tasks?uid=${S.uid}`);
    if (stale(seq)) return;
    serverTasks = taskRes.tasks || [];
    if (saved.code) {
      const merged = mergeTrail(saved.code, taskRes.tasks || []);
      if (merged.done.join(",") !== saved.done.join(",")) saveTrail(merged);
    }
  } catch (_) { /* 树先按本地进度画 */ }
  if (stale(seq)) return;
  saved = trail();
  let chosenCode = saved.code && FIELD_TREES[saved.code] ? saved.code : "";
  let chosenDir = saved.dir && window.RG_DIR && RG_DIR.byId[saved.dir]
    ? saved.dir
    : ((window.RG_DIR && RG_DIR.legacyDir[chosenCode]) || "");
  let cards = [];
  let recommended = new Set();
  let focus = (S.dirFocus && window.RG_DIR && RG_DIR.byId[S.dirFocus])
    ? S.dirFocus
    : (chosenDir || "520");
  let branch = (S.dirBranch && window.RG_DIR && RG_DIR.byId[S.dirBranch])
    ? S.dirBranch
    : ((window.RG_DIR && RG_DIR.l1Of(focus)) || "520");
  let pane = S.cardsPane === "tutorial" ? "tutorial" : "direction";
  let picked = S.dirPicked || null;
  let tutPicked = S.tutPicked || null;
  let touched = !!(chosenDir || chosenCode);
  let grew = true;

  $app.innerHTML = "";
  const head = el("header", "ws-head cards-head");
  const titles = el("div");
  titles.appendChild(el("h2", "", pane === "tutorial" ? "教程" : "方向"));
  head.appendChild(titles);
  const tabs = el("nav", "ws-tabs");
  tabs.setAttribute("role", "tablist");
  [["direction", "方向"], ["tutorial", "教程"]].forEach(([id, label]) => {
    const b = el("button", `ws-tab${pane === id ? " on" : ""}`, label);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", pane === id ? "true" : "false");
    b.onclick = () => {
      S.cardsPane = id;
      pane = id;
      document.getElementById("nodeSheet")?.remove();
      grew = true;
      paint();
    };
    tabs.appendChild(b);
  });
  head.appendChild(tabs);
  $app.appendChild(head);
  const recLine = el("div", "rec-line");
  const confirmBar = el("div", "switch-bar");
  const stage = el("div", "forest-stage");
  const legend = el("div", "tree-legend");
  $app.append(recLine, confirmBar, stage, legend);

  const viewName = () => dirTitle(focus) || "未选方向";
  const recWhy = () => {
    const backend = window.RG_DIR ? RG_DIR.backendCode(focus) : "";
    const card = cards.find((c) => c.direction && c.direction.code === backend);
    return card && card.why_you;
  };

  const chooseFocus = async () => {
    if (!window.RG_DIR || !RG_DIR.byId[focus]) { toast("先点树上的一个方向"); return; }
    // 发请求前把选的节点、后端方向、画像都记下：请求在路上时又点了别的节点，原来会把那个节点存成方向（Codex 复现）
    const target = focus;
    const portrait = S.portraitId;
    const backend = RG_DIR.backendCode(target);
    const field = tutorialOf(target) || FIELD_TREES[backend];
    try {
      await api("POST", "/api/directions/choose", { uid: S.uid, code: backend });
      if (S.portraitId !== portrait) return;  // 期间切了画像：这次确认已经不属于眼前这份画像
      const switching = !!(chosenDir && chosenDir !== target);
      saveTrail({ code: backend, dir: target, done: [], tasks: {} }, true);
      S.myDir = undefined;
      chosenCode = backend;
      chosenDir = target;
      const name = dirTitle(target) || "未选方向";
      toast(switching
        ? `已切换到「${name}」${field ? `，教程从「${entryNode(field).label}」重新开始` : ""}`
        : `已确认「${name}」${field ? `，教程从「${entryNode(field).label}」开始` : ""}`);
      document.getElementById("nodeSheet")?.remove();
      picked = null;
      S.dirPicked = null;
      paint();
    } catch (e) { toast(e.message); }
  };

  const paintRec = () => {
    recLine.innerHTML = "";
    if (pane === "tutorial") return;
    if (!cards.length) {
      recLine.appendChild(el("p", "", "这份画像还没有可对照的兴趣。先在画像里把对话做完，建议才会标到树上。"));
      return;
    }
    const names = cards.map((c) => {
      const code = c.direction && c.direction.code;
      const id = window.RG_DIR && RG_DIR.legacyDir[code];
      return (id && RG_DIR.displayName(id)) || (FIELD_TREES[code] && FIELD_TREES[code].name) || (c.direction && c.direction.name) || "";
    }).filter(Boolean);
    recLine.appendChild(el("p", "", `这份画像更贴近${names.map(esc).join("、")}。${esc(cards[0].why_you || "")}`));
    if (window.innerWidth < 920) {
      recLine.classList.add("clamp");
      recLine.onclick = () => recLine.classList.remove("clamp");
    }
  };

  const paintBar = (field, here) => {
    confirmBar.innerHTML = "";
    const name = viewName();
    if (pane === "direction") {
      if (!chosenDir || focus !== chosenDir) {
        const note = el("p", "", chosenDir
          ? `正在看「${name}」。当前方向仍是「${dirTitle(chosenDir)}」。`
          : `正在看「${name}」。确认之后，它才会成为当前方向。`);
        const ok = el("button", "btn small", chosenDir ? "确认切换方向" : "确认这个方向");
        ok.type = "button";
        ok.onclick = () => chooseFocus();
        confirmBar.append(note, ok);
      } else {
        const note = el("p", "", `当前方向「${name}」。切换到教程看这条学习流程。`);
        const go = el("button", "btn small", "看教程");
        go.type = "button";
        go.onclick = () => { S.cardsPane = "tutorial"; pane = "tutorial"; grew = true; paint(); };
        confirmBar.append(note, go);
      }
      return;
    }
    titles.querySelector("h2").textContent = "教程";
    if (!focus || !field) {
      confirmBar.appendChild(el("p", "", "先在方向页点一个方向，再回到这里看它的学习流程。"));
      return;
    }
    const lead = el("p", "", chosenDir === focus
      ? (here ? `当前方向「${name}」，你在「${here.label}」。` : `当前方向「${name}」。`)
      : `教程跟着正在看的「${name}」走。确认之后，任务才会按它开始。`);
    confirmBar.appendChild(lead);
    if (chosenDir !== focus) {
      const ok = el("button", "btn small", chosenDir ? "确认切换方向" : "确认这个方向");
      ok.type = "button";
      ok.onclick = () => chooseFocus();
      confirmBar.appendChild(ok);
    } else if (here) {
      const go = el("button", "btn small", "去做这一步");
      go.type = "button";
      go.onclick = () => setView("workbench");
      confirmBar.appendChild(go);
    }
  };

  const showDir = (id) => {
    if (!window.RG_DIR || !RG_DIR.byId[id]) return;
    focus = id;
    S.dirFocus = id;
    branch = RG_DIR.l1Of(id) || branch;
    S.dirBranch = branch;
    picked = id;
    S.dirPicked = id;
    touched = true;
    grew = true;
    paint();
    const meta = RG_DIR.byId[id];
    openDirSheet({
      id: meta.id, label: meta.label, name: meta.name, intro: meta.blurb, query: meta.query,
      children: meta.children,
    }, {
      why: recWhy(),
      chosen: id === chosenDir,
      hasCurrent: !!chosenDir,
      onPick: showDir,
      onChoose: chooseFocus,
    });
  };

  const showTut = (id) => {
    const field = tutorialView(focus);
    if (!field) return;
    const node = flattenField(field.root).byId[id];
    if (!node) return;
    tutPicked = id;
    S.tutPicked = id;
    paint();
    const hereTrail = trail();
    const here = hereTrail.dir === focus ? currentOnPath(field, hereTrail.done) : null;
    openNodeSheet(field, node, {
      why: recWhy(),
      chosen: focus === chosenDir,
      hasCurrent: !!chosenDir,
      here: here && here.id,
      onPick: showTut,
      onChoose: chooseFocus,
    });
  };

  function tutorialView(dirId) {
    const tut = tutorialOf(dirId);
    if (!tut) return null;
    const q = (window.RG_DIR && RG_DIR.byId[dirId] && RG_DIR.byId[dirId].query) || tut.query;
    return { ...tut, name: dirTitle(dirId, tut), query: q, backend: window.RG_DIR ? RG_DIR.backendCode(dirId) : tut.code };
  }

  const paint = () => {
    titles.querySelector("h2").textContent = pane === "tutorial" ? "教程" : "方向";
    if (pane === "tutorial") {
      const name = viewName();
      titles.querySelector("p")?.remove();
      const lead = el("p", "dir-now", name === "未选方向" ? "还没有选方向" : `当前方向 · ${name}`);
      titles.appendChild(lead);
    } else {
      titles.querySelector("p")?.remove();
      titles.appendChild(el("p", "", "一棵学科树。点一级展开二级，热门方向有三级。统计在数学下面，医学只做基础医学。"));
    }
    tabs.querySelectorAll(".ws-tab").forEach((b, i) => {
      const on = (i === 0 ? "direction" : "tutorial") === pane;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    paintRec();
    stage.classList.toggle("is-dir", pane === "direction");
    const hereTrail = trail();
    if (pane === "direction") {
      const tax = visibleTaxonomy(branch);
      paintBar(null, null);
      legend.innerHTML = '<span class="now"><i></i>正在看</span><span class="past"><i></i>已确认</span><span><i></i>点一级展开</span><span>点节点看说明和课</span>';
      stage.innerHTML = "";
      stage.appendChild(drawFieldTree(tax, picked || focus, (node) => showDir(node.id), {
        done: chosenDir && chosenDir !== focus ? [chosenDir] : [],
        here: focus,
      }, grew));
    } else {
      const field = tutorialView(focus);
      const here = field && hereTrail.dir === focus ? currentOnPath(field, hereTrail.done) : null;
      paintBar(field, here);
      if (!field) {
        stage.innerHTML = "";
        legend.innerHTML = "";
        stage.appendChild(emptyPanel("先在方向页点一个方向，教程会跟着那个方向走。", "去方向树", "cards"));
        const btn = stage.querySelector("button");
        if (btn) btn.onclick = () => { S.cardsPane = "direction"; pane = "direction"; grew = true; paint(); };
      } else {
        legend.innerHTML = (field.chain ? '<span class="main"><i>1</i>主干：这一学期走到哪</span>' : "")
          + '<span class="now"><i></i>你在这里</span><span class="past"><i></i>已走过</span><span><i></i>还可以去</span>'
          + `<span>${field.chain ? "节点：二十分钟一件事；点主干看过关标准" : "点任一节点看说明"}</span>`;
        stage.innerHTML = "";
        stage.appendChild(drawFieldTree(field, tutPicked, (node) => showTut(node.id), {
          done: hereTrail.dir === focus ? hereTrail.done : [],
          here: here && here.id,
        }, grew));
      }
    }
    grew = false;
  };

  paint();
  api("GET", `/api/onboard/result?uid=${S.uid}`).then((onboard) => {
    if (stale(seq)) return;
    const facts = ((onboard && onboard.facts) || []).filter((f) => f.status !== "deleted" && f.status !== "dismissed");
    const dirs = facts.filter((f) => (f.key || "").startsWith("direction:") && (f.status === "confirmed" || f.status === "active"));
    const chosen = dirs[dirs.length - 1];
    const code = chosen ? chosen.key.split(":")[1] : "";
    if (code && FIELD_TREES[code] && !trail().code) {
      const merged = mergeTrail(code, serverTasks);
      merged.dir = merged.dir || (window.RG_DIR && RG_DIR.legacyDir[code]) || "";
      saveTrail(merged);
      chosenCode = code;
      chosenDir = merged.dir;
      focus = chosenDir || focus;
      branch = (window.RG_DIR && RG_DIR.l1Of(focus)) || branch;
      S.dirFocus = focus;
      S.dirBranch = branch;
      touched = true;
      grew = true;
      paint();
    } else if (trail().code && trail().code !== chosenCode) {
      const t = trail();
      chosenCode = t.code;
      chosenDir = t.dir || chosenDir;
      paint();
    }
  }).catch(() => {});
  api("GET", `/api/directions/recommend?uid=${S.uid}`).then((rec) => {
    if (stale(seq)) return;
    cards = rec.cards || [];
    recommended = new Set(cards.map((c) => c.direction && c.direction.code).filter(Boolean));
    const marks = recDirIds(recommended);
    if (!touched && marks.size && window.RG_DIR) {
      const top = cards[0] && cards[0].direction && cards[0].direction.code;
      const id = RG_DIR.legacyDir[top];
      if (id) {
        focus = id;
        branch = RG_DIR.l1Of(id);
        S.dirFocus = focus;
        S.dirBranch = branch;
        grew = true;
      }
    }
    paint();
  }).catch(() => {});
}

async function loadCourses(box, query) {
  const status = box.querySelector(".course-status");
  try {
    const r = await api("GET", `/api/explore/courses?query=${encodeURIComponent(query)}&limit=6`);
    if (!r.ok) { status.textContent = `检索失败（如实说明）：${r.error || "未知错误"}`; return; }
    status.remove();
    const mark = r.source === "catalog" ? "快照" : "实时";
    const head = box.querySelector("h4");
    if (head) head.dataset.source = mark;
    if (!r.items || !r.items.length) {
      box.appendChild(el("div", "course-status", `「${esc(query)}」没有对上的课。查的是本学期公开课快照，对不上就空着。`));
      return;
    }
    r.items.forEach((it) => {
      const name = it.name || it.courseName || "(未命名课程)";
      const names = (it.teacher_names && it.teacher_names.length)
        ? it.teacher_names
        : String(it.teachers || it.teacher || "").split(/[/／、;；,，|]+/).map((n) => n.trim()).filter((n) => n.length >= 2);
      const dept = it.department || it.dept || "";
      const row = el("div", "course-item", `${esc(name)}<br>`);
      const meta = el("span", "meta");
      names.forEach((n, i) => {
        if (i) meta.appendChild(document.createTextNode(" "));
        const b = el("button", "teacher-link", esc(n));
        b.type = "button";
        b.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          showTeacher(n);
        });
        meta.appendChild(b);
      });
      const extra = [dept, r.term].filter(Boolean).join(" · ");
      if (extra) meta.appendChild(document.createTextNode((names.length ? " · " : "") + extra));
      row.appendChild(meta);
      box.appendChild(row);
    });
  } catch (e) {
    status.textContent = `检索失败（如实说明）：${e.message}`;
  }
}

async function showTeacher(name) {
  name = String(name || "").trim();
  if (!name) return;
  document.getElementById("teacherSheet")?.remove();
  const sheet = el("div", "node-sheet teacher-sheet");
  sheet.id = "teacherSheet";
  const head = el("div", "sheet-head");
  head.appendChild(el("span", "sheet-kicker", "授课老师"));
  const back = el("button", "sheet-x", "返回");
  back.type = "button";
  back.onclick = () => sheet.remove();
  head.appendChild(back);
  sheet.appendChild(head);
  sheet.appendChild(el("h3", "", esc(name)));
  const status = el("p", "sheet-intro", "正在读本学期快照…");
  sheet.appendChild(status);
  document.body.appendChild(sheet);
  back.focus({ preventScroll: true });
  try {
    const r = await api("GET", `/api/explore/teachers?name=${encodeURIComponent(name)}`);
    if (!r.ok) { status.textContent = r.error || "快照里没有这位老师。"; return; }
    status.remove();
    if (r.departments && r.departments.length) {
      sheet.appendChild(el("p", "sheet-kicker", esc(r.departments.join(" · "))));
    }
    if (r.bio) sheet.appendChild(el("p", "sheet-intro", esc(r.bio)));
    else sheet.appendChild(el("p", "sheet-intro", "没有对上北京大学的公开学者简介，这里只列出本学期教的课。"));
    sheet.appendChild(el("p", "sheet-label", `本学期课程 · ${esc(r.term || "")}`));
    (r.courses || []).forEach((c) => {
      sheet.appendChild(el("div", "course-item", `${esc(c.name || "")}<br><span class="meta">${esc([c.department, c.credits].filter(Boolean).join(" · "))}</span>`));
    });
  } catch (e) {
    status.textContent = e.message;
  }
}

/* ---------- ⑤⑥ 工作台 ---------- */

function readDraft(tid) {
  try { return localStorage.getItem(`rg_draft_${S.uid}_${tid}`) || ""; } catch (_) { return ""; }
}
function writeDraft(tid, text) {
  try {
    if (text) localStorage.setItem(`rg_draft_${S.uid}_${tid}`, text);
    else localStorage.removeItem(`rg_draft_${S.uid}_${tid}`);
  } catch (_) { /* 存不了就算了，不影响提交 */ }
}

function emptyPanel(text, label, view) {
  const p = el("div", "panel");
  p.appendChild(el("p", "panel-sub", text));
  if (label) {
    const b = el("button", "btn", label);
    b.type = "button";
    b.style.marginTop = "16px";
    b.onclick = () => setView(view);
    p.appendChild(b);
  }
  return p;
}

/* ---------- 任务渲染：对话出的和树上出的用同一套 ---------- */

/* 「填入演示示例」用的样例：演示时手上没有材料，点一下就有内容可提交。
   它存在的唯一目的是别让演示卡在「没东西可写」。 */
const DEMO_ANSWER =
  "10 条弹幕：「太好哭了」「就这？」「编剧封神」「注水严重」「封神」「看不下去了」「细节绝了」「一般」「泪目」「神剧」\n\n" +
  "不一致例子 1：「太好哭了」——规则判积极（含「哭」可能误判消极），模型判积极。原因：规则把「哭」当消极词，但语境是感动。\n" +
  "不一致例子 2：「就这？」——规则因为无情感词判中性，模型判消极。原因：反问语气规则抓不到，模型学了语料里的讽刺用法。\n" +
  "不一致例子 3：「封神」——规则词表里没有，判中性；模型判积极。原因：网络新词，词表更新慢，模型能从上下文推断。\n\n" +
  "总结：模型的错误多来自词表覆盖与语境缺失两类；因为规则的可解释性和模型的表达力正好互补，可以互为校验。所以每次重要判断最好两个方法都跑一遍，不一致的例子就是最有价值的学习样本。";

/* 一个任务必须回答三个问题，否则用户不知道要干什么：
     做什么（步骤）· 交什么（交付物）· 怎样算做到（评分标准）
   以前只画了「步骤」和「怎样算做到」，没有「交什么」——
   所以对话里出现任务时，用户最自然的反应就是「这是要我怎么完成」。

   opts.onDone：完成后的去处（对话任务回对话，树任务进下一节点） */
function taskPanel(task, opts) {
  opts = opts || {};
  const p = el("div", "panel task-panel");
  const head = el("div", "task-head");
  const hl = el("div");
  hl.appendChild(el("h2", "task-title", esc(opts.title || task.title)));
  hl.appendChild(el("p", "task-brief", esc(opts.intro || task.brief || "")));
  head.appendChild(hl);
  head.appendChild(el("span", "task-meta", `约 ${task.time_budget_min} 分钟`));
  p.appendChild(head);
  // 来源标出来，用户才知道「这个任务是哪来的」
  p.appendChild(el("p", "task-origin",
    task.origin === "dialogue"
      ? "来自对话：你说「就做这个」之后产生的任务。在这里做完，回对话继续。"
      : "来自方向路径：按知识树的节点排的练习。"));

  // 路径步骤说明（树上的任务才有）：由调用方给一个返回节点或 null 的函数，
  // 因为「这是主干第几步」这件事只有调用方知道（field / node 都在那边）。
  if (opts.note) {
    const note = opts.note();
    if (note) p.appendChild(note);
  }

  if (task.status === "done") {
    // taskPanelDone 会自己画一份「已完成」的表头，而且**不清空 p**。
    // 这里不先清就会得到两个表头：标题、简介各出现两遍，
    // 还同时挂着「约 20 分钟」和「已完成」两个互相矛盾的标签。
    // 提交那条路径（下面 p.innerHTML = ""）一直是清的，这里是漏了。
    p.innerHTML = "";
    taskPanelDone(p, task, opts);
    return p;
  }

  p.appendChild(el("h3", "section-label", "① 做什么"));
  const steps = el("div", "step-list");
  (task.steps || []).forEach((st) => {
    const row = el("label", "step");
    const cb = el("input"); cb.type = "checkbox";
    row.append(cb, el("span", "", esc(st)));
    steps.appendChild(row);
  });
  p.appendChild(steps);

  // ② 交什么——这一段以前完全缺失，是「不知道怎么完成」的直接原因
  p.appendChild(el("h3", "section-label", "② 交什么"));
  const dv = el("p", "deliverable");
  dv.textContent = task.deliverable || "一段文字：你做了什么、结果是什么、你的判断。";
  p.appendChild(dv);
  p.appendChild(el("p", "deliverable-note",
    "不用写得很正式，也不是给谁打分。它只用来看你实际做到了哪一步。"));

  p.appendChild(el("h3", "section-label", "③ 怎样算做到"));
  const crit = el("ul", "criteria");
  (task.rubric || []).forEach((r2) => crit.appendChild(el("li", "", esc(r2.criterion))));
  p.appendChild(crit);

  const box = el("div", "submit-box");
  const ta = el("textarea");
  ta.placeholder = "就写上面「交什么」要的那段。没做完也可以交，它只看你写了什么。";
  ta.setAttribute("aria-label", "提交内容");
  ta.value = readDraft(task.id);
  const count = el("span", "hint");
  const recount = () => {
    count.textContent = ta.value.trim()
      ? `已写 ${ta.value.trim().length} 字 · 草稿自动保存在本机`
      : "提交后按上面三条逐条反馈，并写回你的记录。";
  };
  ta.addEventListener("input", () => { writeDraft(task.id, ta.value); recount(); });
  recount();
  const submit = el("button", "btn", "提交");
  submit.type = "button";
  submit.onclick = async (ev) => {
    ev.preventDefault();
    if (ta.value.trim().length < 10) { toast("至少写一句话再提交"); ta.focus(); return; }
    submit.disabled = true; submit.textContent = "正在逐条看…";
    try {
      const fb = await api("POST", `/api/tasks/${task.id}/submit`, { uid: S.uid, payload: ta.value });
      S.lastFeedback = fb;
      S.lastFeedbackTaskId = task.id;
      sessionStorage.setItem("rg_fb_" + task.id, JSON.stringify(fb));
      writeDraft(task.id, "");
      S.newFactIds = (fb.learned_facts || []).map((f) => f.id);
      task.status = "done";
      p.innerHTML = "";
      taskPanelDone(p, task, opts);
      setTimeout(() => document.getElementById("fbPanel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    } catch (e) { toast(e.message); submit.disabled = false; submit.textContent = "提交"; }
  };
  const acts = el("div", "submit-actions");
  // 「填入演示示例」只给树上的任务（opts.demo）：它填的是一段通用样例，
  // 对话里出的任务有自己的上下文，塞一段演示文字反而误导。
  if (opts.demo) {
    const demo = el("button", "btn ghost small", "填入演示示例");
    demo.type = "button";
    demo.onclick = () => { ta.value = DEMO_ANSWER; writeDraft(task.id, ta.value); recount(); };
    acts.append(submit, demo, count);
  } else {
    acts.append(submit, count);
  }
  box.append(ta, acts);
  p.appendChild(box);
  return p;
}

function taskPanelDone(p, task, opts) {
  const head = el("div", "task-head");
  const hl = el("div");
  hl.appendChild(el("h2", "task-title", esc(opts.title || task.title)));
  hl.appendChild(el("p", "task-brief", esc(opts.intro || task.brief || "")));
  head.appendChild(hl);
  head.appendChild(el("span", "task-meta done", "已完成"));
  p.appendChild(head);
  if (task.deliverable) {
    p.appendChild(el("p", "deliverable", "你交的是：" + esc(task.deliverable)));
  }
  if (opts.note) {
    const note = opts.note();
    if (note) p.appendChild(note);
  }
  if (S.lastFeedback && S.lastFeedbackTaskId === task.id) renderFeedbackInto(p);
  else {
    // 这次会话里没有这条反馈（刷新过、或从别的任务切回来）：从服务器取最近一次提交的反馈。原来就看不到了（Codex 复现）
    const slot = el("div");
    p.appendChild(slot);
    api("GET", `/api/tasks/${encodeURIComponent(task.id)}`).then((t) => {
      if (!t || !t.feedback || !slot.isConnected) return;
      S.lastFeedback = t.feedback;
      S.lastFeedbackTaskId = task.id;
      renderFeedbackInto(slot);
    }).catch(() => { /* 取不到就不显示，不挡任务页 */ });
  }
  if (opts.onDone) p.appendChild(opts.onDone());
}

/* 对话给你的任务：**和知识树完全无关**，没有选方向也要显示。
   以前这里是整页 return，所以「对话出了任务但任务区是空的」。 */
function dialogueTaskSection(tasks) {
  const box = el("div", "panel dialogue-tasks");
  box.appendChild(el("h3", "section-label", "对话给你的任务"));
  if (!tasks.length) {
    box.appendChild(el("p", "panel-sub",
      "还没有。在对话里点「就做这个」，任务会出现在这里，做完回对话继续。"));
    return box;
  }
  const open = tasks.filter((tk) => tk.status !== "done");
  const done = tasks.filter((tk) => tk.status === "done");
  const pick = tasks.find((tk) => tk.id === S.openTaskId) || open[open.length - 1] || done[done.length - 1];
  if (pick) S.openTaskId = pick.id;

  if (tasks.length > 1) {
    const row = el("div", "task-chips");
    tasks.forEach((tk) => {
      const b = el("button", `chip${tk.id === S.openTaskId ? " chip-on" : ""}`,
        `${tk.status === "done" ? "✓ " : ""}${esc(tk.title)}`);
      b.type = "button";
      b.onclick = () => { S.openTaskId = tk.id; setView("workbench"); };
      row.appendChild(b);
    });
    box.appendChild(row);
  }
  if (pick) box.appendChild(taskPanel(pick, {}));
  return box;
}

async function renderWorkbench() {
  const seq = S.renderSeq;
  await ensurePortrait();
  if (stale(seq)) return;
  const [taskRes, onboard] = await Promise.all([
    api("GET", `/api/tasks?uid=${S.uid}`).catch(() => ({ tasks: [] })),
    api("GET", `/api/onboard/result?uid=${S.uid}`).catch(() => null),
  ]);
  if (stale(seq)) return;
  $app.innerHTML = "";
  const wrap = el("div", "stagger");
  wrap.appendChild(workspaceHead("任务", "对话里说「就做这个」产生的任务，和按方向路径排的练习，都在这里完成。"));
  $app.appendChild(wrap);

  const listed = taskRes.tasks || [];

  /* ① 对话给你的任务：先渲染，且不受「有没有选方向」影响 */
  const fromDialogue = listed.filter((tk) => tk.origin === "dialogue");
  wrap.appendChild(dialogueTaskSection(fromDialogue));

  /* ② 方向路径 */
  const facts = ((onboard && onboard.facts) || []).filter((f) => f.status !== "deleted" && f.status !== "dismissed");
  let t = adoptDirection(facts);
  if (t.code) {
    const merged = mergeTrail(t.code, listed);
    if (merged.done.join(",") !== t.done.join(",")) {
      t = merged;
      saveTrail(t);
    }
  }
  const code = t.code;
  const field = activeField(t);
  if (!code || !field) {
    // 注意：不再整页 return——上面已经画过对话任务了
    if (!fromDialogue.length) {
      wrap.appendChild(emptyPanel("还没有任务。去对话里说你手上的情况，它会给你一个下一步；或者去方向区选一棵树。", "去对话", "dialogue"));
    }
    return;
  }
  const node = currentOnPath(field, t.done);
  if (!node) {
    wrap.appendChild(emptyPanel(`「${dirTitle(t.dir, field)}」这条教程上的节点都走完了。`, "回方向区换一个方向", "cards"));
    return;
  }
  const expect = node.label.slice(0, 40);
  const boundId = (t.tasks || {})[node.id];
  let task = boundId ? listed.find((tk) => tk.id === boundId) : null;
  if (task && task.title !== expect) task = null;
  if (!task) task = [...listed].reverse().find((tk) => tk.title === expect && tk.direction === code) || null;
  if (!task) {
    task = await api("POST", "/api/tasks/generate", {
      uid: S.uid, direction: code, level: 1, title: node.label, brief: node.intro,
    });
    if (stale(seq)) return;
  }
  if (!task || task.title !== expect) {
    wrap.appendChild(emptyPanel(`当前节点是「${node.label}」，但任务服务还在用旧题目。请重新启动本地服务后再打开任务区。`));
    return;
  }
  t.tasks = Object.assign({}, t.tasks, { [node.id]: task.id });
  saveTrail(t);
  S.lastTask = task;
  if (task.status === "done" && S.lastFeedbackTaskId !== task.id) {
    try {
      const saved = JSON.parse(sessionStorage.getItem("rg_fb_" + task.id) || "null");
      if (saved) {
        S.lastFeedback = saved;
        S.lastFeedbackTaskId = task.id;
      }
    } catch (_) { /* 没有存过这次反馈 */ }
  }
  const path = pathNodes(field);
  const stepNo = path.findIndex((n) => n.id === node.id) + 1;
  wrap.appendChild(el("div", "ws-status",
    `<span>${esc(dirTitle(t.dir, field))}</span><span>第 ${stepNo} / ${path.length} 个节点</span>`));

  /* 路径步骤说明：主干步骤要交的是学期尺度的东西，二十分钟任务只是入门。
     返回节点而不是直接 append——面板是 taskPanel 画的，插在哪由它决定。 */
  const stepNote = () => {
    const step = stepOf(field, node.id);
    if (!step) return null;
    const note = el("div", "note-box step-note");
    note.innerHTML = `${node.main ? "这是" : "这一节点属于"}路径第 ${step.stage} 步「${esc(step.label)}」。这一步做完要交：${esc(step.done_when)}`;
    const find = el("button", "linkish", "找能交出它的项目");
    find.type = "button";
    find.onclick = () => findProjectsForStep(code, step.stage);
    note.appendChild(find);
    return note;
  };

  /* 树上的任务和对话给的任务共用 taskPanel（对话那条路在 chat.js 里也调它）。
     差别只在完成后的去处，所以用 onDone 注入：
     树上任务要「进入下一节点」+「找个项目练手」，对话任务回对话。 */
  wrap.appendChild(taskPanel(task, {
    title: node.label,
    intro: node.intro || task.brief,
    demo: true,
    note: stepNote,
    onDone: () => {
      const next = currentOnPath(field, t.done.concat(node.id));
      const acts = el("div", "submit-actions");
      if (next) {
        const go = el("button", "btn", `进入「${esc(next.label)}」`);
        go.type = "button";
        go.onclick = async () => {
          go.disabled = true;
          try {
            const created = await api("POST", "/api/tasks/generate", {
              uid: S.uid, direction: code, level: 1, title: next.label, brief: next.intro,
            });
            if (!created || created.title !== next.label.slice(0, 40)) {
              toast("下一节点的任务没有生成，请重启本地服务后再试");
              go.disabled = false;
              return;
            }
            const tasksMap = Object.assign({}, t.tasks, { [next.id]: created.id });
            saveTrail({ code, done: t.done.concat(node.id), tasks: tasksMap });
            S.lastTask = created;
            S.lastFeedback = null;
            S.lastFeedbackTaskId = "";
            setView("workbench");
          } catch (e) {
            toast(e.message);
            go.disabled = false;
          }
        };
        acts.appendChild(go);
      }
      const doneHere = listed.filter((tk) => tk.status === "done" && tk.direction === code && tk.id !== task.id).length + 1;
      if (doneHere >= PROJECT_AFTER_TASKS || !next) {
        const proj = el("button", next ? "btn secondary" : "btn", "学完一块了，找个项目练手");
        proj.type = "button";
        proj.title = `在「${field.name}」交过 ${doneHere} 次小任务`;
        proj.onclick = () => goFindProjects();
        acts.appendChild(proj);
      }
      const me = el("button", "btn ghost", "看它记下了什么");
      me.type = "button";
      me.onclick = () => setView("me");
      acts.appendChild(me);
      return acts;
    },
  }));
}

/* ---------- ⑦ 反馈 ---------- */

function renderFeedbackInto(p) {
  const fb = S.lastFeedback;
  if (!fb) return;
  const box = el("section", "feedback");
  box.id = "fbPanel";
  const head = el("div", "feedback-head");
  const hl = el("div");
  hl.appendChild(el("h3", "", "反馈"));
  if (fb.encouragement) hl.appendChild(el("p", "", esc(fb.encouragement)));
  head.appendChild(hl);
  const passed = (fb.rubric || []).filter((r) => r.pass).length;
  head.appendChild(el("div", "score-ring", `<span class="num">${passed}</span>/ ${(fb.rubric || []).length} 条做到`));
  box.appendChild(head);

  const rub = el("div", "rubric-list");
  (fb.rubric || []).forEach((r) => {
    rub.appendChild(el("div", `rubric-item ${r.pass ? "pass" : "fail"}`,
      `<span class="rubric-mark" aria-label="${r.pass ? "做到" : "还没做到"}">${r.pass ? "✓" : "!"}</span><div><p class="rubric-crit">${esc(r.criterion)}</p><p class="rubric-comment">${esc(r.comment)}</p></div>`));
  });
  box.appendChild(rub);
  if (fb.next_hint) box.appendChild(el("div", "why-box", `<b>下一步　</b>${esc(fb.next_hint)}`));

  if (fb.learned_facts && fb.learned_facts.length) {
    const fl = el("div", "fact-list");
    fb.learned_facts.forEach((f) => fl.appendChild(factCard(f, false, true)));
    box.appendChild(fl);
  }
  p.appendChild(box);
}

/* ---------- 今日 / ⑨ NBA ---------- */

function goFindProjects(keywords) {
  // 进「项目 · 找项目」，方向和阶段交给服务端按记录预选（/api/projects/context）
  S.projectForm = null;
  S.projectResult = null;
  S.projectTab = "find";
  if (keywords) S.projectKeywords = keywords;
  setView("projects");
}

function openProject(pid) {
  S.projectId = pid;
  setView("project");
}

const PROJECT_AFTER_TASKS = 3; // 在一个方向交过几次小任务之后，开始建议找项目练手

async function renderToday() {
  const seq = S.renderSeq;
  await ensurePortrait();
  if (stale(seq)) return;
  const [taskRes, onboard, mine] = await Promise.all([
    api("GET", `/api/tasks?uid=${S.uid}`).catch(() => null),
    api("GET", `/api/onboard/result?uid=${S.uid}`).catch(() => null),
    api("GET", `/api/projects/mine?uid=${S.uid}`).catch(() => ({ projects: [] })),
  ]);
  if (stale(seq)) return;
  adoptDirection((onboard && onboard.facts) || []);
  let saved = trail();
  if (taskRes && saved.code) {
    const merged = mergeTrail(saved.code, taskRes.tasks || []);
    if (merged.done.join(",") !== saved.done.join(",")) {
      saveTrail(merged);
      saved = trail();
    }
  }
  const field = activeField(saved);
  const node = field ? currentOnPath(field, saved.done) : null;
  const facts = (onboard && onboard.facts) || [];
  const talked = onboard && onboard.state && onboard.state.phase === "done";
  const drafts = facts.filter((f) => f.status === "draft").length;
  const doneTasks = ((taskRes && taskRes.tasks) || []).filter((t) => t.status === "done" && t.direction === saved.code).length;
  const projects = (mine && mine.projects) || [];
  const toFix = projects.find((p) => p.status === "reviewed" && p.reviews[0] && p.reviews[0].passed < p.reviews[0].total);
  const toSubmit = projects.find((p) => p.status === "picked");

  // 每条建议：一个主动作 + 至多一个备选，落到一件具体的事
  let title; let why; let primary; let alt = null;
  const goView = (label, view) => ({ label, run: () => setView(view) });
  if (!field && !talked) {
    title = "先聊五个问题";
    why = "它还不认识你。五个问题，大约五分钟：年级、基础、好奇什么、习惯怎么学。每一问都可以选「不知道」。";
    primary = goView("去对话", "dialogue");
  } else if (!field && drafts) {
    title = `核对它记下的 ${drafts} 条`;
    why = "对话里记下的内容还是草稿。改掉不对的、划掉不属实的，方向建议才会按你来。";
    primary = goView("去核对", "confirm");
  } else if (!field) {
    title = "选定一个方向";
    why = "方向区是一棵学科树。按你的画像会标出建议。确认一个方向，任务从它的教程起点开始。";
    primary = goView("去方向区", "cards");
  } else if (toFix) {
    let detail = null;
    try { detail = await api("GET", `/api/projects/${toFix.id}?uid=${S.uid}`); } catch (_) { /* 拿不到详情就用概要 */ }
    if (stale(seq)) return;
    const last = (detail && detail.reviews && detail.reviews[0]) || toFix.reviews[0];
    title = `把《${toFix.name}》再改一处`;
    why = `上次评阅 ${last.passed} / ${last.total} 条做到。${last.next_step || "按评阅里第一条没做到的标准补一处，再交一版。"}`;
    primary = { label: "去改这一处", run: () => openProject(toFix.id) };
    if (node) alt = { label: `先继续「${node.label}」`, run: () => setView("workbench") };
  } else if (toSubmit) {
    title = `交《${toSubmit.name}》的成果`;
    why = "这个项目已经选定，还没交。按项目页的要求打成一个 .zip：README、results/、代码或方法。没做完也可以先交一版，评阅会指出先补哪里。";
    primary = { label: "去交成果", run: () => openProject(toSubmit.id) };
    if (node) alt = { label: `先继续「${node.label}」`, run: () => setView("workbench") };
  } else if (doneTasks >= PROJECT_AFTER_TASKS) {
    title = "找一个项目练手";
    why = `你在「${field.name}」已经交过 ${doneTasks} 次小任务。二十分钟的任务练的是一个点，项目练的是把点连起来：从公开来源找一个真题，做完交一个压缩包。`;
    primary = { label: "去找项目", run: () => goFindProjects() };
    if (node) alt = { label: `先继续「${node.label}」`, run: () => setView("workbench") };
  } else if (node) {
    title = `继续「${node.label}」`;
    why = node.intro;
    primary = goView("去做这一步", "workbench");
  } else {
    title = `「${field.name}」这条路已经走到头`;
    why = "可以找一个项目把这一路学的用起来，或者回方向区换一棵树。";
    primary = { label: "去找项目", run: () => goFindProjects() };
    alt = { label: "回方向区", run: () => setView("cards") };
  }

  $app.innerHTML = "";
  const wrap = el("div", "stagger");
  wrap.appendChild(workspaceHead("今日"));
  const status = el("div", "ws-status");
  status.appendChild(el("span", "", field ? esc(dirTitle(saved.dir, field)) : "还没有方向"));
  if (node) status.appendChild(el("span", "", `正在「${esc(node.label)}」`));
  if (doneTasks) status.appendChild(el("span", "", `交过 ${doneTasks} 次小任务`));
  if (projects.length) status.appendChild(el("span", "", `${projects.length} 个项目`));
  wrap.appendChild(status);
  const card = el("div", "nba-card");
  card.appendChild(el("h3", "nba-title", esc(title)));
  card.appendChild(el("p", "nba-why", esc(why)));
  const act = el("div", "submit-actions");
  const go = el("button", "btn", esc(primary.label));
  go.type = "button";
  go.onclick = primary.run;
  act.appendChild(go);
  if (alt) {
    const other = el("button", "btn ghost", esc(alt.label));
    other.type = "button";
    other.onclick = alt.run;
    act.appendChild(other);
  }
  card.appendChild(act);
  wrap.appendChild(card);
  $app.appendChild(wrap);
  // 每日情报：开过研读、或方向正好有工具包时出现；单独加载，arXiv 慢也不挡上面的主建议
  if (S.kitId || saved.code === "ai") {
    if (!S.kitId) useKit(DEFAULT_KIT);
    const slot = el("div", "panel daily", '<p class="panel-sub">正在取今天的 arXiv 新论文…</p>');
    $app.appendChild(slot);
    dailyBlock(seq).then((box) => { if (!stale(seq)) slot.replaceWith(box); });
  }
}

/* ---------- 研读：工具包 / 阅读卡 / 矩阵（docs/DESIGN_PROPOSAL.md §1C） ---------- */

const DEFAULT_KIT = "llm-eval";
const DIR_LABEL = { up: "↑ 提升", down: "↓ 下降 / 失效", mixed: "~ 有好有坏", none: "? 没报告" };

function readTabs(active) {
  const nav = el("nav", "ws-tabs");
  [["kit", "工具包"], ["cards", "阅读卡"], ["matrix", "矩阵"]].forEach(([key, label]) => {
    const b = el("button", `ws-tab${key === active ? " on" : ""}`, label);
    b.type = "button";
    b.onclick = () => { S.readTab = key; setView("read"); };
    nav.appendChild(b);
  });
  return nav;
}

function openCard(arxivId) {
  S.cardId = arxivId;
  setView("card");
}

function useKit(kitId) {
  S.kitId = kitId;
  try { localStorage.setItem("rg_kit", kitId); } catch (_) { /* 存不了就每次用默认 */ }
}

async function renderRead() {
  const seq = S.renderSeq;
  if (!S.kitId) useKit(DEFAULT_KIT);
  const kitId = S.kitId;
  const tab = S.readTab || "kit";
  let kit; let cards;
  try {
    [kit, cards] = await Promise.all([
      api("GET", `/api/kits/${kitId}`),
      api("GET", `/api/cards?uid=${S.uid}&kit=${kitId}`),
    ]);
  } catch (e) {
    if (stale(seq)) return;
    $app.innerHTML = "";
    $app.appendChild(workspaceHead("研读"));
    $app.appendChild(el("div", "note-box", `工具包加载失败：${esc(e.message)}`));
    return;
  }
  if (stale(seq)) return;
  const byPaper = Object.fromEntries((cards.cards || []).map((c) => [c.arxiv_id, c]));
  $app.innerHTML = "";
  $app.appendChild(workspaceHead("研读", "读懂一个小领域：每篇论文一张阅读卡，引文必须能在原文里逐字找到；三张卡过线后，矩阵会把缺口摆出来。"));
  const passed = Object.values(byPaper).filter((c) => c.status === "pass").length;
  $app.appendChild(el("div", "ws-status", `<span>工具包「${esc(kit.name)}」v${esc(kit.version)}</span><span>过线阅读卡 ${passed} 张</span><span>${esc(kit.status)}</span>`));
  $app.appendChild(readTabs(tab));
  const mismatch = kitMismatch(kit.direction, await myDirection());
  if (stale(seq)) return;
  if (mismatch) $app.appendChild(mismatch);

  if (tab === "cards") { renderCardList(kit, byPaper); return; }
  if (tab === "matrix") { await renderMatrix(seq, kit); return; }

  const goal = el("div", "panel");
  goal.appendChild(el("p", "section-label", "这个工具包要你弄懂"));
  goal.appendChild(el("p", "", esc(kit.goal)));
  $app.appendChild(goal);

  const papers = el("div", "panel");
  papers.appendChild(el("h3", "panel-title", "阅读顺序"));
  papers.appendChild(el("p", "panel-sub", "按顺序读；每篇一张卡。已经会的可以跳着读。"));
  const list = el("ol", "kit-papers");
  kit.papers.forEach((p) => {
    const c = byPaper[p.arxiv_id];
    const state = c ? (c.status === "pass" ? `<span class="kp-state pass">✓ 过线 v${c.version}</span>` : `<span class="kp-state revise">待改 v${c.version}</span>`) : "";
    const li = el("li", "kit-paper");
    li.innerHTML = `<div class="kp-main"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a> ${state}<p>${esc(p.why)}</p><small>arXiv:${esc(p.arxiv_id)} · ${esc(p.published)}</small></div>`;
    const go = el("button", c ? "btn small secondary" : "btn small", c ? (c.status === "pass" ? "看卡" : "改这张卡") : "写阅读卡");
    go.type = "button";
    go.onclick = () => openCard(p.arxiv_id);
    li.appendChild(go);
    list.appendChild(li);
  });
  papers.appendChild(list);
  $app.appendChild(papers);

  const open = el("div", "panel");
  open.appendChild(el("h3", "panel-title", "作者自己写下的开放问题"));
  open.appendChild(el("p", "panel-sub", "每一条都是论文局限 / 讨论 / 结论段的原句，已逐字核对。它们是找问题的起点，不是现成的题目。"));
  const ul = el("ul", "open-problems");
  kit.open_problems.forEach((o) => {
    ul.appendChild(el("li", "", `<blockquote>「${esc(o.quote)}」</blockquote><p>${esc(o.note)}</p><small>${esc(o.paper)} · ${esc(o.section)} · <a href="https://arxiv.org/abs/${esc(o.arxiv_id)}" target="_blank" rel="noopener">arXiv ↗</a></small>`));
  });
  open.appendChild(ul);
  $app.appendChild(open);

  const data = el("div", "panel");
  data.appendChild(el("h3", "panel-title", "数据集与代码"));
  const dl = el("ul", "criteria");
  kit.datasets.forEach((d) => dl.appendChild(el("li", "", `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.name)} ↗</a>　${esc(d.note)}`)));
  data.appendChild(dl);
  $app.appendChild(data);
}

function renderCardList(kit, byPaper) {
  const panel = el("div", "panel");
  const cards = Object.values(byPaper);
  if (!cards.length) {
    panel.appendChild(el("p", "panel-sub", "还没有阅读卡。从「工具包」里按顺序挑第一篇开始。"));
    const go = el("button", "btn", `写第一张：${esc(kit.papers[0].title)}`);
    go.type = "button";
    go.style.marginTop = "16px";
    go.onclick = () => openCard(kit.papers[0].arxiv_id);
    panel.appendChild(go);
    $app.appendChild(panel);
    return;
  }
  const rows = el("div", "fact-list");
  cards.sort((a, b) => (a.status === b.status ? 0 : a.status === "pass" ? 1 : -1)).forEach((c) => {
    const row = el("button", "mine-row");
    row.type = "button";
    row.innerHTML = `<span class="mine-name">${esc(c.title)}</span><span class="mine-meta">v${c.version} · ${c.status === "pass" ? "过线" : `待改：${esc(c.review.next_step || "")}`}</span>`;
    row.onclick = () => openCard(c.arxiv_id);
    rows.appendChild(row);
  });
  panel.appendChild(rows);
  $app.appendChild(panel);
}

async function renderMatrix(seq, kit) {
  const m = await api("GET", `/api/matrix?uid=${S.uid}&kit=${kit.id}`).catch((e) => ({ error: e.message }));
  if (stale(seq)) return;
  const panel = el("div", "panel");
  if (m.error) { panel.appendChild(el("div", "note-box", esc(m.error))); $app.appendChild(panel); return; }
  if (!m.ready) {
    panel.appendChild(el("p", "panel-sub", `再交 ${m.need_more} 张过线的阅读卡，矩阵才会生成——格子只来自你自己的卡。`));
    $app.appendChild(panel);
    return;
  }
  const f = m.flags;
  const emptyCols = new Set(f.empty_columns);
  const emptyCells = new Set(f.empty_cells.map(([a, k]) => `${a}|${k}`));
  const conflict = new Set(m.rows.filter((r) => r.conflict).map((r) => r.arxiv_id));  // 完整成员；c.up / c.down 只是预览
  const titleOf = Object.fromEntries(m.rows.map((r) => [r.arxiv_id, clip(r.title, 28)]));
  const names = (ids, total) => ids.map((id) => `《${esc(titleOf[id] || id)}》`).join("") + (total > ids.length ? ` 等 ${total} 篇` : "");
  panel.appendChild(el("p", "panel-sub", "缺口不会被告诉你，它们在表里：空格、整列空着的维度、同一指标方向相反的两篇。挑一处，问自己它被默认了什么。"));
  const wrap = el("div", "matrix-wrap");
  const table = el("table", "matrix");
  table.innerHTML = `<thead><tr><th>论文</th>${m.dimensions.map((d) => `<th class="${emptyCols.has(d.key) ? "col-empty" : ""}" title="${esc(d.hint || "")}">${esc(d.label)}${emptyCols.has(d.key) ? " ·空列" : ""}</th>`).join("")}</tr></thead>`;
  const tb = el("tbody");
  m.rows.forEach((r) => {
    const tr = el("tr", conflict.has(r.arxiv_id) ? "row-conflict" : "");
    tr.innerHTML = `<th><button class="linkish" type="button" title="${esc(r.title)}">${esc(clip(r.title, 40))}</button>${conflict.has(r.arxiv_id) ? " ⚡" : ""}</th>`
      + m.dimensions.map((d) => {
        const v = r.cells[d.key];
        const shown = d.key === "direction" ? (DIR_LABEL[v] || v) : v;
        return `<td class="${emptyCells.has(`${r.arxiv_id}|${d.key}`) ? "cell-empty" : ""}">${shown ? esc(shown) : "·"}</td>`;
      }).join("");
    tr.querySelector("button").onclick = () => openCard(r.arxiv_id);
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  wrap.appendChild(table);
  panel.appendChild(wrap);
  const notes = el("ul", "matrix-flags");
  // 每个指标一条：哪些说提升、哪些说下降（各列前几篇），不逐对展开
  f.conflicts.forEach((c) => notes.appendChild(el("li", "", `⚡ 同一指标「${esc(c.metric)}」上方向相反：提升 ${c.up_total} 篇 ${names(c.up, c.up_total)}；下降 ${c.down_total} 篇 ${names(c.down, c.down_total)}——真的冲突，还是数据或设置不同？`)));
  if (f.empty_columns.length) notes.appendChild(el("li", "", `整列多半空着：${f.empty_columns.map((k) => esc((m.dimensions.find((d) => d.key === k) || {}).label || k)).join("、")}——大家都没检验，常常就是隐藏的假设。`));
  notes.appendChild(el("li", "", `空格 ${f.empty_cells.length} 个：是没人做过，还是你没读到？`));
  panel.appendChild(notes);
  $app.appendChild(panel);
}

/* ---------- 阅读卡工作台 ---------- */

async function renderCard() {
  const seq = S.renderSeq;
  const kitId = S.kitId || DEFAULT_KIT;
  const aid = S.cardId;
  if (!aid) { setView("read"); return; }
  $app.innerHTML = "";
  const back = el("button", "linkish back-link", "← 研读");
  back.type = "button";
  back.onclick = () => setView("read");
  $app.appendChild(back);
  const loading = el("div", "note-box", "正在取原文（arXiv HTML 版，第一次稍慢）…");
  $app.appendChild(loading);
  let kit; let paper; let cards;
  try {
    [kit, paper, cards] = await Promise.all([
      api("GET", `/api/kits/${kitId}`),
      api("GET", `/api/papers/${aid}`),
      api("GET", `/api/cards?uid=${S.uid}&kit=${kitId}`),
    ]);
  } catch (e) {
    if (stale(seq)) return;
    loading.textContent = `原文取不到（如实说明）：${e.message}。可以先在 arXiv 上读：https://arxiv.org/abs/${aid}`;
    return;
  }
  if (stale(seq)) return;
  loading.remove();
  const prev = (cards.cards || []).find((c) => c.arxiv_id === aid);
  const draftKey = `rg_card_${S.uid}_${kitId}_${aid}`;  // 带上是谁的：同一台电脑换人不串
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(draftKey) || "null"); } catch (_) { /* 坏草稿就丢掉 */ }
  const state = draft || { fields: { ...((prev && prev.fields) || {}) }, dims: { ...((prev && prev.dims) || {}) }, log: (prev && prev.decision_log) || [] };
  const save = () => { try { localStorage.setItem(draftKey, JSON.stringify(state)); } catch (_) { /* 存不了不影响提交 */ } };

  $app.appendChild(workspaceHead(esc(paper.title)));
  $app.appendChild(el("div", "ws-status", `<span><a href="${esc(paper.url)}" target="_blank" rel="noopener">arXiv:${esc(aid)} ↗</a></span><span>${paper.source === "html" ? "正文已取到，引文可逐字核对" : "只取到摘要：正文引文核对不了，请先读 arXiv 原文"}</span>${prev ? `<span>上一版 v${prev.version} · ${prev.status === "pass" ? "过线" : "待改"}</span>` : ""}`));

  const bench = el("div", "bench");
  // 左：原文
  const left = el("section", "bench-paper");
  const tools = el("div", "quote-tools");
  tools.innerHTML = '<span>选中原文里的一句，再点：</span>';
  const quoteFields = cards.fields.filter((f) => f.quote);
  const pane = el("div", "paper-text");
  const jump = el("div", "sec-jump", "<span>跳到</span>");
  const starts = new Map((paper.sections || []).map((sec) => [sec.at, sec]));
  const jumped = new Set(["参考文献", "附录", "致谢"]);
  let off = 0;
  paper.text.split("\n").forEach((line) => {
    const sec = starts.get(off);
    const node = el(sec ? "h4" : "p");
    node.textContent = line;
    pane.appendChild(node);
    off += line.length + 1;
    if (!sec || jumped.has(sec.label)) return;
    jumped.add(sec.label);
    const b = el("button", "linkish", esc(sec.label));
    b.type = "button";
    b.onclick = () => pane.scrollTo({ top: node.offsetTop - 8, behavior: "smooth" });
    jump.appendChild(b);
  });
  quoteFields.forEach((f) => {
    const b = el("button", "chip", `引为「${esc(f.label.replace(" · 原句", ""))}」`);
    b.type = "button";
    b.onclick = () => {
      const sel = (window.getSelection() || "").toString().replace(/\s+/g, " ").trim();
      if (!sel || !pane.contains(window.getSelection().anchorNode)) { toast("先在左边原文里选中一句"); return; }
      state.fields[f.key] = sel;
      save();
      paintForm();
    };
    tools.appendChild(b);
  });
  left.append(tools, jump, pane);

  // 右：卡
  const right = el("section", "bench-card");
  const form = el("div", "card-form");
  const result = el("div", "card-result");
  right.append(form, result);
  bench.append(left, right);
  $app.appendChild(bench);

  function paintForm() {
    form.innerHTML = "";
    cards.fields.forEach((f) => {
      const box = el("label", `cf${f.quote ? " cf-quote" : ""}${f.own ? " cf-own" : ""}`);
      box.appendChild(el("span", "cf-label", `${esc(f.label)}${f.own ? '<i>只能你自己写</i>' : ""}`));
      const ta = el("textarea");
      ta.rows = f.quote ? 3 : 2;
      ta.placeholder = f.hint;
      ta.value = state.fields[f.key] || "";
      ta.addEventListener("input", () => { state.fields[f.key] = ta.value; save(); });
      box.appendChild(ta);
      form.appendChild(box);
    });
    form.appendChild(el("p", "section-label", "矩阵维度（和别的论文对比用）"));
    const grid = el("div", "dims-grid");
    kit.dimensions.forEach((d) => {
      const box = el("label", "cf");
      box.appendChild(el("span", "cf-label", esc(d.label)));
      let input;
      if (d.options) {
        input = el("select");
        input.innerHTML = `<option value="">—</option>${d.options.map((o) => `<option value="${o}">${esc(DIR_LABEL[o] || o)}</option>`).join("")}`;
      } else {
        input = el("input");
        input.placeholder = d.hint;
      }
      input.value = state.dims[d.key] || "";
      input.addEventListener("input", () => { state.dims[d.key] = input.value; save(); });
      input.addEventListener("change", () => { state.dims[d.key] = input.value; save(); });
      box.appendChild(input);
      grid.appendChild(box);
    });
    form.appendChild(grid);

    // 双窗口：交给你的 Agent + 决策日志
    const agent = el("details", "agent-box");
    agent.open = state.log.length > 0;
    agent.appendChild(el("summary", "", `你的 Agent（可选）· 决策日志 ${state.log.length} 条`));
    agent.appendChild(el("p", "form-note", "下载简报放进你的 Agent（Claude Code / Codex 放项目目录；DeepSeek 等网页版就复制内容）。它只能挑错和提问，不能替你写「主张」「假设」「我会改什么」。它的每条建议在这里登记，并逐条决定采纳、修改还是拒绝——拒绝要写理由。"));
    const dl = el("a", "btn small secondary", "交给你的 Agent ↓ AGENTS.md");
    // 走接口地址：页面在 GitHub Pages 时，相对路径会去 Pages 上找，下载不到（Codex 复现）
    dl.href = apiUrl(`/api/brief?kit=${encodeURIComponent(kitId)}&arxiv_id=${encodeURIComponent(aid)}`);
    agent.appendChild(dl);
    const table = el("div", "log-rows");
    const paintLog = () => {
      table.innerHTML = "";
      state.log.forEach((row, i) => {
        const r = el("div", "log-row");
        r.innerHTML = `<b>A${i + 1}</b>`;
        const s = el("input"); s.placeholder = "Agent 建议了什么"; s.value = row.suggestion || "";
        s.addEventListener("input", () => { row.suggestion = s.value; save(); });
        const a = el("select");
        a.innerHTML = '<option value="">处理…</option><option value="adopt">采纳</option><option value="modify">修改后采纳</option><option value="reject">拒绝</option>';
        a.value = row.action || "";
        a.addEventListener("change", () => { row.action = a.value; save(); });
        const why = el("input"); why.placeholder = "为什么（拒绝必填）"; why.value = row.reason || "";
        why.addEventListener("input", () => { row.reason = why.value; save(); });
        const x = el("button", "linkish danger", "删");
        x.type = "button";
        x.onclick = () => { state.log.splice(i, 1); save(); paintLog(); };
        r.append(s, a, why, x);
        table.appendChild(r);
      });
    };
    paintLog();
    const add = el("button", "linkish", "+ 登记一条 Agent 建议");
    add.type = "button";
    add.onclick = () => { state.log.push({ suggestion: "", action: "", reason: "" }); save(); paintLog(); agent.open = true; };
    agent.append(table, add);
    form.appendChild(agent);

    const acts = el("div", "submit-actions");
    const submit = el("button", "btn", prev ? "交新一版" : "交这张卡");
    submit.type = "button";
    submit.onclick = async () => {
      submit.disabled = true; submit.textContent = "正在逐字核对引文…";
      try {
        const card = await api("POST", "/api/cards", {
          uid: S.uid, kit: kitId, arxiv_id: aid, fields: state.fields, dims: state.dims,
          decision_log: state.log.filter((r) => (r.suggestion || "").trim()),
        });
        paintReview(card);
        if (card.status === "pass") { try { localStorage.removeItem(draftKey); } catch (_) { /* ignore */ } }
        result.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) { toast(e.message); }
      submit.disabled = false; submit.textContent = "交新一版";
    };
    acts.appendChild(submit);
    acts.appendChild(el("span", "hint", "草稿自动存在本机。没过线也会记一版，改了再交。"));
    form.appendChild(acts);
  }

  function paintReview(card) {
    result.innerHTML = "";
    const r = card.review;
    const sec = el("section", "feedback");
    if (card.prev_passed !== null && card.prev_passed !== undefined) {
      const d = r.passed - card.prev_passed;
      sec.appendChild(el("p", `review-delta ${d > 0 ? "up" : d < 0 ? "down" : ""}`, d > 0 ? `比上一版多过 ${d} 条（${card.prev_passed} → ${r.passed}）` : d < 0 ? `比上一版少了 ${-d} 条` : `和上一版一样是 ${r.passed} 条`));
    }
    const head = el("div", "feedback-head");
    head.appendChild(el("div", "", `<h3>${card.status === "pass" ? "过线" : "还差一点"} · v${card.version}</h3><p>${card.status === "pass" ? "这张卡记进了你的账本，会出现在矩阵里。" : esc(r.next_step)}</p>`));
    head.appendChild(el("div", "score-ring", `<span class="num">${r.passed}</span>/ ${r.total} 条`));
    sec.appendChild(head);
    const list = el("div", "rubric-list");
    r.checks.forEach((c) => list.appendChild(el("div", `rubric-item ${c.pass ? "pass" : "fail"}`,
      `<span class="rubric-mark">${c.pass ? "✓" : "!"}</span><div><p class="rubric-crit">${esc(c.label)}${c.where ? `<em>${esc(c.where)}</em>` : ""}</p><p class="rubric-comment">${esc(c.note)}</p></div>`)));
    sec.appendChild(list);
    if (card.fact) sec.appendChild(el("div", "why-box", `<b>写进账本　</b>${esc(card.fact.value)}`));
    result.appendChild(sec);
  }

  paintForm();
  if (prev) paintReview(prev);
}

/* ---------- 今日 · 每日情报（≤10 分钟） ---------- */

async function dailyBlock(seq) {
  const box = el("section", "panel daily");
  let d;
  try {
    d = await api("GET", `/api/daily?uid=${S.uid}&kit=${S.kitId || DEFAULT_KIT}`);
  } catch (e) {
    box.appendChild(el("p", "panel-sub", `今日情报暂时取不到（如实说明）：${esc(e.message)}`));
    return box;
  }
  if (stale(seq)) return box;
  const head = el("div", "daily-head");
  head.innerHTML = `<div><p class="section-label">每日情报 · 约 5 分钟 · 可跳过</p><h3 class="panel-title">分拣今天的新论文</h3><p class="panel-sub">「${esc(d.kit.name)}」相关的 arXiv 新论文。只看标题和摘要原文，决定留还是过，写一句为什么——这是在练判断，不是在读论文。</p></div><div class="score-ring"><span class="num">${d.done_today}</span>/ ${d.goal} 今天</div>`;
  box.appendChild(head);
  if (d.error) box.appendChild(el("div", "note-box", `arXiv 暂时连不上（如实说明）：${esc(d.error)}`));
  if (!d.items.length && !d.error) box.appendChild(el("p", "panel-sub", "今天没有新的待分拣论文（周末 arXiv 不更新）。"));
  d.items.forEach((it) => {
    const row = el("article", "triage");
    const first = it.abstract.split(/(?<=\.)\s/).slice(0, 2).join(" ");
    row.innerHTML = `<a class="triage-title" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a><p class="triage-abs">${esc(first)}</p><small>${esc(it.authors.join(", "))} · ${esc(it.published)}</small>`;
    const ctl = el("div", "triage-ctl");
    const why = el("input");
    why.placeholder = "为什么（一句，≤30 字）：碰到了什么 / 离你的问题多远";
    why.maxLength = 80;
    const send = async (verdict) => {
      try {
        await api("POST", "/api/daily/triage", { uid: S.uid, kit: d.kit.id, arxiv_id: it.arxiv_id, verdict, why: why.value, title: it.title });
        row.classList.add("done", verdict);
        ctl.innerHTML = `<span class="triage-done">${verdict === "keep" ? "已留下" : "已跳过"}：${esc(why.value)}</span>`;
        const n = box.querySelector(".daily-head .num");
        if (n) n.textContent = String(Number(n.textContent) + 1);
      } catch (e) { toast(e.message); why.focus(); }
    };
    const keep = el("button", "btn small", "留");
    keep.type = "button";
    keep.onclick = () => send("keep");
    const skip = el("button", "btn small secondary", "过");
    skip.type = "button";
    skip.onclick = () => send("skip");
    ctl.append(why, keep, skip);
    row.appendChild(ctl);
    box.appendChild(row);
  });
  if (d.tweak) {
    const t = el("div", "daily-tweak");
    t.appendChild(el("p", "", `<b>定位微调　</b>${esc(d.tweak.text)}`));
    const go = el("button", "btn small secondary", esc(d.tweak.action));
    go.type = "button";
    go.onclick = () => { if (d.tweak.view === "position") S.posTab = "statement"; setView(d.tweak.view); };
    t.appendChild(go);
    box.appendChild(t);
  }
  if (d.recent_keeps.length) {
    const kept = el("details", "inventory");
    kept.appendChild(el("summary", "", `你最近留下的 ${d.recent_keeps.length} 篇（共分拣 ${d.triaged_total} 篇）`));
    const ul = el("ul");
    d.recent_keeps.forEach((k) => ul.appendChild(el("li", "", `<a href="https://arxiv.org/abs/${esc(k.arxiv_id)}" target="_blank" rel="noopener">${esc(k.title || k.arxiv_id)}</a><span>${esc(k.why)}</span>`)));
    kept.appendChild(ul);
    box.appendChild(kept);
  }
  return box;
}

/* ---------- 定位：边清单 / 竞争地图 / 定位陈述 / 下注组合（docs/DESIGN_PROPOSAL.md §1D） ---------- */

const TREND = { up: "↑ 涨得比分类快", down: "↓ 涨得比分类慢", flat: "→ 和分类差不多" };
const TIER_HINT = {
  reach: "拥挤或门槛高，你的边只部分匹配",
  match: "你的边匹配，拥挤中等",
  safety: "不拥挤或有制度化通道（本研公开题目、助教项目）",
};

function positionTabs(active) {
  const nav = el("nav", "ws-tabs");
  [["edges", "边清单"], ["sources", "信息源"], ["map", "竞争地图"], ["statement", "定位陈述"], ["bets", "下注组合"]].forEach(([key, label]) => {
    const b = el("button", `ws-tab${key === active ? " on" : ""}`, label);
    b.type = "button";
    b.onclick = () => { S.posTab = key; setView("position"); };
    nav.appendChild(b);
  });
  return nav;
}

async function renderPosition() {
  const seq = S.renderSeq;
  if (!S.kitId) useKit(DEFAULT_KIT);
  const tab = S.posTab || "edges";
  $app.innerHTML = "";
  $app.appendChild(workspaceHead("定位", "会的人越来越多，学得越来越快。这里帮你看清三件事：你有什么别人不容易有的、哪里还没挤满、怎么用一句有证据的话说出「为什么是我」。"));
  $app.appendChild(positionTabs(tab));
  const body = el("div");
  $app.appendChild(body);
  try {
    if (tab === "sources") await paintSources(seq, body);
    else if (tab === "map") await paintMap(seq, body);
    else if (tab === "statement") await paintStatement(seq, body);
    else if (tab === "bets") await paintBets(seq, body);
    else await paintEdges(seq, body);
  } catch (e) {
    if (!stale(seq)) body.appendChild(el("div", "note-box", `加载失败：${esc(e.message)}`));
  }
}

/* 学生的方向：本机轨迹优先，没有就问服务端（直接打开定位 / 研读时本机可能还没记）。
   问到的按画像记：问的时候切了画像，这个结果不记；没问到也不记，下次再问。 */
async function myDirection() {
  if (trail().code) return trail().code;
  if (S.myDir !== undefined) return S.myDir;
  const portrait = S.portraitId;
  let dir;
  try { dir = (await api("GET", `/api/projects/context?uid=${S.uid}`)).direction || ""; } catch (_) { return ""; }
  if (S.portraitId === portrait) S.myDir = dir;
  return dir;
}

/* 学生的方向还没有工具包时如实说，并指向不依赖工具包的「信息源」 */
function kitMismatch(kitDirection, code) {
  if (!code || !kitDirection || code === kitDirection || !FIELD_TREES[code]) return null;
  const box = el("div", "note-box", `这个工具包属于「${esc((FIELD_TREES[kitDirection] || {}).name || kitDirection)}」。你的方向「${esc(FIELD_TREES[code].name)}」还没有工具包——可以先看这个方向的人在哪说话。`);
  const go = el("button", "linkish", "去看信息源 →");
  go.type = "button";
  go.onclick = () => { S.posTab = "sources"; S.srcDir = code; setView("position"); };
  box.appendChild(go);
  return box;
}

function edgeChip(e) {
  const tag = e.status === "proven" ? '<b class="edge-st proven">已证明</b>' : '<b class="edge-st">自述</b>';
  return `${tag}${esc(e.text)}${e.generic ? '<em class="edge-common">谁都会写</em>' : ""}`;
}

async function paintEdges(seq, body) {
  const d = await api("GET", `/api/edges?uid=${S.uid}`);
  if (stale(seq)) return;
  const intro = el("div", "panel");
  intro.appendChild(el("p", "panel-sub", "边是别人不容易有、又能核对的东西：会的语言或方言、跨院系的课程组合、能接触到的人群 / 数据 / 设备、你常去而同学不去的信息源、整块的时间。「热爱科研」「学习能力强」谁都会写，不算边。"));
  const proven = d.edges.filter((e) => e.status === "proven");
  const mine = d.edges.filter((e) => e.status !== "proven");
  intro.appendChild(el("p", "section-label", `已证明 · ${proven.length}（来自账本，过线的作品自动进来，不能手改）`));
  if (!proven.length) intro.appendChild(el("p", "form-note", "还没有。在「研读」交一张过线的阅读卡，这里就有第一条。"));
  const pl = el("ul", "edge-list");
  proven.forEach((e) => pl.appendChild(el("li", "", `<span>${edgeChip(e)}</span>`)));
  intro.appendChild(pl);
  intro.appendChild(el("p", "section-label", `自述 · ${mine.length}`));
  const ml = el("ul", "edge-list");
  mine.forEach((e) => {
    const li = el("li", "", `<span>${edgeChip(e)}<small>${esc(d.kinds[e.kind] || e.kind)}${e.evidence_url ? ` · <a href="${esc(e.evidence_url)}" target="_blank" rel="noopener">凭据 ↗</a>` : ""}</small></span>`);
    const x = el("button", "linkish danger", "删");
    x.type = "button";
    x.onclick = async () => { try { await api("DELETE", `/api/edges/${e.id}?uid=${S.uid}`); setView("position"); } catch (err) { toast(err.message); } };
    li.appendChild(x);
    ml.appendChild(li);
  });
  intro.appendChild(ml);

  const form = el("div", "edge-form");
  const kind = el("select");
  kind.innerHTML = Object.entries(d.kinds).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  kind.value = "language";
  const text = el("input");
  text.placeholder = "具体到别人能核对：粤语母语 / 修过《数理统计》和《认知心理学》/ 常逛 r/MachineLearning";
  text.maxLength = 60;
  const url = el("input");
  url.placeholder = "凭据链接（可选）";
  const add = el("button", "btn small", "加一条");
  add.type = "button";
  const submit = async (k, t, u) => {
    try { await api("POST", "/api/edges", { uid: S.uid, kind: k, text: t, evidence_url: u || "" }); setView("position"); } catch (err) { toast(err.message); }
  };
  add.onclick = () => submit(kind.value, text.value, url.value);
  text.addEventListener("keydown", (ev) => { if (ev.key === "Enter") add.click(); });
  form.append(kind, text, url, add);
  intro.appendChild(form);
  if (d.suggest.length) {
    const sug = el("div", "edge-suggest", "<span>画像里记着，可以加成自述：</span>");
    d.suggest.forEach((s) => {
      const b = el("button", "chip", `+ ${esc(s.text)}`);
      b.type = "button";
      b.onclick = () => submit(s.kind, s.text.slice(0, 60), "");
      sug.appendChild(b);
    });
    intro.appendChild(sug);
  }
  body.appendChild(intro);
}

const CADENCE = { daily: "每天", weekly: "每周", "when-needed": "用时再看" };

async function paintSources(seq, body) {
  const dir = S.srcDir || (await myDirection()) || "ai";
  const m = await api("GET", `/api/channels?uid=${S.uid}&direction=${dir}`);
  if (stale(seq)) return;
  const panel = el("div", "panel");
  panel.appendChild(el("p", "panel-sub", "不是每个人都读 arXiv。每个方向的人在不同的地方说话：中文圈和英文圈各自漏掉一半。标出你常看的——你常看、同学少看的地方，就是一条边。"));
  const bar = el("div", "src-bar");
  const sel = el("select");
  sel.innerHTML = Object.entries(FIELD_TREES).map(([code, f]) => `<option value="${code}">${esc(f.name)}</option>`).join("");
  sel.value = dir;
  sel.onchange = () => { S.srcDir = sel.value; setView("position"); };
  bar.appendChild(sel);
  const sum = m.summary;
  bar.appendChild(el("span", "", `你常看：中文圈 ${sum["中文圈"].read}/${sum["中文圈"].total} · 英文圈 ${sum["英文圈"].read}/${sum["英文圈"].total}${m.checked_at ? ` · 清单核对于 ${esc(m.checked_at)}` : ""}`));
  panel.appendChild(bar);
  if (!m.channels.length) {
    panel.appendChild(el("div", "note-box", "这个方向的信息源清单还没有整理好。"));
    body.appendChild(panel);
    return;
  }
  if (m.blind_spot) panel.appendChild(el("div", "why-box", `<b>常见盲区　</b>${esc(m.blind_spot)}`));
  if (m.other_circle_unread.length) panel.appendChild(el("p", "form-note", `你读得多的那一圈之外，这个方向的人还在：${m.other_circle_unread.map(esc).join("、")}`));
  const groups = [[dir, `${(FIELD_TREES[dir] || {}).name || dir}`], ["career", "进组、夏令营与机会（各方向通用）"]];
  groups.forEach(([g, title]) => {
    const rows = m.channels.filter((c) => c.group === g);
    if (!rows.length) return;
    // 方向本身的信息源直接摊开；各方向通用的进组信息收起来，免得一页太长
    const host = g === dir ? panel : el("details", "src-more");
    if (g === dir) panel.appendChild(el("p", "section-label", `${esc(title)} · ${rows.length}`));
    else { host.appendChild(el("summary", "", `${esc(title)} · ${rows.length}（你常看 ${rows.filter((c) => c.read).length}）`)); panel.appendChild(host); }
    ["中文圈", "英文圈"].forEach((circle) => {
      const cs = rows.filter((c) => c.circle === circle);
      if (!cs.length) return;
      const list = el("div", "src-list");
      list.appendChild(el("p", "src-circle", circle));
      cs.forEach((c) => {
        const card = el("article", `src-card${c.read ? " on" : ""}`);
        const where = c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)} ↗</a>` : `<b>${esc(c.name)}</b>`;
        const sig = (c.signals || []).map((k) => `<span class="src-sig">${esc(m.signal_kinds[k] || k)}</span>`).join("");
        card.innerHTML = `<div class="src-top">${where}<small>${esc(c.kind)} · ${esc(CADENCE[c.cadence] || c.cadence)} · ${esc(c.access)}${c.verified ? "" : " · 未核实"}</small></div>`
          + `<div class="src-sigs">${sig}</div><p>${esc(c.good_for)}</p><p class="src-caveat">偏差：${esc(c.caveat)}</p>`
          + (c.search_hint ? `<p class="src-hint">搜：「${esc(c.search_hint)}」</p>` : "")
          + `<p class="src-band">在用启研的同学里：${esc(c.band)}</p>`;
        const t = el("button", c.read ? "btn small" : "btn small secondary", c.read ? "✓ 我常看" : "我常看");
        t.type = "button";
        t.onclick = async () => {
          try { await api("POST", "/api/channels/toggle", { uid: S.uid, id: c.id, on: !c.read, direction: dir }); setView("position"); } catch (e) { toast(e.message); }
        };
        card.appendChild(t);
        list.appendChild(card);
      });
      host.appendChild(list);
    });
  });
  if (m.career_blind_spot) panel.appendChild(el("p", "map-foot", `进组信息的盲区：${esc(m.career_blind_spot)}`));
  if (m.access_note) panel.appendChild(el("p", "map-foot", esc(m.access_note)));
  body.appendChild(panel);
}

async function paintMap(seq, body) {
  const m = await api("GET", `/api/map?uid=${S.uid}&kit=${S.kitId}`);
  if (stale(seq)) return;
  const mismatch = kitMismatch(m.kit.direction, await myDirection());
  if (stale(seq)) return;
  if (mismatch) body.appendChild(mismatch);
  const panel = el("div", "panel");
  panel.appendChild(el("p", "panel-sub", `「${esc(m.kit.name)}」里，作者自己写下的每个开放问题都是一个可以站的位置。需求按周更新、滞后 ${m.lag_days} 天、少于 ${m.k_min} 人不报数；这里没有「最冷门」排行——冷不冷要和你自己的边一起看。`));
  const sortBar = el("div", "map-sort", "<span>排序</span>");
  const sorts = { order: "工具包顺序", mine: "和我的边相关的在前", momentum: "势头" };
  const sortKey = S.mapSort || "order";
  Object.entries(sorts).forEach(([k, label]) => {
    const b = el("button", `linkish${k === sortKey ? " on" : ""}`, label);
    b.type = "button";
    b.onclick = () => { S.mapSort = k; setView("position"); };
    sortBar.appendChild(b);
  });
  panel.appendChild(sortBar);
  const rows = [...m.rows];
  if (sortKey === "mine") rows.sort((a, b) => b.my_edges.length - a.my_edges.length || a.order - b.order);
  if (sortKey === "momentum") rows.sort((a, b) => (b.momentum.relative || 0) - (a.momentum.relative || 0));
  const head = el("div", "map-row map-head", "<span>开放问题（位置）</span><span>需求</span><span>已知供给</span><span>势头 · 12 个月</span><span>你的相关边</span>");
  panel.appendChild(head);
  rows.forEach((r) => {
    const row = el("div", "map-row");
    const mo = r.momentum;
    row.innerHTML = `<div class="map-niche"><b>${esc(r.niche)}</b><p>${esc(r.note)}</p><details><summary>原句 · 《${esc(clip(r.paper, 36))}》${esc(arxivSection(r.section))}</summary><blockquote>「${esc(r.quote)}」</blockquote></details></div>`
      + `<div class="map-cell" title="${esc(r.demand.why)}"><i>需求</i><span class="band ${r.demand.band === "数据不足" ? "na" : ""}">${esc(r.demand.band)}</span></div>`
      + `<div class="map-cell" title="${esc(r.supply.how)}"><i>已知供给</i><span class="band na">${esc(r.supply.status)}</span><small>去问</small></div>`
      + `<div class="map-cell"><i>势头</i><span>${mo.trend ? esc(TREND[mo.trend]) : "—"}</span>${mo.last12 != null ? `<small>${mo.prev12} → ${mo.last12} 篇</small>` : ""}</div>`
      + `<div class="map-cell"><i>你的相关边</i>${r.my_edges.length ? r.my_edges.map((e) => `<span class="edge-mini ${e.status}" title="${esc(e.text)}">${esc(clip(e.text, 24))}</span>`).join("") : '<small>还没有</small>'}${r.read ? "" : '<small class="map-unread">出处还没读</small>'}</div>`;
    const use = el("button", "linkish map-use", "用它写定位 →");
    use.type = "button";
    use.onclick = () => { S.posDraft = { ...(S.posDraft || {}), x_ref: r.id }; S.posTab = "statement"; setView("position"); };
    row.querySelector(".map-niche").appendChild(use);
    panel.appendChild(row);
  });
  const base = m.base && m.base.growth ? `；cs.CL / cs.LG / cs.AI 整体近 12 个月是前 12 个月的 ×${m.base.growth}（核对于 ${esc(m.base.checked_at)}）` : "";
  panel.appendChild(el("p", "map-foot", `依据：${esc(m.formula)}${base}。供给要靠人：问学长学姐哪些组在做、收不收本科生。`));
  if (m.rarity) {
    const r = m.rarity;
    const more = r.status === "ok" && r.total > r.pairs.length ? `（共 ${r.total} 组，只列最少见的 ${r.pairs.length} 组）` : "";
    panel.appendChild(el("p", "map-foot", `你的边两两组合有多稀有${more}：${r.status === "ok" ? r.pairs.map((p) => `${esc(p.a)} × ${esc(p.b)}：${esc(p.band)}`).join("；") || "边不到两条" : esc(r.why)}`));
  }
  body.appendChild(panel);
}

function clip(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function arxivSection(s) {
  const cn = { conclusion: "结论", limitations: "局限", discussion: "讨论" };
  return s ? ` · ${cn[s] || s}` : "";
}

async function paintStatement(seq, body) {
  const [st, map, eg] = await Promise.all([
    api("GET", `/api/statement?uid=${S.uid}&kit=${S.kitId}`),
    api("GET", `/api/map?uid=${S.uid}&kit=${S.kitId}`),
    api("GET", `/api/edges?uid=${S.uid}`),
  ]);
  if (stale(seq)) return;
  const cur = st.statement;
  const draft = S.posDraft || {};
  const state = {
    x_ref: draft.x_ref || (cur && cur.x_ref) || "",
    x_text: draft.x_text ?? ((cur && cur.x_text) || ""),
    y: draft.y || (cur ? [...cur.y_ids] : []),
  };
  const keep = () => { S.posDraft = { ...state }; };

  if (cur) {
    const now = el("div", "panel stmt-now");
    now.appendChild(el("p", "section-label", `现在的定位 · 第 ${cur.version} 版 · ${cur.portfolio_ready ? "可以放进作品集" : "待证明"}`));
    now.appendChild(el("p", "stmt-sentence", esc(cur.sentence)));
    if (cur.niche) now.appendChild(el("p", "form-note", `指向：开放问题「${esc(cur.niche.niche)}」——《${esc(cur.niche.paper)}》${esc(arxivSection(cur.niche.section))}`));
    body.appendChild(now);
  }

  const panel = el("div", "panel");
  panel.appendChild(el("h3", "panel-title", cur ? "改一版" : "写第一版"));
  panel.appendChild(el("p", "panel-sub", "只能你写。启研只核对：X 是否具体、Y 有没有证据、Y 是不是谁都有。不打分，不替你挑位置。"));
  const form = el("div", "stmt-form");
  const line1 = el("div", "stmt-line", "<span>我是能做</span>");
  const x = el("input");
  x.placeholder = "点名对象、方法或数据：如「中文数学题基准上的单次污染检测」";
  x.value = state.x_text;
  x.maxLength = 60;
  line1.appendChild(x);
  line1.appendChild(el("span", "", "的人，"));
  const pick = el("label", "cf");
  pick.appendChild(el("span", "cf-label", "X 指向哪个开放问题"));
  const sel = el("select");
  sel.innerHTML = '<option value="">选一个…</option>' + map.rows.map((r) => `<option value="${r.id}">${esc(r.niche)}${r.my_edges.length ? `（你有 ${r.my_edges.length} 条相关边）` : ""}</option>`).join("");
  sel.value = state.x_ref;
  pick.appendChild(sel);
  const quote = el("p", "form-note stmt-quote");
  const paintQuote = () => {
    const r = map.rows.find((row) => row.id === sel.value);
    quote.innerHTML = r ? `原句：「${esc(r.quote)}」——《${esc(r.paper)}》${esc(arxivSection(r.section))}` : "";
  };
  paintQuote();
  const ylab = el("p", "cf-label", "因为（从边清单里选，至少一条已证明的才能进作品集）");
  const ys = el("div", "edge-pick");
  eg.edges.forEach((e) => {
    const b = el("button", `edge-toggle${state.y.includes(e.id) ? " on" : ""}`, edgeChip(e));
    b.type = "button";
    b.onclick = () => {
      state.y = state.y.includes(e.id) ? state.y.filter((i) => i !== e.id) : [...state.y, e.id];
      b.classList.toggle("on");
      keep(); check();
    };
    ys.appendChild(b);
  });
  if (!eg.edges.length) ys.appendChild(el("p", "form-note", "边清单还是空的——先去「边清单」加几条。"));
  const checks = el("div", "rubric-list stmt-checks");
  const acts = el("div", "submit-actions");
  const save = el("button", "btn", cur ? `保存为第 ${cur.version + 1} 版` : "保存第一版");
  save.type = "button";
  acts.appendChild(save);
  acts.appendChild(el("span", "hint", "旧版本都留着；新证明了一条边，回来改一版。"));
  form.append(line1, pick, quote, ylab, ys, checks, acts);
  panel.appendChild(form);
  body.appendChild(panel);

  let timer = null;
  let checkGen = 0;  // 每次编辑加一；回来的检查结果编号不是最新的就丢掉
  async function check() {
    clearTimeout(timer);
    const gen = ++checkGen;
    timer = setTimeout(async () => {
      let r;
      try { r = await api("POST", "/api/statement", { uid: S.uid, kit: S.kitId, x_ref: state.x_ref, x_text: state.x_text, y: state.y, dry_run: true }); } catch (_) { return; }
      // 旧的检查可能比新的晚回来（服务器按到达先后排队），原来会用旧结果把「保存」又禁掉（Codex 复现）
      if (stale(seq) || gen !== checkGen) return;
      checks.innerHTML = "";
      r.checks.forEach((c) => {
        const mark = c.pass ? "✓" : c.level === "hint" ? "·" : "!";
        checks.appendChild(el("div", `rubric-item ${c.pass ? "pass" : c.level === "hint" ? "is-partial" : "fail"}`,
          `<span class="rubric-mark">${mark}</span><div><p class="rubric-crit">${esc(c.label)}${c.level === "portfolio" && !c.pass ? "<em>进作品集前要改</em>" : ""}</p><p class="rubric-comment">${esc(c.note)}</p></div>`));
      });
      save.disabled = !r.can_save;
    }, 250);
  }
  x.addEventListener("input", () => { state.x_text = x.value; keep(); check(); });
  sel.addEventListener("change", () => { state.x_ref = sel.value; keep(); paintQuote(); check(); });
  save.onclick = async () => {
    save.disabled = true;
    try {
      await api("POST", "/api/statement", { uid: S.uid, kit: S.kitId, x_ref: state.x_ref, x_text: state.x_text, y: state.y });
      S.posDraft = null;
      toast("已保存");
      setView("position");
    } catch (e) { toast(e.message); save.disabled = false; }
  };
  check();
}

async function paintBets(seq, body) {
  const [b, kit] = await Promise.all([api("GET", `/api/bets?uid=${S.uid}`), api("GET", `/api/kits/${S.kitId}`)]);
  if (stale(seq)) return;
  const panel = el("div", "panel");
  panel.appendChild(el("p", "panel-sub", `同时最多 ${b.max} 个目标，每个标「冲 / 稳 / 保」。申请像投资组合：全押一处风险太集中。有限也是信号——「这是我这学期联系的三个组之一」比群发可信。`));
  const list = el("div", "bet-list");
  b.active.forEach((t) => {
    const row = el("div", "bet-row");
    const niche = t.niche ? (kit.open_problems.find((o) => o.id === t.niche) || {}).niche : "";
    row.innerHTML = `<span class="tier tier-${t.tier}">${esc(b.tiers[t.tier])}</span><div class="bet-main"><b>${esc(t.name)}</b><small>${esc(b.kinds[t.kind])}${niche ? ` · ${esc(niche)}` : ""}</small></div>`;
    const end = el("button", "linkish", "结束");
    end.type = "button";
    end.onclick = () => {
      if (row.querySelector(".bet-close")) return;
      const f = el("div", "bet-close");
      const out = el("select");
      out.innerHTML = Object.entries(b.outcomes).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
      const why = el("input");
      why.placeholder = "一句原因：以后的你和后来的同学都用得上";
      const ok = el("button", "btn small", "记下");
      ok.type = "button";
      ok.onclick = async () => { try { await api("POST", `/api/bets/${t.id}/close`, { uid: S.uid, outcome: out.value, reason: why.value }); setView("position"); } catch (e) { toast(e.message); } };
      f.append(out, why, ok);
      row.appendChild(f);
    };
    row.querySelector(".bet-main").appendChild(end);
    list.appendChild(row);
  });
  if (!b.active.length) list.appendChild(el("p", "form-note", "还没有目标。"));
  panel.appendChild(list);
  if (b.checks.length) {
    const c = el("ul", "bet-checks");
    b.checks.forEach((x) => c.appendChild(el("li", x.level, esc(x.note))));
    panel.appendChild(c);
  }
  if (b.active.length < b.max) {
    panel.appendChild(el("p", "section-label", "加一个目标"));
    const f = el("div", "bet-form");
    const name = el("input");
    name.placeholder = "哪个组 / 计划 / 竞赛（写名字）";
    name.maxLength = 40;
    const kind = el("select");
    kind.innerHTML = Object.entries(b.kinds).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
    const tier = el("select");
    tier.innerHTML = Object.entries(b.tiers).map(([k, v]) => `<option value="${k}">${esc(v)} · ${esc(TIER_HINT[k])}</option>`).join("");
    tier.value = "safety";
    const niche = el("select");
    niche.innerHTML = '<option value="">子方向（可选）</option>' + kit.open_problems.map((o) => `<option value="${o.id}">${esc(o.niche)}</option>`).join("");
    const add = el("button", "btn small", "加上");
    add.type = "button";
    add.onclick = async () => { try { await api("POST", "/api/bets", { uid: S.uid, name: name.value, kind: kind.value, tier: tier.value, kit: S.kitId, niche: niche.value }); setView("position"); } catch (e) { toast(e.message); } };
    f.append(name, kind, tier, niche, add);
    panel.appendChild(f);
  }
  if (b.closed.length) {
    const h = el("details", "inventory");
    h.appendChild(el("summary", "", `结束的目标 ${b.closed.length} 个`));
    const ul = el("ul");
    b.closed.forEach((t) => ul.appendChild(el("li", "", `${esc(t.name)}（${esc(b.tiers[t.tier])}）<span>${esc(b.outcomes[t.outcome])}：${esc(t.reason)}</span>`)));
    h.appendChild(ul);
    panel.appendChild(h);
  }
  body.appendChild(panel);
}

/* ---------- ⑧ me 页 ---------- */

async function renderMe() {
  const seq = S.renderSeq;
  const r = await api("GET", `/api/me/facts?uid=${S.uid}`);
  if (stale(seq)) return;
  const facts = r.facts.filter((f) => f.status !== "deleted" && f.status !== "dismissed");
  $app.innerHTML = "";
  $app.appendChild(workspaceHead("记录", "它记住的每一条都写着来源。说得不对可以改，不想让它记着可以删。"));
  $app.appendChild(accountPanel());
  const main = el("div", "panel");

  const groups = {};
  facts.forEach((f) => { (groups[f.category] = groups[f.category] || []).push(f); });
  Object.keys(CAT_CN).forEach((cat) => {
    if (!groups[cat] || !groups[cat].length) return;
    const g = el("section", "fact-group");
    g.appendChild(el("h3", "section-label", `${CAT_CN[cat]} · ${groups[cat].length}`));
    const list = el("div", "fact-list");
    groups[cat].forEach((f) => list.appendChild(factCard(f, false, S.newFactIds.includes(f.id))));
    g.appendChild(list);
    main.appendChild(g);
  });
  if (!facts.length) {
    main.appendChild(el("p", "panel-sub", "还没有记录。先去对话里聊几句。"));
    const go = el("button", "btn", "去对话");
    go.type = "button";
    go.style.marginTop = "16px";
    go.onclick = () => setView("dialogue");
    main.appendChild(go);
  }
  $app.appendChild(main);
}

/* ---------- 边学边练：项目 ---------- */

const STAGES = [
  { value: 0, label: "只学了概念", hint: "刚看过定义和例子，还没动手" },
  { value: 1, label: "做过小任务", hint: "在树上交过一两次二十分钟任务" },
  { value: 2, label: "学完一块", hint: "走完一个分支，或学过一门相关课" },
  { value: 3, label: "做过项目", hint: "交过一个完整的练手项目" },
];

const STATUS_CN = { pass: "做到", partial: "部分做到", fail: "还没做到" };
const STATUS_MARK = { pass: "✓", partial: "~", fail: "!" };

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}

function projectTabs(active, mineCount) {
  const nav = el("nav", "ws-tabs");
  [["find", "找项目"], ["mine", mineCount ? `我的项目 · ${mineCount}` : "我的项目"]].forEach(([key, label]) => {
    const b = el("button", `ws-tab${key === active ? " on" : ""}`, label);
    b.type = "button";
    b.onclick = () => { S.projectTab = key; setView("projects"); };
    nav.appendChild(b);
  });
  return nav;
}

async function renderProjects() {
  const seq = S.renderSeq;
  await ensurePortrait();
  if (stale(seq)) return;
  const [ctx, mine] = await Promise.all([
    api("GET", `/api/projects/context?uid=${S.uid}`).catch(() => null),
    api("GET", `/api/projects/mine?uid=${S.uid}`).catch(() => ({ projects: [] })),
  ]);
  if (stale(seq)) return;
  const tab = S.projectTab || "find";
  $app.innerHTML = "";
  $app.appendChild(workspaceHead("项目", "学完一块之后，找一个有公开来源的真项目练手。成果打成一个压缩包交上来，按五条标准看它像不像这个项目要的东西。"));
  $app.appendChild(projectTabs(tab, (mine.projects || []).length));
  if (tab === "mine") { renderMine(mine.projects || []); return; }

  const t = trail();
  const field = activeField(t);
  const node = field ? currentOnPath(field, t.done) : null;
  const pathsBy = (ctx && ctx.paths) || {};
  const form = S.projectForm || {
    direction: (ctx && ctx.direction) || t.code || "ai",
    stage: ctx ? ctx.stage : 0,
    keywords: S.projectKeywords || "",
  };
  S.projectKeywords = "";
  // 任务 4 的路径：有路径的方向按「第几步」选，没有的按四个阶段选
  const defaultStep = (stage) => ({ 0: 1, 1: 2, 2: 3, 3: 5 }[stage] || 1);
  // 优先按方向树上的位置（当前节点属于路径第几步），其次按服务端记录推
  const treeStep = field && field.chain && node && t.code === form.direction ? stepOf(field, node.id) : null;
  if (!form.pathStep) {
    form.pathStep = treeStep ? treeStep.stage : ((ctx && ctx.path_step) || defaultStep(form.stage));
    form.fromTree = !!treeStep;
  }
  S.projectForm = form;

  const panel = el("div", "panel project-form");
  panel.appendChild(el("h3", "section-label", "方向"));
  const dirs = el("div", "field-switch");
  const paintDirs = () => {
    dirs.innerHTML = "";
    BACKEND_CODES.forEach((code) => {
      const f = FIELD_TREES[code];
      if (!f) return;
      const b = el("button", "field-chip" + (code === form.direction ? " on" : ""), `<span>${esc(f.name)}</span>`);
      b.type = "button";
      b.onclick = () => { form.direction = code; paintDirs(); paintStages(); };
      dirs.appendChild(b);
    });
  };
  paintDirs();
  panel.appendChild(dirs);

  const stageLabel = el("h3", "section-label");
  const stages = el("div", "stage-pick");
  stages.setAttribute("role", "radiogroup");
  const stageNote = el("p", "form-note");
  const radio = (b, on) => { b.type = "button"; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", on ? "true" : "false"); };
  function paintStages() {
    stages.innerHTML = "";
    const path = pathsBy[form.direction];
    stages.classList.toggle("path", !!path);
    if (path) {
      stageLabel.textContent = "你在路径的哪一步";
      path.steps.forEach((st) => {
        const on = st.step === form.pathStep;
        const b = el("button", "stage-opt" + (on ? " on" : ""), `<i>第 ${st.step} 步</i><b>${esc(st.name)}</b><small>过关：${esc(st.done_when)}</small>`);
        radio(b, on);
        b.onclick = () => { form.pathStep = st.step; form.stage = st.project_stage; paintStages(); };
        stages.appendChild(b);
      });
      const cur = path.steps.find((st) => st.step === form.pathStep);
      if (cur) form.stage = cur.project_stage;
      const why = form.fromTree && form.pathStep === (treeStep && treeStep.stage)
        ? `按你在方向树上的位置预选：第 ${form.pathStep} 步，不对就改。`
        : (ctx && ctx.reason ? `按你的记录预选：${ctx.reason}，不对就改。` : "");
      stageNote.textContent = `六步来自任务 4 的「${path.name}」路径（${path.source_doc}）。按你选的这一步找能交出它过关材料的项目。${why}`;
    } else {
      stageLabel.textContent = "你现在走到哪";
      STAGES.forEach((st) => {
        const on = st.value === form.stage;
        const b = el("button", "stage-opt" + (on ? " on" : ""), `<b>${st.label}</b><small>${st.hint}</small>`);
        radio(b, on);
        b.onclick = () => { form.stage = st.value; form.pathStep = defaultStep(st.value); paintStages(); };
        stages.appendChild(b);
      });
      stageNote.textContent = ctx && ctx.reason ? `按你的记录预选：${ctx.reason}。不对就改。` : "";
    }
  }
  paintStages();
  panel.append(stageLabel, stages, stageNote);

  panel.appendChild(el("h3", "section-label", "想练的关键词（可选）"));
  const row = el("div", "chat-input-row");
  const kw = el("input");
  kw.value = form.keywords;
  kw.placeholder = node ? `例如：${node.label}` : "例如：数据可视化、问卷、证明";
  kw.maxLength = 40;
  kw.setAttribute("aria-label", "关键词");
  kw.addEventListener("input", () => { form.keywords = kw.value; });
  const go = el("button", "btn", "找项目");
  go.type = "button";
  row.append(kw, go);
  panel.appendChild(row);
  $app.appendChild(panel);

  const out = el("div", "project-results");
  $app.appendChild(out);

  // 回车不经过按钮，按钮禁用挡不住：在 run() 自己身上防重入，免得连按几次就发几次检索（每次都可能调模型排序）
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    go.disabled = true; go.textContent = "正在查…";
    out.innerHTML = "";
    const wait = el("div", "panel");
    wait.appendChild(el("p", "panel-sub", "正在逐个来源检索公开项目，第一次大约十几秒。查到什么就给什么，查不到会如实写。"));
    out.appendChild(wait);
    try {
      const r = await api("POST", "/api/projects/search", {
        uid: S.uid, direction: form.direction, stage: form.stage, keywords: form.keywords.trim(),
        path_step: pathsBy[form.direction] ? form.pathStep : 0,
      });
      if (stale(seq)) return;
      S.projectResult = r;
      paintResults(out, r);
    } catch (e) {
      out.innerHTML = "";
      out.appendChild(el("div", "note-box", `检索失败（如实说明）：${esc(e.message)}`));
    } finally {
      busy = false;
      go.disabled = false; go.textContent = "找项目";
    }
  };
  go.onclick = run;
  kw.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) run(); });
  if (S.projectResult && S.projectResult.query && S.projectResult.query.direction === form.direction && S.projectResult.query.stage === form.stage
    && (S.projectResult.query.path_step || 0) === (pathsBy[form.direction] ? form.pathStep : 0)) {
    paintResults(out, S.projectResult);
  }
}

function paintResults(out, r) {
  out.innerHTML = "";
  const list = r.sources || [];
  const live = list.filter((s) => s.ok && s.live).length;
  const snap = list.filter((s) => s.ok && s.snapshot).length;
  const bad = list.filter((s) => !s.ok).length;
  const sources = el("details", "source-status");
  sources.appendChild(el("summary", "", `查了 ${list.length} 个来源：实时 ${live} 个 · 快照 ${snap} 个${bad ? ` · 没查到 ${bad} 个` : ""}`));
  const chips = el("div", "src-chips");
  list.forEach((s) => {
    const ok = s.ok;
    chips.appendChild(el("span", `src-chip ${ok ? "ok" : "bad"}`,
      `${ok ? "✓" : "✕"} ${esc(s.name)}<i>${ok ? `${s.count} 条${s.snapshot ? " · 快照" : ""}` : esc(s.error || "没查到")}</i>`));
  });
  sources.appendChild(chips);
  const head = el("div", "results-head");
  head.appendChild(el("h3", "panel-title", r.items && r.items.length ? `找到 ${r.items.length} 个可以做的项目` : "这次没有找到合适的项目"));
  head.appendChild(el("p", "panel-sub", `${esc(r.query.direction_name)} · ${r.query.path_step ? `路径第 ${r.query.path_step} 步「${esc(r.query.path_step_name)}」` : esc(r.query.stage_label)}${r.query.keywords ? ` · 「${esc(r.query.keywords)}」` : ""} · 检索于 ${fmtTime(r.retrieved_at)}${r.voice === "llm" ? "" : " · 规则版挑选"}`));
  out.append(head, sources);

  if (!r.items || !r.items.length) {
    out.appendChild(el("div", "note-box", esc(r.empty_reason || "来源里没有和这个方向、这个阶段对得上的公开项目。我们不补一个假的；可以换个关键词，或照下面的路线自己去看。")));
  }
  (r.items || []).forEach((p) => out.appendChild(projectCard(p)));

  if (r.routes && r.routes.length) {
    const routes = el("details", "panel routes");
    routes.open = !(r.items && r.items.length);
    routes.appendChild(el("summary", "", `去哪找更多 · ${r.routes.length} 个来源`));
    routes.appendChild(el("p", "panel-sub", "这些来源要你自己去看（需要登录、按届发布，或没有公开接口）。每条写了点哪里、搜什么。"));
    r.routes.forEach((rt) => {
      const item = el("div", "route");
      item.innerHTML = `<p class="route-name"><a href="${esc(rt.url)}" target="_blank" rel="noopener">${esc(rt.name)} ↗</a><span>${esc(rt.kind_label || "")}${rt.cadence ? " · " + esc(rt.cadence) : ""}</span></p><p class="route-how">${esc(rt.manual_route)}</p>${rt.search_terms && rt.search_terms.length ? `<p class="route-terms">搜：${rt.search_terms.map((t) => `<code>${esc(t)}</code>`).join(" ")}</p>` : ""}`;
      routes.appendChild(item);
    });
    out.appendChild(routes);
  }
}

function projectCard(p) {
  const card = el("article", "panel project-card");
  const top = el("div", "project-top");
  top.appendChild(el("h3", "project-name", `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>`));
  if (p.difficulty) top.appendChild(el("span", "badge plain", esc(p.difficulty)));
  card.appendChild(top);
  card.appendChild(el("p", "project-src", `${p.path_step ? `对应路径第 ${p.path_step} 步 · ` : ""}${esc(p.source_name)} · 检索于 ${fmtTime(p.retrieved_at)}${p.snapshot ? " · 快照" : ""}${p.deadline ? ` · ${p.closed ? `已截止（${esc(p.deadline)}），可当练习` : `截止 ${esc(p.deadline)}`}` : ""}`));
  const dl = el("dl", "project-facts");
  dl.innerHTML = `<dt>在练什么</dt><dd>${esc(p.practices || "来源里没写明。")}</dd><dt>大概要做什么</dt><dd>${esc(p.todo || "来源里没写明，打开链接看原题。")}</dd>${p.why_fit ? `<dt>为什么是现在</dt><dd>${esc(p.why_fit)}</dd>` : ""}`;
  card.appendChild(dl);
  if (p.evidence_quote) card.appendChild(el("p", "project-quote", `原文：「${esc(p.evidence_quote)}」`));
  const acts = el("div", "submit-actions");
  const pick = el("button", "btn small", p.picked ? "已在我的项目里" : "就练这个");
  pick.type = "button";
  pick.disabled = !!p.picked;
  pick.onclick = async () => {
    pick.disabled = true;
    try {
      const saved = await api("POST", "/api/projects/pick", { uid: S.uid, id: p.id });
      p.picked = true;
      S.projectId = saved.id;
      setView("project");
    } catch (e) { toast(e.message); pick.disabled = false; }
  };
  const open = el("a", "btn small secondary", "打开来源 ↗");
  open.href = p.url; open.target = "_blank"; open.rel = "noopener";
  acts.append(pick, open);
  card.appendChild(acts);
  return card;
}

function renderMine(list) {
  const panel = el("div", "panel");
  if (!list.length) {
    panel.appendChild(el("p", "panel-sub", "还没有选定项目。在「找项目」里挑一个「就练这个」。"));
    $app.appendChild(panel);
    return;
  }
  const rows = el("div", "fact-list");
  list.forEach((p) => {
    const last = (p.reviews || [])[0];
    const row = el("button", "mine-row");
    row.type = "button";
    const state = p.status === "done" ? `做完了 · ${last.passed}/${last.total} 条做到` : (last ? `最近一次 ${last.passed}/${last.total} 条做到，还可以再改` : "还没交");
    row.innerHTML = `<span class="mine-name">${esc(p.name)}</span><span class="mine-meta">${esc(p.source_name || "")} · ${state}</span>`;
    row.onclick = () => { S.projectId = p.id; setView("project"); };
    rows.appendChild(row);
  });
  panel.appendChild(rows);
  $app.appendChild(panel);
}

async function renderProject() {
  const seq = S.renderSeq;
  if (!S.projectId) { S.projectTab = "mine"; setView("projects"); return; }
  let p;
  try {
    p = await api("GET", `/api/projects/${S.projectId}?uid=${S.uid}`);
  } catch (e) {
    if (stale(seq)) return;
    S.projectTab = "mine"; setView("projects"); toast(e.message); return;
  }
  if (stale(seq)) return;
  $app.innerHTML = "";
  const back = el("button", "linkish back-link", "← 我的项目");
  back.type = "button";
  back.onclick = () => { S.projectTab = "mine"; setView("projects"); };
  $app.appendChild(back);
  $app.appendChild(workspaceHead(esc(p.name)));
  $app.appendChild(el("div", "ws-status", `<span><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.source_name)} ↗</a></span><span>检索于 ${fmtTime(p.retrieved_at)}</span>`));

  const spec = el("div", "panel");
  const dl = el("dl", "project-facts");
  dl.innerHTML = `<dt>在练什么</dt><dd>${esc(p.practices || "来源里没写明。")}</dd><dt>大概要做什么</dt><dd>${esc(p.todo || "来源里没写明，打开链接看原题。")}</dd>`;
  spec.appendChild(dl);
  spec.appendChild(el("h3", "section-label", "压缩包里至少要有"));
  const need = el("ul", "criteria");
  [
    "README.md（放在最外层）：题目和来源链接、我做了什么、结果在哪、怎么复现、还没做完的",
    "results/：你自己做出来的图、表、输出或报告，每个文件在 README 里有一句说明",
    "代码类项目放 src/ 或 .ipynb，并写清怎么运行；调查、写作类项目写清数据来源和方法",
    "只交 .zip，不超过 20 MB；大数据集只放样例，写下载链接",
  ].forEach((t) => need.appendChild(el("li", "", esc(t))));
  spec.appendChild(need);
  spec.appendChild(el("h3", "section-label", "怎么评"));
  const how = el("ul", "criteria");
  ["说清了要解决什么问题", "有自己做出来的结果", "和项目要求对得上", "别人能照着核对或复现", "说清了没做完的和下一步"]
    .forEach((t) => how.appendChild(el("li", "", t)));
  spec.appendChild(how);
  spec.appendChild(el("p", "form-note", "只看压缩包里的文件，不评价你这个人，也不猜你没写出来的东西。"));
  const acts = el("div", "submit-actions");
  const tpl = el("button", "btn small secondary", "下载 README 模板");
  tpl.type = "button";
  tpl.onclick = async () => {
    const res = await apiFetch(`/api/projects/${p.id}/readme?uid=${S.uid}`);
    if (!res.ok) { toast("模板下载失败"); return; }
    downloadBlob(await res.blob(), "README.md");
  };
  const sample = el("button", "btn small ghost", "看一份示例压缩包");
  sample.type = "button";
  sample.onclick = async () => {
    const res = await apiFetch(`/api/projects/${p.id}/sample.zip?uid=${S.uid}`);
    if (!res.ok) { toast("示例生成失败"); return; }
    downloadBlob(await res.blob(), "示例成果.zip");
  };
  acts.append(tpl, sample);
  spec.appendChild(acts);
  $app.appendChild(spec);

  const up = el("div", "panel");
  up.appendChild(el("h3", "panel-title", "交成果"));
  const drop = el("label", "dropzone");
  const file = el("input");
  file.type = "file"; file.accept = ".zip,application/zip"; file.hidden = true;
  drop.append(file, el("span", "", "把 .zip 拖到这里，或点这里选文件"));
  up.appendChild(drop);
  const result = el("div", "review-out");
  up.appendChild(result);
  $app.appendChild(up);

  const shownIn = S.portraitId;  // 这个项目页属于哪份画像：交的时候带上，期间切走了服务器就不收
  const send = async (f) => {
    if (!f) return;
    if (!/\.zip$/i.test(f.name)) { toast("只收 .zip 文件"); return; }
    if (f.size > 20 * 1024 * 1024) { toast("压缩包超过 20 MB"); return; }
    drop.classList.add("busy");
    drop.querySelector("span").textContent = `正在看「${f.name}」…`;
    try {
      const at = shownIn ? `&portrait=${encodeURIComponent(shownIn)}` : "";
      const res = await apiFetch(`/api/projects/${p.id}/submit?uid=${S.uid}${at}`, {
        method: "POST", headers: { "Content-Type": "application/zip" }, body: f,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.detail) || `提交失败 (${res.status})`);
      paintReview(result, data, false, (p.reviews || [])[0]);
      if (data.recorded === false) {
        // 评阅做完了但没记进项目（比如评阅期间在别的页面切了画像）：照样给看结果，但说清楚没保存
        result.prepend(el("div", "note-box", esc(data.note || "这次评阅没有保存。") + "要保存的话，切回原来的画像再交一次。"));
      } else {
        p.reviews = [data].concat(p.reviews || []);
      }
      result.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      result.innerHTML = "";
      result.appendChild(el("div", "note-box", esc(e.message)));
    }
    drop.classList.remove("busy");
    drop.querySelector("span").textContent = "再交一版：把 .zip 拖到这里，或点这里选文件";
    file.value = "";
  };
  file.onchange = () => send(file.files[0]);
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); send(e.dataTransfer.files[0]); });

  if (p.reviews && p.reviews.length) paintReview(result, p.reviews[0], true, p.reviews[1]);
}

function paintReview(box, r, old, prev) {
  box.innerHTML = "";
  const sec = el("section", "feedback");
  if (prev && typeof prev.passed === "number") {
    const d = r.passed - prev.passed;
    sec.appendChild(el("p", `review-delta ${d > 0 ? "up" : d < 0 ? "down" : ""}`,
      d > 0 ? `比上一版多做到 ${d} 条（${prev.passed} → ${r.passed}）` : d < 0 ? `比上一版少了 ${-d} 条（${prev.passed} → ${r.passed}），看看是不是漏交了文件` : `和上一版一样是 ${r.passed} 条，看下面「下一步」改的那一处有没有落到文件里`));
  }
  const head = el("div", "feedback-head");
  const hl = el("div");
  hl.appendChild(el("h3", "", old ? "上一次的评阅" : "评阅"));
  hl.appendChild(el("p", "", `${esc(r.summary || "")}${r.voice === "llm" ? "" : "（规则版）"}`));
  head.appendChild(hl);
  head.appendChild(el("div", "score-ring", `<span class="num">${r.passed}</span>/ ${r.total} 条做到`));
  sec.appendChild(head);
  const list = el("div", "rubric-list");
  (r.criteria || []).forEach((c) => {
    const ev = (c.evidence || []).filter((e) => e.file)
      .map((e) => `<span class="ev"><code>${esc(e.file)}</code>${e.quote ? `「${esc(e.quote)}」` : ""}</span>`).join("");
    list.appendChild(el("div", `rubric-item ${c.status === "pass" ? "pass" : "fail"} is-${c.status}`,
      `<span class="rubric-mark" aria-label="${STATUS_CN[c.status]}">${STATUS_MARK[c.status]}</span><div><p class="rubric-crit">${esc(c.criterion)}<em>${STATUS_CN[c.status]}</em></p><p class="rubric-comment">${esc(c.comment)}</p>${ev ? `<p class="rubric-ev">${ev}</p>` : ""}${c.fix ? `<p class="rubric-fix">改：${esc(c.fix)}</p>` : ""}</div>`));
  });
  sec.appendChild(list);
  if (r.next_step) sec.appendChild(el("div", "why-box", `<b>下一步　</b>${esc(r.next_step)}`));
  if (r.passed === r.total) {
    const acts = el("div", "submit-actions");
    const nextOne = el("button", "btn", "找下一个项目（难一档）");
    nextOne.type = "button";
    nextOne.onclick = () => {
      const f = S.projectForm || {};
      S.projectForm = f.direction ? { ...f, stage: Math.min(3, (f.stage || 0) + 1), pathStep: Math.min(6, (f.pathStep || 1) + 1) } : null;
      S.projectResult = null; S.projectTab = "find"; setView("projects");
    };
    const today = el("button", "btn ghost", "回今日");
    today.type = "button";
    today.onclick = () => setView("today");
    acts.append(nextOne, today);
    sec.appendChild(acts);
  }
  const files = el("details", "inventory");
  if (!(r.inventory || []).length) files.hidden = true;
  files.appendChild(el("summary", "", `压缩包里的 ${(r.inventory || []).length} 个文件`));
  const ul = el("ul");
  (r.inventory || []).forEach((i) => ul.appendChild(el("li", "", `<code>${esc(i.path)}</code><span>${esc(i.kind)} · ${Math.max(1, Math.round(i.size / 1024))} KB</span>`)));
  files.appendChild(ul);
  (r.notes || []).forEach((n) => files.appendChild(el("p", "form-note", esc(n))));
  sec.appendChild(files);
  if (r.fact) {
    const fl = el("div", "fact-list");
    fl.appendChild(factCard(r.fact, false, !old));
    sec.appendChild(fl);
  }
  box.appendChild(sec);
}

/* ---------- 事实卡组件 ---------- */

function factCard(f, editable = false, isNew = false) {
  const card = el("div", `fact-card${isNew ? " new-fact" : ""}`);
  const valueHtml = editable
    ? `<input type="text" value="${esc(f.value)}" />`
    : `<div class="fact-value">${esc(f.value)}</div>`;
  const evidence = (f.evidence || []).map((e) => esc(e.quote ? `「${e.quote}」` : (e.type === "submission" ? `任务提交《${e.task_title || ""}》` : e.type === "project_submission" ? `项目成果《${e.task_title || ""}》` : e.type))).join("；");
  const when = f.source === "behavior" && f.created_at ? ` · ${esc(f.created_at.slice(5, 16).replace("T", " "))}` : "";
  card.innerHTML = `
    ${valueHtml}
    <div class="fact-meta">
      <span class="badge cat-${esc(f.category)}">${CAT_CN[f.category] || esc(f.category)}</span>
      <span class="badge plain">${SRC_CN[f.source] || esc(f.source)}${when}</span>
      ${f.status === "draft" ? '<span class="badge draft">待核对</span>' : ""}
    </div>
    ${evidence ? `<div class="fact-evidence">依据：${evidence}</div>` : ""}
    <div class="fact-actions"></div>`;
  if (!editable) {
    const acts = card.querySelector(".fact-actions");
    const edit = el("button", "linkish", "修改");
    edit.type = "button";
    const valueNode = card.querySelector(".fact-value");
    edit.onclick = async () => {
      if (valueNode.querySelector("input")) return;
      const input = el("input"); input.type = "text"; input.value = f.value;
      valueNode.innerHTML = ""; valueNode.appendChild(input); input.focus();
      const save = async () => {
        const v = input.value.trim();
        if (!v || v === f.value) { valueNode.textContent = f.value; return; }
        try {
          await api("PATCH", `/api/me/facts/${f.id}`, { uid: S.uid, value: v });
          f.value = v; valueNode.textContent = v;
          toast("已修改，之后读到的是新版本");
        } catch (e) { toast(e.message); valueNode.textContent = f.value; }
      };
      input.addEventListener("blur", save);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) input.blur();
        if (e.key === "Escape") { input.value = f.value; input.blur(); }
      });
    };
    const del = el("button", "linkish danger", "删除");
    del.type = "button";
    del.onclick = async () => {
      try {
        await api("DELETE", `/api/me/facts/${f.id}?uid=${S.uid}`);
        card.classList.add("is-dismissed");
        del.disabled = true; del.textContent = "已删除"; edit.disabled = true;
        toast("已删除，之后不再读取这一条");
      } catch (e) { toast(e.message); }
    };
    acts.append(edit, del);
  }
  return card;
}

/* 同一个浏览器的另一个标签页退出或换了人：这一页手里的会话和画面都已经不对，跟着重载 */
window.addEventListener("storage", (e) => {
  if (e.key !== null && e.key !== "rg_token") return;
  let now = "";
  try { now = localStorage.getItem("rg_token") || ""; } catch (_) { return; }
  if (now !== S.token) location.reload();
});

/* ---------- 导航 & 启动 ---------- */

document.querySelectorAll(".nav-btn").forEach((b) => {
  b.addEventListener("click", () => {
    if (!S.uid) return;
    if (b.dataset.workspace === "portrait") setView(S.portraitTab || "dialogue");
    else setView(b.dataset.view);
  });
});
document.getElementById("brandHome").addEventListener("click", () => setView("home"));

(async function boot() {
  const t0 = performance.now();
  try {
    const [h, paths] = await Promise.all([api("GET", "/api/health"), api("GET", "/api/paths").catch(() => null)]);
    applyLlmPill(h.llm);
    S.auth = h.auth || null;
    if (paths) applyPaths(paths.paths);
  } catch (_) { /* 健康检查失败不挡页面 */ }
  buildTutorials();
  let needConsent = false;
  if (S.uid && !S.token) {
    // 有账号之前，浏览器里只存了 uid：凭它认领一次，换成会话
    try {
      setSession(await api("POST", "/api/auth/legacy", { uid: S.uid }));
    } catch (e) {
      if (e.status === 401) clearSession();  // 认领过或不存在；网络错误时 uid 是这个人唯一的凭证，不能扔
    }
  }
  if (S.token) {
    try {
      const me = await api("GET", "/api/auth/me");
      setSession(me);
      needConsent = !me.consent_ok;
      await resumeUser();
    } catch (e) {
      if ([401, 404, 410].includes(e.status)) {  // 会话确实没了：清身份（草稿不动）
        clearSession();
        S.resume = "login";
      } else {
        // 网络断了、服务器在重启：会话和草稿都留着，原来这里一律清掉，草稿就永久没了（Codex 复现）
        setTimeout(() => toast("暂时连不上服务器，稍后刷新一下"), 800);
      }
    }
  }
  let next = "home", note = "";
  try {
    next = sessionStorage.getItem("rg_next_view") || "home";
    note = sessionStorage.getItem("rg_toast") || "";
    sessionStorage.removeItem("rg_next_view");
    sessionStorage.removeItem("rg_toast");
  } catch (_) { /* 无痕模式等 */ }
  setView(next === "login" && !S.uid ? "login" : next !== "home" && S.uid ? next : "home");
  if (note) toast(note);
  if (needConsent) openPrivacy(true);
  // 开场最多停 0.7 秒：数据到了就走，不再固定等 1.4 秒
  const splash = document.getElementById("boot");
  setTimeout(() => {
    if (!splash) return;
    splash.classList.add("out");
    setTimeout(() => splash.remove(), 600);
  }, Math.max(0, 700 - (performance.now() - t0)));
})();
