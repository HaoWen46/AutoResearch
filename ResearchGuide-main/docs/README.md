# docs · 文档导航

> 精简后的文档体系（2026-09-25）：从 25 份压缩到 5 份。原则：**文档服务开发，不制造阅读任务**。

---

## ⚠️ 先读这一段：文档状态（2026-10-01 复核）

本目录是 **Week1（9/24–9/28）** 留下的文档集。**Week2 的轮次目标与人员分工不在本目录里**——以仓库上一级的 `任务表.md` 为准。

下列内容**已过期，不要作为开发依据**：

| 文档 | 状态 | 为什么不能看 |
| --- | --- | --- |
| ~~TASK_ASSIGNMENTS.md~~ | **已删除** | Week1 的 6 人分工与 9/25–9/28 时间表。§0.3「接口契约冻结，不许单方面改」会直接阻挡本轮交互改造；§1 的 LLM 真实化早已完成；§4 的 `POST /api/chat`、§5 的导出、§6 的 Docker/CI 多数未实现 |
| ~~NEXT_PRE_2026-09-28.md~~ | **已删除** | 9/28 Pre 的里程碑定义（固定 ≤8 轮脚本、允许 mock LLM），与本轮「自然聊天、不固定五问」的目标**正好相反**；其 ①–⑨ 链路也已被 09-27 的「工作区」改版取代 |
| [README.md](../README.md) | **部分过期** | 「当前状态：W0 Thin Slice」与「三处 LLM 环节为规则演示版」已不成立 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | **部分过期** | 见下一节；但 §3 数据契约与 §5 REST 已按 10-01 的代码更新过一轮 |

### ARCHITECTURE.md 中已不成立的部分

| 位置 | 文档说 | 实际 |
| --- | --- | --- |
| §2 代码树、§2「Mock 边界」、§4「W1 真实化方向」 | `onboarding.py` = mock LLM；只 mock LLM 措辞；LLM 待 W1 真实化 | `server/llm.py` 已是完整 OpenAI 兼容 Provider（JSON 模式 / 流式 / 重试 / 调用日志 / 页面可连接），且已接进 onboarding、planner、workbench、dialogue。该段引用的 `NEXT_PRE §3` 文件已删除 |
| §2「代码树」 | 未列 `memory.py` / `tools.py` / `dialogue.py` / `eval/` | 任务 2 新增，见 `DIALOGUE_CONTRACT.md` |
| §3.1 | 可导出 | **未实现**：me 页只有可改 / 可删 |
| §3.1 | interest 类 60 天自动衰减 | **未实现**：`valid_until` 只覆盖明文声明的 `constraint:*`，没有自动衰减 |
| §6 ADR 8 | 部署：单机 Docker（W1 补 compose + DEPLOY.md） | 已补：`Dockerfile` + `docker-compose.yml` + `docs/DEPLOY.md`；云上生产是函数计算 + GitHub Pages |

> **判定权威顺序：运行中的代码 > `ARCHITECTURE.md` §3/§5 > `DIALOGUE_CONTRACT.md` > 其他任何文档。**
> 当文档与代码冲突时，先读代码，再回来修正文档。

---

## 现行文档

| 文档 | 是什么 | 谁读 |
| --- | --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 技术架构 + 数据契约 + REST 契约（浓缩唯一版） | 写代码前读，注意上面的过期条目 |
| [DIALOGUE_CONTRACT.md](DIALOGUE_CONTRACT.md) | 任务 2 冻结契约：一轮两次调用的 JSON schema、记忆 key registry、工具 registry、九条确定性校验、降级语义 | 改对话 / 记忆 / 决策前**必读** |
| [TASK2_DIALOGUE.md](TASK2_DIALOGUE.md) | 任务 2 交付说明：闭环怎么走、记忆六层与三道闸门、九大类、成绩单与绩点、对话↔任务区、接口与跑法、**改过别人代码的地方** | 接手对话 / 记忆 / 成绩单，或要与任务 2 对接时 |
| [DESIGN_SPEC.md](DESIGN_SPEC.md) | UI 视觉唯一权威（颜色/字体/组件） | 做任何界面前读 |
| [CHANGELOG.md](CHANGELOG.md) | 变更唯一登记处 | 每次开工前扫一眼 |
| [DESIGN_PROPOSAL.md](DESIGN_PROPOSAL.md) | 产品设计提案 v2：定位与博弈层（边 → 竞争地图 → 定位陈述 → 冲 / 稳 / 保）是主价值，研究思维层（读→比→问→提→试）降成本；每日 ≤10 分钟 / 每周重活；双窗口；IA 与关键界面；AI 边界；按天排期与验证计划 | 所有人，先读 §0 一页结论 |
| [READING_POSITIONING.md](READING_POSITIONING.md) | 研读层（阅读卡、矩阵、每日分拣）和定位层（边、竞争地图、定位陈述、冲 / 稳 / 保）的规则、阈值和工具包格式 | 做研读 / 定位、写工具包前读 |
| [TASK3_PROJECTS.md](TASK3_PROJECTS.md) | 边学边练：来源清单与样例、检索输入输出、压缩包要求、评分标准、跑通样例 | 做项目 / 反馈相关 |
| [DEPARTMENT_KNOWLEDGE.md](DEPARTMENT_KNOWLEDGE.md) | 院系-专业知识库：五层数据设计、检索别名与专业簇、接口与 MCP 工具表、留一验证结果、13 条已知边界 | 做画像 / 方向推荐 / 院系认知前读 |
| [curriculum_validation.md](curriculum_validation.md)、[curriculum_intros_review.md](curriculum_intros_review.md)、[curriculum_minor_review.md](curriculum_minor_review.md) | 知识库的留一验证报告、培养方案定位蒸馏抽检、辅修层抽检 | 改知识库抽取规则或重新跑数据前 |
| [paths/](paths/README.md) | 方向路径（当前只有数学、人工智能两条），含改树建议 | 做方向 / 路径相关 |

代码侧还有三个不看文档就看不出来的地方：

- `server/tests/`：417 个离线测试，覆盖记忆校验、两次调用契约、行动生命周期、
  画像隔离、SSE、任务归属、成绩单解析与绩点、渲染层结构契约，以及对话侧对院系-专业知识库的调用
  （`test_tools_curriculum.py`）。
- `tools/verify/`：验收脚本。4 个渲染层脚本（用真渲染函数跑，不需要浏览器）
  + `run_existing_tests.py`（测试入口，见下）+ `verify_guards_can_fail.py`
  （逐条回滚修复，证明守卫真的会红）+ 两个端到端探针。
- `eval/`：真实模型评测集（`dialogue_cases.json` + `run_eval.py`），跑法见 `DIALOGUE_CONTRACT.md` §11。

> **测试入口请用 `python tools/verify/run_existing_tests.py`**，
> 不要直接 `pytest server/tests`：后者在 Windows 上会因环境变量长度上限
> 报 2 个 `ValueError: the environment variable is longer than 32767 characters`
> （既有问题，与任务 2 无关）。

历史长文档（PRD / VISION / GAP_ANALYSIS 等 20 份）已于 2026-09-25 删除，且从未进入 git 历史；变更记录见 CHANGELOG。
