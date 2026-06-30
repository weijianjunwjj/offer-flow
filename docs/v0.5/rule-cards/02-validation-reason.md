# 规则卡 02：表单校验 reason

来源项目：

```txt
D:\VSCode\activity-config-miniapp
```

参考文件：

```txt
server/src/common/schema-validator.ts
server/src/common/schema-validator.spec.ts
server/src/application/application.service.ts
```

## 一句话说明

活动报名表单由 schema 动态生成，但服务端不能相信前端，必须按当前 schema 做二次校验，并返回稳定的低基数 reason。

## 人类规则卡

| 情况 | 输入 | 期望结果 | reason |
|---|---|---|---|
| A | 必填字段为空 | 校验失败，返回字段 key | `missing_required` |
| B | `input` / `textarea` 传入非字符串 | 校验失败，返回字段 key | `invalid_type` |
| C | `phone` 不是合法手机号 | 校验失败，返回字段 key | `invalid_type` |
| D | `select` 传入不在 options 内的值 | 校验失败，返回字段 key | `invalid_option` |
| E | 非必填字段为空 | 校验通过，不做类型校验 | 无 |
| F | 表单里有 schema 外的多余字段 | 写库前丢弃 | 无 |

## AI 执行规格

```txt
规则名：动态表单服务端校验

输入：
- fields: ActivityField[]
- formData: Record<string, unknown>

处理：
1. 按 fields 顺序逐个校验字段。
2. required 字段为空，返回 missing_required + fieldKey。
3. 非 required 字段为空，跳过后续类型校验。
4. input / textarea 只接受 string。
5. phone 只接受符合 /^1[3-9]\d{9}$/ 的 string，保存前 trim。
6. select 只接受 string，且值必须存在于 options。
7. 写入 formDataJson 前，只保留 schema 中声明的字段。

必须满足：
- 校验失败永远返回低基数 reason。
- fieldKey 可以返回给前端展示，但不能作为漏斗分组 reason。
- 合法输入不应被误拒。

禁止：
- 禁止新增动态 reason，例如“手机号格式错误：138xxx”。
- 禁止把用户输入拼进 reason。
- 禁止跳过服务端二次校验。
```

## 适合 Spec Guard 的原因

它天然就是 A/B/C 情况表：字段类型有限，失败原因有限，测试可以覆盖每个分支。用户只需要确认“这些情况该不该失败”。
