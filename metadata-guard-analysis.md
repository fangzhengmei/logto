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

---

## 2. `.catchall()` 移除在 `configurableConnectorMetadataGuard` 上的继承关系

### 2.1 构造链路与 strip 行为继承

`configurableConnectorMetadataGuard` 的构造链：

```
connectorMetadataGuard (z.object + .merge, strip 模式)
  └── .pick({ target, name, logo, logoDark })
        └── .partial()
              → configurableConnectorMetadataGuard (strip 模式继承)
```

**关键推论**：

1. `.pick()` 返回一个新的 `ZodObject`，**继承原对象的 unknownKeys 策略**（即 strip）
2. `.partial()` 仅将所有字段设为 optional，**不改变 unknownKeys 策略**
3. 因此 `configurableConnectorMetadataGuard` 的 strip 行为**直接继承自 `connectorMetadataGuard`**，而非自行决定

**但存在一个重要的实际差异**：`configurableConnectorMetadataGuard` 只 pick 了 4 个字段，因此其"白名单"仅为 `{ target?, name?, logo?, logoDark? }`。即使 `connectorMetadataGuard` 的白名单有 14 个字段，经过 `.pick()` 后也只有 4 个字段能通过校验。

### 2.2 `.catchall()` 移除对两个 Guard 的影响对比

| 维度 | `connectorMetadataGuard` | `configurableConnectorMetadataGuard` |
|-----|-------------------------|-------------------------------------|
| 构造来源 | `z.object().merge()` | `connectorMetadataGuard.pick().partial()` |
| 白名单字段数 | 14 | 4 |
| strip 行为来源 | Zod 默认 | 从 `connectorMetadataGuard` 继承 |
| 移除 `.catchall()` 的影响 | 未知字段从保留变为移除 | **无独立影响** —— `.pick()` 已经排除了除 4 字段外的所有键，无论有无 `.catchall()`，结果都只有这 4 个字段 |

**核心结论**：`.catchall()` 的移除对 `configurableConnectorMetadataGuard` **没有实际影响**。`.pick()` 操作在 Zod 中是先于 catchall 执行的字段过滤，只保留声明的 4 个字段。移除 `.catchall()` 改变的是 `connectorMetadataGuard` 自身的未知字段处理策略，而 `.pick()` 后的派生 Guard 天然只包含 pick 的字段。

---

## 3. `configurableConnectorMetadataGuard` 在 schemas 与 connectors.sql 中的实际落点

### 3.1 代码生成链路：SQL → TypeScript → Zod Guard

整个链路由 `@logto/shared` 的代码生成器驱动：

```
connectors.sql
  └── metadata jsonb /* @use ConfigurableConnectorMetadata */
        └── @use 注解被 gen/utils.ts:210 解析为 tsType = 'ConfigurableConnectorMetadata'
              └── gen/schema.ts:80-83 生成 Zod Guard:
                    metadata: configurableConnectorMetadataGuard.optional()
                          ↑ camelcase('ConfigurableConnectorMetadata') + 'Guard'
              └── gen/index.ts:154-155 收集 tsType 并自动添加 import:
                    import { ConfigurableConnectorMetadata, configurableConnectorMetadataGuard }
                      from '../foundations/index.js'
```

**生成结果**（`Connectors.createGuard` 中的 metadata 字段）：

```typescript
// 自动生成的 Connectors.createGuard（由 pnpm build 生成）
const createGuard: Guard<CreateConnector> = z.object({
  id: z.string(),
  syncProfile: z.boolean(),
  enableTokenStorage: z.boolean(),
  connectorId: z.string(),
  config: jsonObjectGuard,
  metadata: configurableConnectorMetadataGuard,  // ← 这里
  tenantId: z.string().optional(),
  createdAt: z.date().optional(),
});
```

### 3.2 `connectors.sql` 中的元数据类型约束

`packages/schemas/tables/connectors.sql:1-15`：

```sql
create table connectors (
  tenant_id varchar(21) not null
    references tenants (id) on update cascade on delete cascade,
  id varchar(128) not null,
  sync_profile boolean not null default FALSE,
  enable_token_storage boolean not null default FALSE,
  connector_id varchar(128) not null,
  config jsonb /* @use JsonObject */ not null default '{}'::jsonb,
  metadata jsonb /* @use ConfigurableConnectorMetadata */ not null default '{}'::jsonb,
  created_at timestamptz not null default(now()),
  primary key (id)
);
```

**关键设计决策**：
- `metadata` 列类型为 `jsonb`，PostgreSQL 层面不限制内容结构
- `/* @use ConfigurableConnectorMetadata */` 注解是**唯一的类型约束来源**
- 默认值为 `'{}'::jsonb`（空对象），意味着创建连接器时 metadata 可以为空
- `config` 列使用 `/* @use JsonObject */`（无结构约束的通用 JSON 对象）

### 3.3 `ConfigurableConnectorMetadata` 的 re-export 路径

```
@logto/connector-kit
  └── configurableConnectorMetadataGuard + ConfigurableConnectorMetadata 类型
        └── @logto/schemas/src/foundations/jsonb-types/index.ts (re-export)
              └── @logto/schemas/src/foundations/index.ts (re-export)
                    └── 自动生成的 db-entries 代码 import 此路径
```

`packages/schemas/src/foundations/jsonb-types/index.ts:20-25`：

```typescript
export {
  configurableConnectorMetadataGuard,
  type ConfigurableConnectorMetadata,
  jsonGuard,
  jsonObjectGuard,
} from '@logto/connector-kit';
```

**注意**：`configurableConnectorMetadataGuard` 在整个代码库中**仅被两个位置引用**：
1. 定义处：`packages/toolkit/connector-kit/src/types/metadata.ts:98`
2. Re-export 处：`packages/schemas/src/foundations/jsonb-types/index.ts:21`

它**不直接**出现在 API 路由代码中。API 路由使用的是自动生成的 `Connectors.createGuard`，其中 metadata 字段通过代码生成链间接引用了 `configurableConnectorMetadataGuard`。

### 3.4 API 路由中的实际使用方式

`packages/core/src/routes/connector/index.ts`：

**创建连接器** (`POST /connectors`)：
```typescript
body: Connectors.createGuard
  .pick({
    config: true,
    connectorId: true,
    metadata: true,  // ← 类型为 configurableConnectorMetadataGuard
    syncProfile: true,
    enableTokenStorage: true,
  })
  .merge(Connectors.createGuard.pick({ id: true }).partial())
```

**更新连接器** (`PATCH /connectors/:id`)：
```typescript
body: Connectors.createGuard
  .pick({ config: true, metadata: true, syncProfile: true, enableTokenStorage: true })
  .partial()  // ← 所有字段可选，metadata 类型仍为 configurableConnectorMetadataGuard
```

**持久化方式**：
```typescript
// 创建时
await insertConnector({
  id: insertConnectorId,
  connectorId,
  ...cleanDeep({ syncProfile, config, metadata, enableTokenStorage }),
});

// 更新时
await updateConnector({
  set: {
    config: conditional(config && (cleanDeep(config) as JsonObject)),
    metadata: conditional(metadata && cleanDeep(metadata)),
    syncProfile,
    enableTokenStorage,
  },
  where: { id },
  jsonbMode: 'replace',  // ← 整体替换，非合并
});
```

---

## 4. `customData` 语义与管理 API metadata 白名单的持久化边界

### 4.1 两层元数据的架构

外部身份连接器的元数据实际上分为两个独立层：

| 层级 | 来源 | 存储 | Guard | 可写字段 |
|-----|------|------|-------|---------|
| **工厂元数据** | 连接器包代码声明 | 内存（`loadConnectorFactories` 缓存） | `connectorMetadataGuard` | 14 个白名单字段（含 `customData`） |
| **数据库元数据** | 管理 API 写入 | `connectors.metadata` (jsonb) | `configurableConnectorMetadataGuard` | 仅 `target`, `name`, `logo`, `logoDark` |

### 4.2 运行时合并策略

`packages/core/src/libraries/connector.ts:96-103`：

```typescript
const connector: AllConnector = {
  ...defaultConnectorMethods,
  ...rawConnector,
  metadata: {
    ...rawMetadata,      // 工厂元数据（14 字段完整）
    ...metadata,         // 数据库元数据（仅 4 字段，覆盖工厂值）
  },
};
```

**合并规则**：
- 数据库元数据**覆盖**工厂元数据的同名字段
- 仅 `target`, `name`, `logo`, `logoDark` 可以被覆盖
- 工厂元数据的其他字段（`id`, `description`, `readme`, `platform`, `isStandard`, `isTokenStorageSupported`, `customData` 等）**不可通过 API 修改**

### 4.3 `customData` 的持久化边界

**关键问题**：`customData` 在 `connectorMetadataGuard` 白名单中（工厂层），但**不在** `configurableConnectorMetadataGuard` 白名单中（数据库层）。

这意味着：

| 操作 | `customData` 行为 |
|-----|------------------|
| 连接器包声明 `customData` | ✅ 工厂元数据中保留，运行时可见 |
| 管理 API 写入 metadata 中的 `customData` | ❌ 被 `configurableConnectorMetadataGuard` strip 掉，**不会持久化** |
| `PATCH /connectors/:id` body 含 `{ metadata: { customData: {...} } }` | ❌ `configurableConnectorMetadataGuard` pick 了 4 个字段，`customData` 被移除 |
| `POST /connectors` body 含 `{ metadata: { customData: {...} } }` | ❌ 同上 |
| 数据库中手动写入 `customData` | ⚠️ 运行时合并时会被保留（覆盖工厂的 `customData`） |

**持久化边界图**：

```
连接器包 (代码)                     管理 API (运行时)
    │                                   │
    ▼                                   ▼
connectorMetadataGuard          configurableConnectorMetadataGuard
  ├─ id: string                   ├─ target?: string
  ├─ target: string               ├─ name?: I18nPhrases
  ├─ name: I18nPhrases            ├─ logo?: string
  ├─ description: I18nPhrases     └─ logoDark?: string | null
  ├─ logo: string
  ├─ logoDark: string | null      ← 仅此 4 字段可持久化到 DB
  ├─ readme: string
  ├─ configTemplate?: string
  ├─ formItems?: [...]                ╔═══════════════════════╗
  ├─ customData?: Record              ║ customData 不可通过    ║
  ├─ fromEmail?: string               ║ 管理 API 持久化       ║
  ├─ platform: ConnectorPlatform      ╚═══════════════════════╝
  ├─ isStandard?: boolean
  └─ isTokenStorageSupported?: boolean
         │                                   │
         ▼                                   ▼
    内存缓存（启动加载）              DB connectors.metadata
         │                                   │
         └───────── 合并 ────────────────────┘
                       │
                       ▼
              运行时 connector.metadata
              { ...rawMetadata, ...dbMetadata }
```

### 4.4 `jsonbMode: 'replace'` 的持久化语义

`packages/core/src/routes/connector/index.ts:348-363`：

```typescript
await updateConnector({
  set: {
    config: conditional(config && (cleanDeep(config) as JsonObject)),
    metadata: conditional(metadata && cleanDeep(metadata)),
    syncProfile,
    enableTokenStorage,
  },
  where: { id },
  jsonbMode: 'replace',  // 整体替换
});
```

**`replace` 模式的含义**：
- 当 `metadata` 字段存在于 `set` 中时，**整体替换** DB 中的 `metadata` jsonb 列
- 不是合并（merge），是覆盖（replace）
- 如果调用 `PATCH` 时只传了 `{ metadata: { target: 'new' } }`，则 DB 中 `metadata` 变为 `{ target: 'new' }`，之前存储的 `name`/`logo`/`logoDark` 会被清除

**对 customData 的影响**：
- 即使 DB 中之前存在 `customData`（通过非 API 方式写入），`PATCH` 更新 metadata 时也会被 `replace` 清除
- `cleanDeep(metadata)` 先移除 undefined 值，再整体写入
- `configurableConnectorMetadataGuard` 的 strip 行为在 `koaGuard` 中间件阶段就已经生效，传入 handler 的 `metadata` 已经是 strip 后的结果

### 4.5 持久化边界的实际影响

**场景 1：连接器包声明 `customData`**

```typescript
// 连接器包中声明的元数据
const metadata = {
  id: 'connector-email',
  target: 'email',
  // ...
  customData: { fromName: 'Logto', replyTo: 'support@logto.io' },
};

// 运行时读取：customData 来自工厂，始终存在
// 管理 API 更新 metadata 时：customData 不在 configurable 白名单中，无法修改
// DB 中不存储 customData，每次从工厂加载
```

**场景 2：尝试通过 API 写入 `customData`**

```typescript
// PATCH /connectors/:id
{ metadata: { customData: { newKey: 'value' } } }

// koaGuard 阶段：configurableConnectorMetadataGuard strip 掉 customData
// → ctx.guard.body.metadata = {} (只剩4白名单字段，customData 被移除)
// → cleanDeep({}) → undefined → conditional(undefined) → 不写入
// → DB 中的 metadata 列不变
```

**场景 3：`fullSignInExperienceGuard` 中的 `customData`**

```typescript
// packages/schemas/src/types/sign-in-experience.ts:60-68
socialConnectors: connectorMetadataGuard
  .omit({
    description: true,
    configTemplate: true,
    formItems: true,
    readme: true,
    customData: true,  // ← 显式 omit
  })
  .array(),
```

登录体验 API 中 `customData` 被**显式 omit**，即使工厂元数据中有 `customData`，也不会在登录体验响应中暴露。

---

## 5. 三种结果的具体触发条件

### 5.1 结果一：字段被移除（Silently Stripped）

**触发条件**：
1. 字段不存在于当前 Guard 的白名单中
2. 使用默认的 `parse()` / `safeParse()` 调用（未加 `.strict()` / `.passthrough()`）

**在不同 Guard 中的白名单**：

| Guard | 白名单字段 |
|-------|-----------|
| `connectorMetadataGuard` | `id`, `target`, `name`, `description`, `logo`, `logoDark`, `readme`, `configTemplate`, `formItems`, `customData`, `fromEmail`, `platform`, `isStandard`, `isTokenStorageSupported` |
| `configurableConnectorMetadataGuard` | `target`, `name`, `logo`, `logoDark` |
| `fullSignInExperienceGuard.socialConnectors` | `id`, `target`, `name`, `logo`, `logoDark`, `fromEmail`, `platform`, `isStandard`, `isTokenStorageSupported` |

### 5.2 结果二：校验失败报错（Validation Error）

**触发条件**：
1. 显式调用 `.strict()` 后遇到未知字段
2. 已知字段的值类型不匹配 schema 定义
3. 必填字段缺失

**注意**：当前代码库中没有任何位置对 `connectorMetadataGuard` 或 `configurableConnectorMetadataGuard` 调用 `.strict()`，因此未知字段永远不会触发报错，只会被静默移除。

### 5.3 结果三：进入 `customData` 的扩展字段

**触发条件**：
1. 字段被显式嵌套在 `customData` 对象内（仅对 `connectorMetadataGuard` 有效）
2. `configurableConnectorMetadataGuard` **不支持** `customData` —— 被 `.pick()` 排除

**持久化限制**：
- `customData` 只存在于工厂元数据层（内存），不通过管理 API 持久化
- 要修改 `customData`，必须更新连接器包的代码并重启服务

---

## 6. 关键位置索引

| 定义 | 文件路径 | 行号 |
|-----|---------|------|
| `connectorMetadataGuard` 定义 | `packages/toolkit/connector-kit/src/types/metadata.ts` | 76-95 |
| `configurableConnectorMetadataGuard` 定义 | `packages/toolkit/connector-kit/src/types/metadata.ts` | 98-105 |
| `.catchall()` 移除说明 | `packages/toolkit/connector-kit/CHANGELOG.md` | 191-195 |
| `connectors.sql` metadata 类型约束 | `packages/schemas/tables/connectors.sql` | 12 |
| `@use` 注解解析逻辑 | `packages/schemas/src/gen/utils.ts` | 210 |
| Guard 生成模板 | `packages/schemas/src/gen/schema.ts` | 80-83, 105-109 |
| tsType import 收集 | `packages/schemas/src/gen/index.ts` | 154-155 |
| `configurableConnectorMetadataGuard` re-export | `packages/schemas/src/foundations/jsonb-types/index.ts` | 20-25 |
| `connectorResponseGuard` | `packages/schemas/src/types/connector.ts` | 9-26 |
| `connectorFactoryResponseGuard` | `packages/schemas/src/types/connector.ts` | 30-35 |
| `fullSignInExperienceGuard` socialConnectors | `packages/schemas/src/types/sign-in-experience.ts` | 60-68 |
| `socialConnectorMetadataGuard` | `packages/toolkit/connector-kit/src/types/metadata.ts` | 53-59 |
| `Guard<T>` 类型定义 | `packages/schemas/src/foundations/schemas.ts` | 10-18 |
| POST /connectors body guard | `packages/core/src/routes/connector/index.ts` | 68-82 |
| PATCH /connectors body guard | `packages/core/src/routes/connector/index.ts` | 280-282 |
| metadata 持久化（replace 模式） | `packages/core/src/routes/connector/index.ts` | 348-363 |
| 运行时 metadata 合并 | `packages/core/src/libraries/connector.ts` | 96-103 |
| `transpileLogtoConnector` 响应构造 | `packages/core/src/utils/connectors/index.ts` | 32-58 |
