# OfferFlow 文档导航

本页是文档目录导航，不是第二份 PRD 或规则源。完整协作规则以 `AGENTS.md` 为准，`CLAUDE.md` 只是 Claude 的入口说明。

## 当前状态

- 当前版本：v0.8.0 GA（正式发布，2026-07-30）
- 生产 schema：v8（migration 1..8）
- Radar / Analysis 正式入口：随 v0.8.0 发布但默认关闭，按开关启用
- 发布判定：GA —— 负责人批准发布；部分原前置项（RC-09、RC-12、30 条评测、截图与文案验收）未完成，经负责人明确豁免、转入 v0.9
- 正式发布说明：[release/v0.8.0.md](release/v0.8.0.md)（含 §0 发布决策与风险接受）
- 历史版本目录（`docs/v0.1/` ～ `docs/v0.5/`、`docs/architecture/`、`docs/release/` 等）只记录当年的产品和技术状态，不代表当前产品边界

## 目录结构

```text
docs/
├─ prd/          当前产品需求（PRD）
├─ product/      Release Contract 与 Traceability
├─ technical/    技术设计
├─ evaluation/   评测与验收计划
├─ security/     浏览器采集和外部输入安全
├─ runbooks/     migration、备份与恢复
├─ decisions/    评审仲裁与历史架构裁决
├─ operations/   历史发布与恢复演练记录
├─ handoffs/     历史阶段交接记录
├─ architecture/ 历史技术设计（v0.7 及更早）
├─ release/      历史版本说明
├─ interview/    面试叙事与简历素材
└─ v0.1/ ~ v0.5/ 历史版本文档
```

## v0.8 权威文档

- [prd/offerflow-v0.8.md](prd/offerflow-v0.8.md)
- [product/offerflow-v0.8-release-contract.md](product/offerflow-v0.8-release-contract.md)
- [product/offerflow-v0.8-traceability.md](product/offerflow-v0.8-traceability.md)
- [technical/offerflow-v0.8-technical-design.md](technical/offerflow-v0.8-technical-design.md)
- [evaluation/offerflow-v0.8-evaluation-plan.md](evaluation/offerflow-v0.8-evaluation-plan.md)
- [security/browser-capture-security.md](security/browser-capture-security.md)
- [runbooks/offerflow-v0.8-migration-recovery.md](runbooks/offerflow-v0.8-migration-recovery.md)
- [decisions/offerflow-v0.8-gemini-review-arbitration.md](decisions/offerflow-v0.8-gemini-review-arbitration.md)

`decisions/offerflow-v0.8-gemini-review-arbitration.md` 只用于理解或挑战既有架构裁决历史，不是日常实施必读。

## 如何读取

实施任务应按任务类型读取对应文档，不要无差别加载全部资料。具体的必读顺序、按任务追加读取规则和权威顺序仲裁，以 `AGENTS.md` 为准。

## 旧链路文档

- [llm-eval.md](llm-eval.md) 记录既有 `OFFER_FLOW_JSON` / Prompt / Parser / Eval 链路，与 v0.8 的 `JobMatchAiPayload` + Analysis Envelope 是不同契约，不得混用。
- [demo-ai-workflow.md](demo-ai-workflow.md)、[ai-workflow-evidence.md](ai-workflow-evidence.md) 记录 v0.7 及更早版本已实现的 AI Workflow 能力，不包含尚未实施的 v0.8 岗位雷达能力。
