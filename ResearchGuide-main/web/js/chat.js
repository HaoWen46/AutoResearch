/* 启研 · 对话视图（无构建、经典脚本）
 *
 * 走 /api/dialogue/stream：真实阶段推进（观察 → 决策 → 记忆 → 工具 → 组织回复）
 * + 回复正文增量，前端边收边渲染。
 *
 * 与 app.js 的关系：复用它的 api/el/esc/toast/setView/portraitBar 等全局函数，
 * 只把「对话」这一个视图的渲染与交互放在这里，避免继续膨胀 app.js。
 */
"use strict";

const ChatView = (() => {
  let busy = false;      // 正在生成，阻止重复发送
  let abort = null;      // AbortController
  let seq = 0;           // 渲染序号，切走视图后不再写 DOM
  let turnDone = null;   // 正在生成的那一轮做完时兑现：切走再回来的新视图靠它接上

  const STAGE_CN = {
    observe: "正在看你的近况",
    decide: "正在判断这一步该做什么",
    memory: "正在核对要不要记下来",
    tool: "正在查外部资料",
    compose: "正在组织回复",
  };

  /* ---------- Markdown（先转义再套格式，避免注入）---------- */

  function mdLite(src) {
    let t = esc(String(src || ""));
    t = t.replace(/```([\s\S]*?)```/g, (_, code) => `<pre class="md-pre">${code.replace(/^\n/, "")}</pre>`);
    t = t.replace(/^###\s+(.+)$/gm, "<h4>$1</h4>");
    t = t.replace(/^##\s+(.+)$/gm, "<h3>$1</h3>");
    t = t.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");
    t = t.replace(/^\s*[-*]\s+(.+)$/gm, "<li>$1</li>");
    t = t.replace(/^\s*\d+[.)]\s+(.+)$/gm, "<li>$1</li>");
    t = t.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    // 只放行 http/https，其它协议一律当普通文字
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    // 段落：空行分段，段内单换行保留为 <br>
    return t.split(/\n{2,}/).map((block) => {
      const b = block.trim();
      if (!b) return "";
      if (/^<(h[34]|ul|pre|blockquote)/.test(b)) return b;
      return `<p>${b.replace(/\n/g, "<br>")}</p>`;
    }).join("");
  }

  /* ---------- SSE ---------- */

  async function streamTurn(payload, onEvent) {
    abort = new AbortController();
    let res;
    try {
      res = await apiFetch("/api/dialogue/stream", {  // app.js 的 apiFetch：带会话、接口地址
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });
    } catch (e) {
      if (e.name === "AbortError") return null;
      throw e;
    }
    if (!res.ok) {
      let detail = `请求失败 (${res.status})`;
      try { detail = (await res.json()).detail || detail; } catch (_) { /* 无响应体 */ }
      throw new Error(detail);
    }
    // 老浏览器没有 ReadableStream 时退回一次性接口
    if (!res.body || !res.body.getReader) {
      const data = await api("POST", "/api/dialogue/turn", payload);
      onEvent("result", data);
      return data;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let result = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        let name = null;
        for (const line of raw.split("\n")) {
          if (line.startsWith("event: ")) name = line.slice(7).trim();
          else if (line.startsWith("data: ") && name) {
            let data = {};
            try { data = JSON.parse(line.slice(6)); } catch (_) { /* 跳过坏帧 */ }
            if (name === "result") result = data;
            if (name === "error") throw new Error(data.error || "生成失败");
            onEvent(name, data);
          }
        }
      }
    }
    return result;
  }

  /* ---------- 视图 ---------- */

  /* 对话页的页头。以前是三层竖着叠：
       ws-head（标题 + 说明）/ portrait-bar（画像 chip）/ ws-tabs（对话|核对）
     ——标题和主标签之间夹着一个**画像管理**控件，那是次要设置，
     却占了一整行，把真正入口挤下去了。

     现在合成一块，两行：
       对话        [对话|核对]          画像 [默认] [新建]
       直接说话就行。它会先看你的近况…（一行说明）
     标题和标签同行，画像管理退到右侧。 */
  function dialogueHead(bar) {
    const head = el("header", "ws-head ws-head-bar");
    const main = el("div", "ws-bar-main");
    main.appendChild(el("h2", "", "对话"));
    main.appendChild(portraitTabs("dialogue"));
    const side = el("div", "ws-bar-side");
    side.appendChild(el("span", "ws-bar-label", "画像"));
    side.appendChild(bar);
    head.append(main, side);
    head.appendChild(el("p", "ws-lead",
      "直接说话就行。它会先看你的近况，再决定这一步做什么，需要查资料时会去查。"));
    return head;
  }

  async function render($app) {
    const mySeq = ++seq;
    const resumeFrom = turnDone;  // 打开这一页时上一轮还在生成（在别的页等过）：见最后
    const bar = await portraitBar();
    if (mySeq !== seq || S.view !== "dialogue") return;  // 等待期间切到了别的页：不能再往页面上写

    $app.innerHTML = "";
    $app.appendChild(dialogueHead(bar));

    /* 对话页分成**三个有名字的区**，顺序固定，各自管一件事：
         .chat-scroll  对话流     —— 只有气泡，它自己滚
         .chat-next    下一步     —— 行动卡 / 回执 / 可选说法，给最大高度，自己滚
         .chat-input   输入        —— 状态行 + 输入框，永远在最下面
       以前这三样都塞在一个 .chat-foot 里：行动卡和输入框抢同一块地方，
       行动卡一高就把输入框顶出屏幕，而输入框本来该是位置最稳定的那个。 */
    const wrap = el("div", "two-col two-col-chat");
    const chat = el("div", "panel chat-panel chat-wide");
    const scroll = el("div", "chat-scroll");
    scroll.setAttribute("aria-live", "polite");

    // 行动区本身就是「下一步」这个区。.action-slot:empty 已经会隐藏它，
    // 所以没有卡片时不会留一条空带。
    const actions = el("div", "action-slot chat-next");
    const inputZone = el("div", "chat-input");
    const stageLine = el("p", "stage-line");
    const inputRow = el("div", "chat-input-row");
    const input = el("textarea");
    input.rows = 1;
    input.placeholder = "说说你现在的情况，或者你想弄清楚的问题…（Shift + 回车换行）";
    input.setAttribute("aria-label", "对话输入");
    const sendBtn = el("button", "btn small", "发送");
    sendBtn.type = "button";
    const stopBtn = el("button", "btn ghost small", "停止");
    stopBtn.type = "button";
    stopBtn.hidden = true;
    inputRow.append(input, sendBtn, stopBtn);
    // 状态行（正在观察 / 正在查资料）说的是「输入之后会发生什么」，
    // 所以它归输入区，不归行动区——否则它会跟着行动卡一起滚走。
    inputZone.append(stageLine, inputRow);
    chat.append(scroll, actions, inputZone);

    const side = el("div", "panel side-panel");
    side.appendChild(el("p", "side-title", "它记住的我"));
    side.appendChild(el("p", "side-sub", "按「时间跨度」分层。每条都能改——记错了你直接改，比让它一直猜准。"));
    const sideList = el("div", "fact-list memory-board");
    const sideEmpty = el("p", "side-empty", "还什么都没记住。聊到值得长期保留的信息时，这里会按层多一条。");
    side.append(sideList, sideEmpty);
    wrap.append(chat, side);
    $app.appendChild(wrap);

    autoGrow();
    input.focus();

    /* --- 历史 --- */
    // 有一张记忆卡正在编辑时，refreshFacts 不能把面板清掉重建。
    // 编辑框的唯一保存路径是 blur；元素被 innerHTML = "" 拔掉之后
    // blur 不保证触发，用户敲进去的改动会**无声地丢掉**。
    // 所以编辑期间挂起刷新，编辑结束再补一次。
    let editingCard = false;
    let refreshQueued = false;
    let history = { messages: [], pending_action: null };
    try {
      history = await api("GET", `/api/dialogue/history?uid=${encodeURIComponent(S.uid)}`);
    } catch (e) { toast(e.message); }
    if (mySeq !== seq || S.view !== "dialogue") return;  // 等待期间切到了别的页：不能再往页面上写
    history.messages.forEach((m) => addBubble(m.role, m.text));
    if (history.pending_action) {
      renderAction(history.pending_action);
    } else if (history.just_finished) {
      // 刚在任务区把任务交掉了。这时候 pending_action 已经是空的（那一步终结了），
      // 如果什么都不画，用户回到对话就看不到自己刚做完的事——那张卡会凭空消失。
      // 但**只画一张**：再叠一张「这一步已完成」的卡就是在说同一件事，
      // 看起来像有两个任务。just_finished 里已经有标题、字数、得分，信息是全的。
      finishedNote(history.just_finished);
    } else if (history.last_action && history.last_action.status === "completed") {
      // 不是刚交的（比如隔了很久再打开），就只显示那张已完成状态的卡
      renderAction(history.last_action);
    }
    await refreshFacts();
    if (mySeq !== seq || S.view !== "dialogue") return;  // 等待期间切到了别的页：不能再往页面上写
    if (!history.messages.length) {
      addBubble("assistant", "你好。你不用说得很完整——先告诉我你现在最想弄清楚的一件事，或者你手上的情况。");
    }

    /* --- 发送 --- */
    async function send(text) {
      const msg = (text || "").trim();
      if (!msg) return;
      if (busy) { toast("上一句还在生成，等它好了再发"); return; }
      busy = true;
      let finish;
      turnDone = new Promise((resolve) => { finish = resolve; });
      input.value = ""; autoGrow();
      input.disabled = true; sendBtn.disabled = true; stopBtn.hidden = false;
      actions.innerHTML = "";
      addBubble("user", msg);

      const bubble = addBubble("assistant", "");
      bubble.classList.add("streaming");
      let acc = "";
      let firstChunk = true;
      setStage("observe");

      try {
        const result = await streamTurn(
          { uid: S.uid, message: msg, conversation_id: history.conversation_id },
          (name, data) => {
            if (name === "stage") { setStage(data.name, data.tool); return; }
            if (name === "delta") {
              acc += data.text || "";
              if (firstChunk) { bubble.innerHTML = ""; firstChunk = false; }
              bubble.innerHTML = mdLite(acc);
              scroll.scrollTop = scroll.scrollHeight;
            }
          },
        );
        if (mySeq !== seq || S.view !== "dialogue") return;  // 等待期间切到了别的页：不能再往页面上写

        if (result) {
          history.conversation_id = result.conversation_id;
          bubble.innerHTML = mdLite(result.reply);
          afterTurn(result);
        } else if (!acc) {
          bubble.remove();
        }
      } catch (e) {
        if (mySeq === seq) {
          if (acc) { bubble.innerHTML = mdLite(acc); toast("生成中断：" + e.message); }
          else { bubble.remove(); toast(e.message); }
        } else if (e.name !== "AbortError") {
          toast("对话：上一句没生成完（" + e.message + "）");  // 人在别的页：页面上没地方显示，至少说一声
        }
      } finally {
        bubble.classList.remove("streaming");
        busy = false; abort = null; turnDone = null;
        finish();
        if (mySeq === seq) {
          input.disabled = false; sendBtn.disabled = false; stopBtn.hidden = true;
          setStage("");
          input.focus();
        }
      }
    }

    /* 一轮结束后，把「系统做了什么」收进**一个**结构化块。
    
       以前是五种单行 <p> 直接塞进对话流里（记下了/更新了/已查/没记下来/未连接模型），
       顺序还跟着代码走，谁先谁后看运气。用户的原话是
       「信息组织有点逻辑？现在感觉是想到哪里放到哪里」。
    
       现在的规矩很简单，也是这个页面该有的框架：
         · 对话流里**只有对话**（用户和助手说的话）
         · 系统这一轮的副作用全部进这个块，按固定顺序分组
         · 行动卡永远在最上面——它才是用户要动手的东西
    */
    function afterTurn(result) {
      // pending_action 是当前还开着的行动（界面状态）；next_action 只是这一轮决定给的那个
      renderAction(result.pending_action || null);
      renderOffers(result.offered_actions);
      if (result.transcript_import) {
        renderTranscriptReceipt(result.transcript_import);
      }
      const receipt = turnReceipt(result);
      if (receipt) actions.appendChild(receipt);
      if (result.degraded) {
        const d = el("p", "rc-warn", "当前未连接模型，这一轮是规则回复。连接后判断和措辞会好很多。");
        actions.appendChild(d);
      }
      scroll.scrollTop = scroll.scrollHeight;
    }

    /* 系统这一轮的副作用，收成一个块。没有可说的就不渲染。 */
    function turnReceipt(result) {
      const added = result.facts_added || [];
      const changed = result.facts_changed || [];
      const rejected = result.rejected_ops || [];
      const tools = result.tool_results || [];
      const groups = [];

      if (added.length || changed.length) {
        const items = [];
        added.forEach((f) => items.push("记下：" + f.value));
        changed.forEach((f) => items.push("更新：" + f.value));
        groups.push({ label: "记忆", note: `${added.length + changed.length} 条`, items });
        refreshFacts();   // 整块重画，保证分层展示和库里一致
      }
      if (tools.length) {
        const items = tools.map((t) => (t.ok ? `已查 ${t.tool}` : `查询失败（${t.tool}）：${t.error || "没有结果"}`));
        groups.push({ label: "查询", note: "", items });
      }
      if (rejected.length) {
        // 没有依据的说法不会被记下来，如实告诉用户，不装作记住了
        groups.push({
          label: "没采纳", note: `${rejected.length} 条`,
          items: rejected.map((r) => r.reason || "没有依据"),
        });
      }
      if (!groups.length) return null;

      const box = el("div", "receipt");
      box.appendChild(el("p", "rc-head", "这一轮发生了什么"));
      groups.forEach((g) => {
        const row = el("div", "rc-group");
        const head = el("p", "rc-label", esc(g.label));
        if (g.note) head.appendChild(el("span", "rc-count", esc(g.note)));
        row.appendChild(head);
        const ul = el("ul", "rc-list");
        g.items.forEach((t) => ul.appendChild(el("li", "", esc(t))));
        row.appendChild(ul);
        box.appendChild(row);
      });
      return box;
    }

    /* 成绩单导入的回执。它不是「聊了一句」，是一次数据录入，
       所以要说清：读进去几门、绩点怎么算的、哪些没算进去、推出什么结论。 */
    function renderTranscriptReceipt(imp) {
      const box = el("div", "receipt receipt-import");
      box.appendChild(el("p", "rc-head", "成绩单已导入"));
      const s = imp.summary || {};
      const facts = el("div", "ri-facts");
      const cell = (k, v) => {
        const c = el("div", "ri-cell");
        c.appendChild(el("span", "ri-k", esc(k)));
        c.appendChild(el("span", "ri-v", esc(v)));
        facts.appendChild(c);
      };
      cell("课程", `${imp.written} 门`);
      cell("通过学分", String(s.passed_credits != null ? s.passed_credits : "—"));
      cell("绩点", s.gpa != null ? s.gpa.toFixed(4) : "—");
      if (s.gpa_credits != null) cell("计入绩点的学分", String(s.gpa_credits));
      box.appendChild(facts);

      const un = s.ungraded || [];
      if (un.length) {
        box.appendChild(el("p", "rc-warn",
          `${un.length} 门是字母等级/五级制，没有算进绩点（教务换算口径未定，不敢替你定）：`
          + un.map((u) => `${esc(u.course)}（${esc(u.grade)}）`).join("、")));
      }
      const cur = s.in_progress || [];
      if (cur.length) {
        box.appendChild(el("p", "rc-note",
          `${cur.length} 门还在修：` + cur.map((c) => esc(c.course)).join("、")));
      }
      const d = imp.derived || [];
      if (d.length) {
        const ul = el("ul", "rc-list");
        d.forEach((f) => ul.appendChild(el("li", "", esc(f.value))));
        box.appendChild(el("p", "rc-label", "推出的能力结论"));
        box.appendChild(ul);
      }
      const w = imp.warnings || [];
      if (w.length) {
        const ul = el("ul", "rc-list rc-list-warn");
        w.forEach((x) => ul.appendChild(el("li", "", esc(x))));
        box.appendChild(el("p", "rc-label", `没看懂的 ${w.length} 处（不替你补）`));
        box.appendChild(ul);
      }
      actions.appendChild(box);
    }

    /* 模型给的可选说法，点一下就等于把这句话发给它，省去用户组织语言 */
    function renderOffers(list) {
      if (!list || !list.length) return;
      const row = el("div", "offer-row");
      list.forEach((a) => {
        const b = el("button", "chip", esc(a.label));
        b.type = "button";
        b.onclick = () => send(a.label);
        row.appendChild(b);
      });
      actions.appendChild(row);
    }

    /* 刚在任务区交完任务、回到对话时的一句话。
       它是「任务区做完 → 回到对话」这条闭环的可见落点。 */
    function finishedNote(jf) {
      if (!jf) return;
      const p = (jf.payload || {});
      const box = el("div", "finished-note");
      box.appendChild(el("p", "fn-title", `你刚在任务区交了「${esc(jf.title || "")}」`));
      const bits = [];
      if (p.chars) bits.push(`写了 ${p.chars} 字`);
      if (typeof p.score === "number") bits.push(`按标准 ${p.score} 分`);
      if (bits.length) box.appendChild(el("p", "fn-sub", bits.join(" · ")));
      box.appendChild(el("p", "fn-sub", "它已经写进你的「经验积累」了。接着说下一步就行。"));
      addBubble("assistant", `看到了，你把「${jf.title || "那一步"}」交了。我按结果想想下一步。`);
      actions.parentNode.insertBefore(box, actions);
    }

    /* 行动卡。结构固定成四段，位置不随内容变：
         ① 状态（这一步是什么状态）
         ② 标题（要做什么）
         ③ 依据（为什么是给你的）—— 每条一行，不再挤成一句话
         ④ 动作（唯一该做的那件事）
       任务必须说得出依据，所以③不是装饰；没有依据就整段不出现，
       而不是留一个空标题。 */
    function renderAction(a) {
      actions.innerHTML = "";
      if (!a) return;
      const card = el("div", "action-card");
      card.appendChild(el("p", "action-kicker", a.status === "completed" ? "这一步已完成" : "下一步"));
      card.appendChild(el("p", "action-title", esc(a.title)));

      const why = (a.based_on || []).filter((x) => x && x.value);
      if (why.length) {
        const box = el("div", "action-why");
        box.appendChild(el("p", "aw-label", "为什么是给你的"));
        const ul = el("ul", "aw-list");
        why.forEach((x) => ul.appendChild(el("li", "", esc(x.value))));
        box.appendChild(ul);
        card.appendChild(box);
      }

      const row = el("div", "action-btns");

      // 「就做这个」→ 真的建一个任务（服务端 accept 时建），然后去任务区做。
      // 以前这里是「标记完成」，点一下就把这一步算走完了——没有交付物、
      // 没有反馈、也不写回记忆。用户问过「我在对话里出现的任务是要我怎么完成」，
      // 根因就是那个按钮什么都没要求。
      if (a.status === "offered") {
        const go = el("button", "btn small", "就做这个");
        go.type = "button";
        go.onclick = async () => {
          go.disabled = true;
          try {
            const r = await api("POST", "/api/dialogue/action", {
              uid: S.uid, action_id: a.action_id, event: "accept",
            });
            renderAction(r.action);
            actions.appendChild(el("p", "action-hint",
              "任务已建好：说清「做什么 / 交什么 / 怎样算做到」。去任务区完成，回来我按结果给下一步。"));
            addBubble("assistant", "好。右边任务区里已经有这一步了——做完把它交掉，回来我们接着往下走。");
            await refreshFacts();
          } catch (e) { toast(e.message); go.disabled = false; }
        };
        row.appendChild(go);
      } else if (a.status === "accepted" || a.status === "in_progress") {
        // 已接：不再提供「标记完成」，只提供「去做」。完成只能通过提交交付物。
        const go = el("button", "btn small", "去任务区完成");
        go.type = "button";
        go.onclick = () => {
          S.openTaskId = a.task_id || "";
          setView("workbench");
        };
        row.appendChild(go);
      }

      if (a.status !== "completed" && a.status !== "accepted" && a.status !== "in_progress") {
        const no = el("button", "btn ghost small", "先不做");
        no.type = "button";
        no.onclick = async () => {
          no.disabled = true;
          try {
            const r = await api("POST", "/api/dialogue/action",
              { uid: S.uid, action_id: a.action_id, event: "decline" });
            renderAction(r.action);
          } catch (e) { toast(e.message); }
        };
        row.appendChild(no);
      }
      if (a.status === "completed") card.classList.add("done");
      card.appendChild(row);
      actions.appendChild(card);
    }

    /* 按层分列展示记忆。每层的顺序就是提问顺序（身份→当前实践→能力→经历→倾向→约束），
       用户能一眼看出「它把哪些事算成同一类」，也能直接改。

       项目单独做成一叠「文件夹」放在最前面：一个项目一张卡，属性是它的子行。
       存储上 project:kotoba.what / .blocker 仍是各自独立的事实（证据、TTL、
       单独改删都在），这里只是把它们聚起来看——因为用户的原话是
       「识别为大项目的可以创建为大文件夹存储相关记忆」。 */
    async function refreshFacts() {
      // 正在改某一条 → 先不动，等编辑结束再补刷。
      // （见上面 editingCard 的注释：硬刷会把没保存的输入一起抹掉。）
      if (editingCard) { refreshQueued = true; return; }
      try {
        const r = await api("GET", `/api/memory?uid=${encodeURIComponent(S.uid)}`);
        const layers = (r.layers || []).filter((L) => (L.facts || []).length);
        const projects = r.projects || [];
        sideList.innerHTML = "";
        if (projects.length) sideList.appendChild(projectFolders(projects));
        layers.forEach((L) => sideList.appendChild(layerBlock(L)));
        const empty = !layers.length && !projects.length;
        sideEmpty.style.display = empty ? "block" : "none";
      } catch (_) { /* 侧栏失败不影响对话 */ }
    }

    /* 项目文件夹 */
    function projectFolders(projects) {
      const box = el("div", "mem-layer mem-layer-practice");
      box.appendChild(el("p", "mem-layer-head",
        `在做的项目<span class="mem-layer-n">${projects.length}</span>`));
      box.appendChild(el("p", "mem-layer-hint",
        "一个项目一张卡。里面每条都能单独改或删——它们是分开存的。"));
      projects.forEach((pj) => {
        const wrap = el("div", "proj");
        const head = el("div", "proj-head");
        head.appendChild(el("span", "proj-name", esc(pj.name)));
        head.appendChild(el("span", "proj-n", `${pj.facts.length} 条`));
        const body = el("div", "proj-body");
        pj.facts.forEach((f) => {
          const row = el("div", "proj-row");
          row.appendChild(el("span", "proj-k", esc((pj.attr_label || {})[f.id] || "备注")));
          const v = el("div", "proj-v");
          v.appendChild(document.createTextNode(f.value));
          row.appendChild(v);
          body.appendChild(row);
        });
        // 收起/展开：默认展开，项目信息本来就不多
        let open = true;
        head.onclick = () => { open = !open; body.style.display = open ? "" : "none"; };
        wrap.append(head, body);
        box.appendChild(wrap);
      });
      return box;
    }

    function layerBlock(L) {
      const box = el("div", `mem-layer mem-layer-${L.layer}`);
      box.appendChild(el("p", "mem-layer-head",
        `${esc(L.label)}<span class="mem-layer-n">${L.facts.length}</span>`));
      if (L.layer_hint) box.appendChild(el("p", "mem-layer-hint", esc(L.layer_hint)));
      const list = el("div", "mem-layer-list");
      L.facts.forEach((f) => list.appendChild(memoryCard(f)));
      box.appendChild(list);
      return box;
    }

    /* 记忆卡：值可点改，删除走软删。改完来源升级为「你说的」，置信度拉满。

       成绩单推出来的（source=derived）是例外：它的依据是真实课程和分数，
       不给人逐字改。用户对它唯一合理的表态是「这条不算」——
       所以只给「不算」，不给「改」；而且这个「不算」会被记住，
       下次重新推导时不会又冒出来。 */
    function memoryCard(f) {
      const derived = f.source === "derived";
      const card = el("div", `mem-card${derived ? " mem-derived" : ""}`);
      const value = el("div", "mem-value", esc(f.value));
      const meta = el("div", "mem-meta");
      const srcCn = {
        declared: "你说的", inferred: "我推断的", behavior: "做过的",
        derived: "成绩单推的", user_edit: "你改的",
      };
      meta.appendChild(el("span", `badge src-${f.source}`, srcCn[f.source] || esc(f.source)));
      if (f.affects_label) meta.appendChild(el("span", "badge plain", `影响${esc(f.affects_label)}`));
      if (f.valid_until) {
        meta.appendChild(el("span", "badge plain", `到 ${esc(String(f.valid_until).slice(0, 10))} 失效`));
      }
      card.append(value, meta);

      // 依据摊开：让用户能核对我们是从哪几门课得出这句话的。
      // 不摆依据的「结论」就是一句我们说了算的断言——那正是要避免的。
      if (derived) {
        const ev = (f.evidence || []).filter((e) => e.type === "transcript");
        if (ev.length) {
          const basis = el("p", "mem-basis",
            "依据：" + ev.map((e) => `${esc(e.course)} ${esc(String(e.grade))}`).join("、"));
          card.appendChild(basis);
        }
      }

      const acts = el("div", "mem-acts");
      if (!derived) {
        const edit = el("button", "linkish", "改");
        edit.type = "button";
        edit.onclick = () => {
          if (value.querySelector("input")) return;
          const input = el("input");
          input.type = "text";
          input.value = f.value;
          value.innerHTML = "";
          value.appendChild(input);
          input.focus();
          editingCard = true;
          let done = false;
          // 编辑结束（保存 / 取消 / 失焦）时收尾：放掉挂起的刷新。
          const finish = () => {
            editingCard = false;
            if (refreshQueued) { refreshQueued = false; refreshFacts(); }
          };
          const restore = (v) => { value.textContent = v; };
          const save = async () => {
            if (done) return;
            done = true;
            const v = input.value.trim();
            if (!v || v === f.value) { restore(f.value); finish(); return; }
            try {
              await api("PATCH", `/api/me/facts/${f.id}`, { uid: S.uid, value: v });
              restore(v);
              toast("改好了。这条现在算你亲口说的，优先级最高。");
            } catch (e) { toast(e.message); restore(f.value); }
            finish();
          };
          input.addEventListener("blur", save);
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing) input.blur();
            if (e.key === "Escape") { done = true; restore(f.value); finish(); }
          });
        };
        acts.appendChild(edit);
      }
      const del = el("button", "linkish danger", derived ? "不算" : "删");
      del.type = "button";
      del.onclick = async () => {
        del.disabled = true;
        try {
          await api("DELETE", `/api/me/facts/${f.id}?uid=${encodeURIComponent(S.uid)}`);
          card.classList.add("is-dismissed");
          toast(derived ? "好，这条不再拿来说事。你之后再补课程也不会把它翻出来。"
                        : "已删掉，之后不再拿它判断你。");
          setTimeout(refreshFacts, 400);
        } catch (e) { toast(e.message); del.disabled = false; }
      };
      acts.appendChild(del);
      card.appendChild(acts);
      return card;
    }

    function setStage(name, tool) {
      if (!name) { stageLine.textContent = ""; stageLine.classList.remove("on"); return; }
      let text = STAGE_CN[name] || "处理中";
      if (name === "tool" && tool) text = `正在查：${tool}`;
      stageLine.textContent = text;
      stageLine.classList.add("on");
    }

    function addBubble(role, text) {
      const kind = role === "user" ? "user" : "ai";
      const b = el("div", `bubble ${kind}${kind === "ai" ? " md" : ""}`);
      if (kind === "ai") b.innerHTML = mdLite(text); else b.textContent = text;
      scroll.appendChild(b);
      scroll.scrollTop = scroll.scrollHeight;
      return b;
    }

    function autoGrow() {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 160) + "px";
    }

    input.addEventListener("input", autoGrow);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
    });
    sendBtn.onclick = () => send(input.value);
    stopBtn.onclick = () => { if (abort) abort.abort(); };

    // 上一轮在生成时切走又回来：这个新视图里没有那一轮的气泡和进度，旧视图收到的回复也不会画到这里。
    // 还在生成就锁住输入、给停止键；做完（不管在这之前还是之后）从服务器重取一遍历史重画。
    // 原来发送键看着能点、点了没反应，做完的回复也不显示，要手动刷新（Codex 复现）。
    if (resumeFrom) {
      if (busy) {
        input.disabled = true; sendBtn.disabled = true; stopBtn.hidden = false;
        stageLine.textContent = "上一句还在生成，好了会自动显示…";
        stageLine.classList.add("on");
      }
      resumeFrom.then(() => { if (mySeq === seq && S.view === "dialogue") render($app); });
    }
  }

  return { render, mdLite };
})();
