# OfferFlow v0.8 PRD—Implementation Traceability

> **矩阵版本：** 1.0  
> **对应 PRD：** v2.1  
> **状态：** 文档基线完成，实施状态全部为 Not Started

---

## 1. 用户结果追踪

| ID | 用户结果 | PRD | Technical Design | Evaluation | 波次 | 实施状态 | 验收证据 |
|---|---|---|---|---|---|---|---|
| RC-01 | BOSS 当前页采集 | 6.1 P0-01 / US-01 | 6.1 / 11.1 | 2.2 / 9 | V8-2 | Not Started | 真实页截图、preview payload |
| RC-02 | 通用可见文本降级 | 6.1 P0-02 / US-01 | 6.2 | 2.2 / 4 | V8-2 | Not Started | 非 BOSS 页面截图、未知字段验证 |
| RC-03 | 文本与标准 JSON | 6.1 P0-03 / US-02 | 4.1 / 6.3 | 2.3 / 9 | V8-2 | Not Started | 文本、单 JSON、小数组验收 |
| RC-04 | 不可变 Snapshot/Version | 4.3–4.5 / P0-04/05 | 3 / 4.2 / 4.5 | 5.1 | V8-1/2 | Not Started | DB 行、版本历史、无 UPDATE 证据 |
| RC-05 | 重复与变化 | P0-06 / US-03 | 5 | 5.1 | V8-3 | Not Started | fixture、Diff 截图、hash 结果 |
| RC-06 | 透明规则 | P0-07 / US-04 | 4.7 | 3 / 4 | V8-3 | Not Started | 命中原文、覆盖动作截图 |
| RC-07 | 可解释单岗位分析 | P0-08 / US-05 | 4.9 / 7 / 8 | 4 / 5.2 | V8-4 | Not Started | Payload、Envelope、证据引用 |
| RC-08 | 0～8 条推荐 | P0-09 / US-06 | 4.10 / 13.3 | 7 | V8-5 | Not Started | 正常批次与空推荐截图 |
| RC-09 | 误区或证据不足 | 4.8 / 11.3 / US-07 | 9 | 5.4 / 7 | V8-5 | Not Started | formed/insufficient 两类样本 |
| RC-10 | RadarAction | P0-10 / US-08 | 4.11 / 12 | 5.5 | V8-5 | Not Started | 动作流水、撤销、投影 |
| RC-11 | RadarPromotion | P0-11 / US-09 | 4.12 / 13.4 | 8 | V8-6 | Not Started | 晋升预览、幂等、反向追踪 |
| RC-12 | 可靠任务与发布闭环 | P0-12 / US-10 / 12.2 | 4.8 / 10 | 6 / 9 | V8-4/6 | Not Started | 故障日志、migration、恢复、截图 |

---

## 2. 红队问题追踪

| ID | 问题 | 最终裁决 | 落地位置 | 状态 |
|---|---|---|---|---|
| RT-01 | 缺少不可变 RadarCandidateVersion | 新增独立版本实体 | TD 4.5 | Resolved in Docs |
| RT-02 | radar_application_marks 影子 Application | 完全删除，改 Action | TD 4.11 | Resolved in Docs |
| RT-03 | Candidate 状态混合 | 仅 active/merged/archived | PRD 4.4 / TD 4.4 | Resolved in Docs |
| RT-04 | AI 返回内部 ID | Envelope/Payload 分离 | PRD 4.10 / TD 4.9 | Resolved in Docs |
| RT-05 | 输入准备度缺失 | 必需/可选/降级规则 | PRD 5 / TD 7 | Resolved in Docs |
| RT-06 | stale 缺失 | 确定性派生 reasons | PRD 4.11 / TD 8 | Resolved in Docs |
| RT-07 | 浏览器适配过载 | BOSS + 通用降级；猎聘 P1 | PRD 6 | Resolved in Docs |
| RT-08 | 误区必出矛盾 | 诊断结果必出，误区有证据门 | PRD 4.8 / 11 | Resolved in Docs |
| RT-09 | 断点续跑伪承诺 | 记录恢复 + 固定输入重试 | PRD 9.7 / TD 10 | Resolved in Docs |
| RT-10 | 文档混杂 | 拆分七份文档 | PRD 0.2 | Resolved in Docs |
| RT-11 | 非目标城市未定义 | 全局画像、cityCode=null | PRD 5.2 | Resolved in Docs |
| RT-12 | JSON 批次过度设计 | 保留标准输入，删除长期批次领域 | PRD P0-03 / TD 4.1 | Resolved in Docs |

---

## 3. 明确删除或后移

| 项目 | 决定 | 目标版本/位置 |
|---|---|---|
| 猎聘专用字段适配 | 后移 | P1 |
| `/radar/imports` | 删除 | 不实现 |
| `radar_import_batches` | 删除 | 不实现 |
| `radar_application_marks` | 删除 | 不实现 |
| Candidate ignored/promoted 状态 | 删除 | Action/Promotion 派生 |
| AI 内部 ID 输出 | 删除 | 服务端 Envelope |
| 真正断点续跑承诺 | 删除 | 固定输入重试 |
| DeepSeek SSE 产品绑定 | 删除 | 技术实现自行选择 |
| 完整 SourceConfig/SourceRun | 后移 | v0.9 |
| 自动反馈画像进化 | 后移 | v0.9 |

---

## 4. 用户可见截图清单

- [ ] BOSS 扩展采集成功
- [ ] 通用可见文本降级预览
- [ ] 文本/JSON 导入预览
- [ ] CandidateVersion 历史与 Diff
- [ ] 数据质量与未知字段
- [ ] 透明规则命中原文
- [ ] 用户规则覆盖与撤销
- [ ] 单岗位分析四档建议
- [ ] stale 分析提示
- [ ] 0～8 条推荐
- [ ] 空推荐
- [ ] 正式误区诊断
- [ ] 证据不足诊断
- [ ] 收藏/忽略/重点/已投递
- [ ] 无回复不创建 Application
- [ ] 晋升预览与正式关联
- [ ] 任务失败、重试和刷新恢复

---

## 5. 发布授权追踪

| 动作 | 当前授权 |
|---|---|
| 冻结 PRD v2.1 | 未授权 |
| 开始 V8-1 实施 | 未授权 |
| 合并 main | 未授权 |
| 推送 main | 未授权 |
| Tag | 未授权 |
| Release | 未授权 |
