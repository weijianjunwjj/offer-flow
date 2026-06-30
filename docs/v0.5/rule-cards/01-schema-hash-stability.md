# 规则卡 01：schemaHash 稳定性

来源项目：

```txt
D:\VSCode\activity-config-miniapp
```

参考文件：

```txt
server/src/common/schema-hash.ts
server/src/common/schema-hash.spec.ts
docs/schema.md
```

## 一句话说明

活动字段配置会频繁变化，`schemaHash` 用来标识“这一版字段配置是谁”。它必须稳定，否则历史报名记录会分组错乱。

## 人类规则卡

| 情况 | 输入变化 | 期望结果 | 原因 |
|---|---|---|---|
| A | 字段对象里的 key 顺序变化 | `schemaHash` 不变 | 同一语义不应因为书写顺序不同变成两版 schema |
| B | `fields` 数组顺序变化 | `schemaHash` 改变 | 字段顺序影响表单展示和历史解释 |
| C | `select.options` 顺序变化 | `schemaHash` 改变 | 选项顺序也是用户看到的语义 |
| D | 字段里出现 `undefined` / `null` | 计算 hash 时忽略 | 避免无意义空值污染 schema identity |

## AI 执行规格

```txt
规则名：schemaHash 稳定性

输入：
- fields: ActivityField[]

处理：
1. fields 数组保持原顺序，不排序。
2. 每个 field 对象内部 key 按字典序排序。
3. field.options 如果存在，保持原顺序。
4. undefined 和 null 字段不参与 hash。
5. 对规范化结果计算 sha256，并截取前 16 位。

必须满足：
- 字段对象 key 顺序不同，hash 不变。
- fields 顺序不同，hash 改变。
- options 顺序不同，hash 改变。
- undefined / null 不影响 hash。

禁止：
- 禁止直接把原始 JSON.stringify(fields) 喂给 hash。
- 禁止排序 fields。
- 禁止排序 options。
```

## 适合 Spec Guard 的原因

这个规则一旦做错，后果不是页面小 bug，而是历史数据分组失真。它适合用测试和规则卡长期固定下来。
