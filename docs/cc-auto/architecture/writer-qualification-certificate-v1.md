# Writer Qualification Certificate v1

> **Certificate schema**：`writer-qualification-certificate-v1`
> **Selection schema**：`writer-qualification-certificate-selection-v1`

## 1. 治理边界

`WriterQualificationBatch` 冻结一次考试的 evidence membership，
`WriterQualificationResultArtifact` 冻结该考试的客观结论，
`WriterQualificationCertificate` 则记录人工明确批准的 `QUALIFIED` Result。三者互不替代。

Certificate 是本地治理 artifact，不是 PKI 证书，不授予 workspace write permission，也不参与 Runtime
Routing。新 Batch 或 Result 的出现不会自动签发、撤销或替换 Certificate。

## 2. 签发与 Current Selection

签发必须显式指定 `profileId`、`batchId` 和 `resultId`，并重新校验 persisted Batch/Result binding、
`status = QUALIFIED`、当前 Qualification Identity、required Policy version 与 benchmark contract version。
`NOT_QUALIFIED`、`INSUFFICIENT_EVIDENCE`、identity/version mismatch 均 fail closed。

当前 Certificate 只来自：

```text
.cc-auto/qualification/writer/<profileId>/certificate-selection.json
```

查询不会扫描 Result，也不会选择 latest COMPLETE。每个 `WRITER + profileId` 最多一个 current ACTIVE
Certificate；已有 ACTIVE 时必须执行显式 replacement。

## 3. 不可变与撤销

签发文件位于：

```text
.cc-auto/qualification/writer/<profileId>/certificates/<certificateId>.json
```

签发后不可覆盖。撤销或替换只向 selection artifact 的治理历史追加事件，并原子更新 active pointer；旧
`certificate.json` 和 Frozen Result 均不修改。查询具体证书时从历史确定性派生 `REVOKED`。

## 4. Applicability

Applicability 每次重新读取 Frozen Result/Batch，并比较 current resolved Qualification Identity。只有以下条件
全部成立才返回 `ACTIVE_VALID`：

- Certificate 未撤销；
- Result 存在、binding 完整且仍为 `QUALIFIED`；
- Certificate 的 Policy 和 benchmark contract 与当前 required version 相同；
- current identity fingerprint 与 Certificate 完全相同。

凭证值不属于 identity，因此 API key value rotation 不使 Certificate 失效。model、endpoint、Tool Schema、
Writer system contract、inference settings 或 qualification contract 的实质变化会使旧 Certificate 不再
applicable，但不会篡改历史 artifact。
