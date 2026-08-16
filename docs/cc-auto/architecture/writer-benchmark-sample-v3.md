# Writer Benchmark Sample v3 Identity Snapshot

> **Sample schema**：`writer-model-profile-benchmark-sample-v3`
>
> **Benchmark contract**：`writer-model-profile-benchmark-v3`
>
> **Qualification identity schema**：`writer-qualification-identity-snapshot-v1`
>
> **Qualification Policy**：`writer-qualification-policy-v1`（规则未修改）

## 1. 目标与边界

Sample v3 在 benchmark invocation 创建后、Provider call 之前冻结完整 Qualification Identity。
Evaluator 只能读取并校验已持久化 snapshot，不能读取当前配置补写历史字段。

本变更不重新采样 Provider，不产生新的 capability evidence，不接 Runtime Routing，不修改
`WriterAssignment`、Writer prompt、fixture、token limit 或 Qualification Policy v1 gate。

## 2. Sample v3 结构

```text
schemaVersion = writer-model-profile-benchmark-sample-v3
benchmarkSampleId
fixtureId
fixtureVersion
profileId
providerIdentifier                 # 只用于审计，不参与 pass/fail
qualificationIdentity:
  identitySchemaVersion
  benchmarkContractVersion
  profileId
  modelIdentifier
  fixtureSet[]                     # SEARCH / READ / WRITE 的 id + version
  providerProfileFingerprint
  toolSchemaAdapterContractFingerprint
  writerSystemContractFingerprint
  inferenceSettingsFingerprint
  qualificationPolicyVersion
  qualificationIdentityFingerprint
...既有安全审计字段
```

`benchmarkSampleId` 和当前 sample 的 `fixtureId / fixtureVersion` 是单样本事实，不放入完整
Qualification Identity fingerprint；否则同一封闭 evidence batch 中的每条样本都会得到不同身份。
完整 fingerprint 绑定整个 `fixtureSet`，因此三个 fixture 可以共享同一身份，同时任一 fixture version
变化都会使身份失效。

## 3. Fingerprint 输入

### 3.1 Provider Profile

参与：

- `transport`；
- 不含 username、password、query、hash 的 endpoint semantics（protocol、host、port、path）；
- `credentialEnvVars` 名称集合；
- `runtimeEnvAllowlist` 名称集合；
- `staticEnv` 的变量名集合，不包含值；
- 实际选中 Model Identity 的 `requestedModelId`；
- 对应 `acceptedReportedModelIds`。

不参与：

- Provider / Model display name；
- `vendor` 品牌；
- pricing、价格来源和更新时间；
- API key、credential、Authorization、token、secret；
- `process.env` 或 `staticEnv` 的任何值；
- 未实际选中的 model；
- transient runtime state。

当前 benchmark 调用前可以确定 `executeProviderCall` 实际发送的 `requestedModelId`，所以
`modelIdentifier` 使用该值，而不是 `profileId`、logical name 或事后猜测。

### 3.2 Tool Schema / Adapter Contract

参与：

- 模型实际看到的 tool 顺序、name、description、parameter schema；
- `toolMode`；
- Adapter ID；
- Adapter contract version；
- tool-call translation version。

Adapter metadata 是 Provider-neutral 的显式版本契约。未来 Provider 只需通过同一
`ProviderAdapterQualificationContract` 提供 metadata，不在 identity builder 中增加品牌分支。

### 3.3 Writer System Contract

只 fingerprint 每个 invocation 都真实发送、且不含 fixture observation 的稳定
`BENCHMARK_SYSTEM_CONTRACT`。Fixture 专属 instructions 和 observation 由版本化 fixture identity 管理；
sample ID、时间戳、运行路径和 task observation 不进入 Writer system identity。

### 3.4 Inference Settings

当前真实可控且会影响模型行为的参数只有 `maxOutputTokens`，因此 v3 只 fingerprint 该字段。
`timeoutMs` 属于 operational availability，不进入 capability identity；项目尚未控制 temperature、top_p、
reasoning effort 或 parallel tool-call policy，因此不为未来字段预造 schema。

### 3.5 完整 Qualification Identity

完整 fingerprint 由以下字段确定：

- benchmark contract version；
- profile ID；
- model identifier；
- 完整 fixture set；
- Provider Profile fingerprint；
- Tool Schema / Adapter Contract fingerprint；
- Writer System Contract fingerprint；
- Inference Settings fingerprint；
- Qualification Policy version。

Policy version 参与完整 identity。Policy 变化只使旧资格不能继承，不改写历史 sample，也不把旧结果
改判为模型失败。

## 4. Canonicalization

所有 fingerprint 统一使用稳定 canonical JSON 后计算 SHA-256：

- object key 按字典序排序；
- array 默认保留顺序；语义为集合的字段在进入 canonicalizer 前去重排序；
- object 中的 `undefined` 省略；
- array 中的 `undefined` 转成 `null`；
- `null` 显式保留；
- 非有限数字和不支持的值直接失败；
- 不读取文件路径、平台路径分隔符、时间戳或 build metadata。

## 5. v2 Compatibility 与 Evaluator

v1 / v2 sample 继续可读，不迁移、不重写、不伪造 identity。它们只能用于历史行为与 operational
diagnosis，Evaluator 返回 `QUALIFICATION_IDENTITY_INCOMPLETE` 和 `INSUFFICIENT_EVIDENCE`。

Evaluator 对 v3：

1. 重新计算并校验每个 snapshot 的完整 fingerprint；
2. 校验 sample 的 profile、fixture ID / version 确实属于 snapshot；
3. 拒绝混合 legacy + v3、不同 identity fingerprint 或损坏 snapshot；
4. 只在 identity 完整一致后应用原有 minimum evidence、fixture gate、protocol attribution 和 safety veto。

Evaluator 不再接受调用方提供的当前 identity 来补全历史 sample。

## 6. Secret Safety

Identity builder 不接收 `parentEnv`，Adapter contract resolver 也不接收 credential value。API key rotation
不改变 identity。带 username、password、query 或 hash 的 endpoint 在 canonicalization 前 fail-closed，
错误信息不回显原值。持久化仍经过既有 `redactForDisk` 二次防护。
