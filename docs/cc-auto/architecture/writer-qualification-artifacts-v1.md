# Writer Qualification Frozen Artifacts v1

> **Batch schema**：`writer-qualification-batch-v1`
> **Result schema**：`writer-qualification-result-v1`
> **Policy**：`writer-qualification-policy-v1`（能力规则未修改）

## 1. 目的

正式 Writer Qualification 不能长期依赖“同 identity 下最新 3 条 capability samples”。未来 smoke、
diagnostic 或 recheck 会改变 latest window，使已经完成的考试发生隐式漂移。

本治理层把两件事分开：

1. `WriterQualificationBatch` 显式冻结一次考试的 sample membership；
2. `WriterQualificationResultArtifact` 冻结只基于该 membership 得出的正式结论。

历史 smoke 和 lifetime operational evidence 保持原样，不回写、不迁移，也不进入未引用它们的 Formal
Batch。Runtime routing 与 Writer authorization 不消费这些 artifact。

## 2. Batch Contract

`WriterQualificationBatch` 保存：

- `batchId`、`profileId`、开始/完成时间和 `COMPLETE | ABORTED`；
- qualification identity fingerprint、Policy version、benchmark contract version；
- SEARCH / READ / WRITE 各自显式的 `formalSampleIds`；
- Policy 期望 coverage 与从选定 evidence 确定性计算的实际 coverage。

Batch 不通过目录时间顺序推断成员。`COMPLETE` batch 必须满足 Policy v1 每 fixture 恰好 3 条 evaluable
capability evidence；重复 ID、缺失 sample、跨 identity、profile/policy/benchmark/fixture 不匹配均 fail
closed。`ABORTED` batch 可以保留不完整 membership，但不能生成正式 Result。

Provider-unavailable attempt 可以属于 Batch operational evidence，但不进入 capability coverage。只要同一
fixture 仍显式包含恰好 3 条 capability samples，Policy gate 保持原语义。

## 3. Result Artifact

`WriterQualificationResultArtifact` 保存：

- 确定性 `resultId`、`batchId`、identity、Policy 和 benchmark contract；
- `QUALIFIED | NOT_QUALIFIED | INSUFFICIENT_EVIDENCE` 与正式 `reasonCodes`；
- 三个 fixture 的 formal/capability/strict/redundant/negative/unavailable sample IDs 和 gate；
- premature-write safety 结果；
- 仅属于该 Batch 的 availability、transport retry/recovery、failure category 和总成本摘要；
- `evaluatedAt`。

Result 不保存 prompt、tool arguments、文件内容、原始模型输出、凭证或 Authorization。落盘使用既有
redaction 与原子 rename，并拒绝覆盖已有 `batch.json` 或 `result.json`。

## 4. Evidence Selection 与 Policy 复用

Formal evaluation 的顺序固定为：

1. 按 Batch 中的 sample IDs 从 sample pool 精确选择 evidence；
2. 验证 schema v3、identity fingerprint、profile、Policy、benchmark contract 和 fixture binding；
3. 调用既有 `evaluateWriterProfileQualification`；
4. 验证 evaluator 实际 coverage 与 Batch 声明一致；
5. 生成不可覆盖 Result artifact。

Policy v1 的 minimum evidence、fixture gate、safety veto 和 protocol attribution 没有复制或修改。新增未来
sample 不在 Batch membership 中，因此不会改变旧 Result。相同 identity 的 requalification 必须创建新
Batch；旧 Batch 与 Result 永久保留。

## 5. Persistence

Artifact 位于 ignored runtime evidence：

```text
.cc-auto/qualification/writer/<profileId>/<batchId>/batch.json
.cc-auto/qualification/writer/<profileId>/<batchId>/result.json
```

真实 benchmark v3 sample 继续位于原目录且保持不可变。Artifact 不提交 Git，也不自动启用 runtime
routing、WriterAssignment、RunLease 或 workspace write permission。
