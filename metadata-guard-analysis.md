# 外部身份连接器元数据校验链路分析

## 1. `connectorMetadataGuard` 对未知字段的实际处理逻辑

### 1.1 Zod 默认行为与 `.merge()` 的继承关系

`connectorMetadataGuard` 的定义位于 `packages/toolkit/connector-kit/src/types/metadata.ts:76-95`：

```typescript
export const connectorMetadataGuard = z
  .object({
    id: z.string(),
    target: z.string(),
    name: i18nPhrasesGuard,
    description: i18nPhrasesGuard,
    logo: z.string(),
    logoDark: z.string().nullable(),
    readme: z.string(),
    configTemplate: z.string().optional(),
    formItems: connectorConfigFormItemGuard.array().optional(),
    customData: z.record(z.unknown()).optional(),
    fromEmail: z.string().optional(),
  })
  .merge(socialConnectorMetadataGuard) satisfies ToZodObject<ConnectorMetadata>;
```

**关键特性**：
- 未调用 `.strict()`、`.passthrough()` 或 `.strip()` 中的任何一个
- 使用 `.merge()` 合并 `socialConnectorMetadataGuard`
- 在 Zod v3 中，`z.object()` 的**默认行为是 strip（移除未知字段）**

### 1.2 `.catchall()` 移除前后的行为差异

根据 `packages/toolkit/connector-kit/CHANGELOG.md:191-195`，v4.0.0 的 major change：

```
remove `.catchall()` for `connectorMetadataGuard`

`.catchall()` allows unknown keys to be parsed as metadata. This is troublesome when we want to strip out unknown keys (Zod provides `.strip()` for this purpose but somehow it doesn't work with `.catchall()`).

For data extensibility, we added `customData` field to `ConnectorMetadata` type to store unknown keys. For example, the `fromEmail` field in `connector-logto-email` is not part of the standard metadata, so it should be stored in `customData` in the future.
```

**移除前（带 `.catchall(z.unknown())`）**：
- 行为模式：`passthrough` 模式的变种
- 未知字段会被保留在解析结果中，类型推断为 `unknown`
- `.strip()` 调用无效（与 `.catchall()` 冲突）
- 所有顶级未知字段都会成为元数据的一部分

**移除后（当前状态）**：
- 行为模式：**默认 strip 模式**
- 未知字段会被静默移除，不保留在解析结果中
- 只有在 `customData` 字段内的内容才会被保留
- `.strip()` 可以正常工作

### 1.3 移除 `.catchall()` 后的行为范围

| 场景 | 行为 |
|-----|------|
| `parse()` 调用 | 未知字段被静默移除，不报错 |
| `safeParse()` 调用 | success=true，未知字段被移除 |
| `.strict().parse()` 调用 | 遇到未知字段抛出 ZodError |
| `.passthrough().parse()` 调用 | 未知字段被保留 |
| `.strip().parse()` 调用 | 未知字段被移除（与默认行为一致） |
| 嵌套对象中的未知字段 | 遵循各自子 schema 的设置 |

**重要限制**：移除 `.catchall()` 只影响 `connectorMetadataGuard` 本身，不影响通过 `.merge()` 或 `.extend()` 派生的其他 Guard 的未知字段处理策略。

---

## 2. 三种结果的具体触发条件

### 2.1 结果一：字段被移除（Silently Stripped）

**触发条件**：
1. 字段不存在于 `connectorMetadataGuard` 定义的白名单中
2. 字段不是 `socialConnectorMetadataGuard` 定义的字段
3. 使用默认的 `parse()` / `safeParse()` 调用（未加 `.strict()` / `.passthrough()`）

**白名单字段清单**：

| 来源 | 字段 |
|-----|------|
| 基础 object | `id`, `target`, `name`, `description`, `logo`, `logoDark`, `readme`, `configTemplate`, `formItems`, `customData`, `fromEmail` |
| social merge | `platform`, `isStandard`, `isTokenStorageSupported` |

**示例**：

```typescript
const input = {
  id: 'connector-google',
  target: 'google',
  name: { en: 'Google' },
  description: { en: 'Google social connector' },
  logo: 'logo.svg',
  logoDark: null,
  readme: 'README.md',
  platform: 'Web',
  // 未知字段 —— 会被移除
  unknownField: 'value',
  fromName: 'Logto Team',  // 未知字段 —— 会被移除
  extraConfig: { foo: 1 }, // 未知字段 —— 会被移除
};

const result = connectorMetadataGuard.parse(input);
// result 中不包含 unknownField, fromName, extraConfig
// Object.keys(result) 仅包含白名单字段
```

**发生位置**：
- `connectorResponseGuard`（`packages/schemas/src/types/connector.ts:18`）- `.merge(connectorMetadataGuard)` 继承 strip 行为
- `connectorFactoryResponseGuard`（`packages/schemas/src/types/connector.ts:35`）- 同上
- `fullSignInExperienceGuard`（`packages/schemas/src/types/sign-in-experience.ts:60`）- `connectorMetadataGuard.omit({...})` 继承 strip 行为

### 2.2 结果二：校验失败报错（Validation Error）

**触发条件**：
1. 显式调用 `.strict()` 后遇到未知字段
2. 已知字段的值类型不匹配 schema 定义
3. 必填字段缺失

**示例 - 类型不匹配**：
```typescript
connectorMetadataGuard.parse({
  id: 'test',
  target: 'google',
  name: { en: 'Google' },
  description: { en: 'Desc' },
  logo: 'logo.svg',
  logoDark: null,
  readme: 'README.md',
  platform: 'InvalidPlatform', // 不是 ConnectorPlatform 枚举值 —— 报错
});
// ZodError: Invalid enum value
```

**示例 - 显式 strict 模式**：
```typescript
connectorMetadataGuard.strict().parse({
  id: 'test',
  target: 'google',
  name: { en: 'Google' },
  description: { en: 'Desc' },
  logo: 'logo.svg',
  logoDark: null,
  readme: 'README.md',
  platform: 'Web',
  unknownField: 'value', // strict 模式下 —— 报错
});
// ZodError: Unrecognized key(s) in object: 'unknownField'
```

**发生位置**：
- 代码中没有显式调用 `.strict()` 的位置
- 仅在类型不匹配或必填字段缺失时自然触发报错

### 2.3 结果三：进入 `customData` 的扩展字段

**触发条件**：
1. 字段被显式嵌套在 `customData` 对象内
2. 或通过业务逻辑显式将字段值写入 `customData`

**设计意图**（来自 CHANGELOG）：
```
For data extensibility, we added `customData` field to `ConnectorMetadata` type to store unknown keys. For example, the `fromEmail` field in `connector-logto-email` is not part of the standard metadata, so it should be stored in `customData` in the future.
```

**示例**：
```typescript
const input = {
  id: 'connector-logto-email',
  target: 'email',
  name: { en: 'Logto Email' },
  description: { en: 'Logto email connector' },
  logo: 'logo.svg',
  logoDark: null,
  readme: 'README.md',
  // 标准字段 —— 保留
  fromEmail: 'no-reply@logto.io',
  // 扩展字段放入 customData —— 保留
  customData: {
    fromName: 'Logto Team',
    enableReplyTo: true,
    smtpConfig: {
      host: 'smtp.example.com',
      port: 587,
    },
  },
};

const result = connectorMetadataGuard.parse(input);
// result.customData = { fromName: 'Logto Team', enableReplyTo: true, smtpConfig: {...} }
// 所有 customData 内的字段完整保留
```

**重要说明**：
- `fromEmail` 目前仍在白名单中（但已标记 `@deprecated Use customData instead`）
- 没有自动迁移逻辑 —— 连接器开发者需要手动将扩展字段放入 `customData`
- `customData` 的 schema 是 `z.record(z.unknown()).optional()`，内部不做任何校验

---

## 3. `configurableConnectorMetadataGuard` 的特殊处理

### 3.1 定义与用途

`packages/toolkit/connector-kit/src/types/metadata.ts:98-105`：

```typescript
export const configurableConnectorMetadataGuard = connectorMetadataGuard
  .pick({
    target: true,
    name: true,
    logo: true,
    logoDark: true,
  })
  .partial();
```

**用途**：定义存储在数据库 `connectors` 表 `metadata` 字段中的可配置字段白名单。

### 3.2 行为特性

| 特性 | 说明 |
|-----|------|
| 字段来源 | 通过 `.pick()` 从 `connectorMetadataGuard` 提取，继承其行为 |
| 可选性 | `.partial()` 使所有字段可选 |
| 未知字段处理 | 继承 strip 行为 —— 数据库中存储的额外字段会被移除 |
| 允许的字段 | `target`, `name`, `logo`, `logoDark` |

### 3.3 触发位置

`configurableConnectorMetadataGuard` 主要在 API 路由中使用：
- `POST /connectors` 创建连接器时验证 metadata 输入
- `PATCH /connectors/:id` 更新连接器时验证 metadata 更新
- 确保用户只能修改白名单内的字段

### 3.4 与 `connectorMetadataGuard` 的行为差异

| 场景 | `connectorMetadataGuard` | `configurableConnectorMetadataGuard` |
|-----|-------------------------|-------------------------------------|
| 必填字段 | `id`, `target`, `name`, `description`, `logo`, `logoDark`, `readme`, `platform` | 无（全部 optional） |
| 可写入 metadata 字段 | 白名单字段（共14个） | 仅 `target`, `name`, `logo`, `logoDark` |
| 移除 `.catchall()` 影响 | 所有未知字段被移除 | 所有非4白名单字段被移除 |

---

## 4. 关键位置索引与行为汇总

### 4.1 `connectorMetadataGuard` 衍生的 Schema

| 派生 Schema | 文件 | 操作 | 未知字段行为 |
|------------|------|------|-------------|
| `connectorResponseGuard` | `packages/schemas/src/types/connector.ts:18` | `.merge(connectorMetadataGuard)` | strip（继承） |
| `connectorFactoryResponseGuard` | `packages/schemas/src/types/connector.ts:35` | `.merge(connectorMetadataGuard)` | strip（继承） |
| `fullSignInExperienceGuard.socialConnectors` | `packages/schemas/src/types/sign-in-experience.ts:60` | `.omit({ description, configTemplate, formItems, readme, customData })` | strip（继承，且 customData 被显式 omit） |
| `configurableConnectorMetadataGuard` | `packages/toolkit/connector-kit/src/types/metadata.ts:98` | `.pick({ target, name, logo, logoDark }).partial()` | strip（继承） |

### 4.2 行为决策树

```
输入包含未知字段
    │
    ├─▶ 字段在 customData 内吗？
    │    ├─ 是 ──▶ 保留（Result 3: 进入 customData）
    │    └─ 否 ──▶ 检查是否调用了 .strict()
    │                      ├─ 是 ──▶ ZodError（Result 2: 校验失败报错）
    │                      └─ 否 ──▶ 检查是否调用了 .passthrough()
    │                                        ├─ 是 ──▶ 保留（Result 2 变种）
    │                                        └─ 否 ──▶ 移除（Result 1: 字段被移除）
    │
    └─▶ 字段在白名单内吗？
         ├─ 是 ──▶ 按类型验证 ──▶ 类型正确 ──▶ 保留
         │                      └─ 类型错误 ──▶ ZodError（Result 2: 校验失败报错）
         └─ 否 ──▶ 同上逻辑
```

### 4.3 版本迁移影响

| 版本 | 行为 | 迁移影响 |
|-----|------|---------|
| < 4.0.0 | `.catchall()` 保留所有未知字段 | 连接器可以通过在顶级声明自定义字段来传递配置 |
| >= 4.0.0 | 默认 strip 模式 | 现有依赖顶级未知字段的连接器需要将自定义字段移入 `customData`，否则这些字段会被静默丢弃 |

**迁移风险**：
- 如果连接器开发者没有注意到这个 breaking change，其自定义字段会被静默移除
- 没有警告或报错，调试困难
- `fromEmail` 作为过渡方案暂时保留在白名单中（已标记 deprecated）

---

## 5. 代码位置索引

| 定义 | 文件路径 | 行号 |
|-----|---------|------|
| `connectorMetadataGuard` 定义 | `packages/toolkit/connector-kit/src/types/metadata.ts` | 76-95 |
| `configurableConnectorMetadataGuard` 定义 | `packages/toolkit/connector-kit/src/types/metadata.ts` | 98-105 |
| `.catchall()` 移除说明 | `packages/toolkit/connector-kit/CHANGELOG.md` | 191-195 |
| `connectorResponseGuard` | `packages/schemas/src/types/connector.ts` | 9-26 |
| `connectorFactoryResponseGuard` | `packages/schemas/src/types/connector.ts` | 30-35 |
| `fullSignInExperienceGuard` socialConnectors | `packages/schemas/src/types/sign-in-experience.ts` | 60-68 |
| `socialConnectorMetadataGuard` | `packages/toolkit/connector-kit/src/types/metadata.ts` | 53-59 |
