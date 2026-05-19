# 审计日志中间件完整链路分析

## 1. 整体架构概述

审计日志系统是一个从**请求进入**到**持久化存储**再到**查询展示**的完整链路。核心设计采用了「中间件注入上下文 + 业务代码显式记录 + 自动收集上下文 + 批量持久化」的模式。

```
请求进入 → 中间件挂载 → 业务处理(createLog/append) → 异常捕获 → 上下文自动补充 → 批量持久化 → API查询 → 前端展示
```

---

## 2. 核心文件清单

| 模块 | 文件路径 | 职责 |
|------|---------|------|
| 中间件核心 | `packages/core/src/middleware/koa-audit-log.ts` | 上下文注入、日志收集、持久化触发 |
| 数据库操作 | `packages/core/src/queries/log.ts` | 日志的插入、查询、统计 |
| API 路由 | `packages/core/src/routes/log.ts` | 对外暴露审计日志查询接口 |
| 类型定义 | `packages/schemas/src/types/log/index.ts` | 日志 Key 类型、字段定义 |
| 前端面板 | `packages/console/src/components/AuditLogTable/index.tsx` | 审计日志查询 UI |
| Experience 补充 | `packages/core/src/routes/experience/middleware/koa-experience-audit-log.ts` | Experience 路由补充 applicationId 上下文 |
| 头部注入 | `packages/core/src/utils/injected-header-mapping.ts` | 从请求头提取地理位置等信息 |
| 事件监听器工具 | `packages/core/src/event-listeners/utils.ts` | 从 OIDC 上下文提取 userId、applicationId |

---

## 3. 中间件核心实现详解

### 3.1 中间件工厂函数 (`koa-audit-log.ts:128-198`)

```typescript
export default function koaAuditLog<StateT, ContextT extends IRouterParamContext, ResponseBodyT>({
  logs: { insertLog },
}: Queries): MiddlewareType<StateT, WithLogContext<ContextT>, ResponseBodyT>
```

**核心机制：**

1. **上下文注入**：向 Koa ctx 注入两个方法
   - `ctx.createLog(key: LogKey)` - 创建日志条目
   - `ctx.prependAllLogEntries(payload)` - 批量前置补充字段

2. **日志条目收集**：使用闭包数组 `entries: LogEntry[]` 收集本次请求的所有日志

3. **生命周期钩子**：
   - `try { await next() }` - 执行业务逻辑
   - `catch` - 异常时自动标记所有日志为 Error
   - `finally` - 无论成功失败都执行持久化

### 3.2 LogEntry 类 (`koa-audit-log.ts:45-70`)

```typescript
export class LogEntry {
  payload: LogContextPayload;

  constructor(public readonly key: LogKey) {
    this.payload = { key, result: LogResult.Success };
  }

  prepend(data: Readonly<LogPayload>) {
    this.payload = {
      ...removeUndefinedKeys(data),
      ...this.payload,
    };
  }

  append(data: Readonly<LogPayload>) {
    this.payload = {
      ...this.payload,
      ...filterSensitiveData(removeUndefinedKeys(data)),
    };
  }
}
```

**合并优先级（重要修正）：**

| 方法 | 合并顺序 | 优先级 | 脱敏 | 用途 |
|------|---------|--------|------|------|
| `prepend(data)` | `{ ...data, ...this.payload }` | `data` < `this.payload`（后覆盖先，payload 优先级更高） | 否 | 注入通用上下文（IP、UA、applicationId），业务字段可覆盖 |
| `append(data)` | `{ ...this.payload, ...data }` | `this.payload` < `data`（后覆盖先，data 优先级更高） | 是 | 补充业务数据，可覆盖已有字段 |

**关键理解：**
- `prepend`：data 在前，payload 在后 → payload 覆盖 data → 业务数据优先级更高
- `append`：payload 在前，data 在后 → data 覆盖 payload → 新补充的数据优先级更高
- 最终持久化时：`{ ...basePayload, ...payload }` → basePayload 在前，业务 payload 在后 → 业务数据覆盖基础上下文

### 3.3 敏感数据脱敏 (`koa-audit-log.ts:16-40`)

```typescript
const sensitiveDataKeys = Object.freeze(['password', 'secret']);

const filterSensitiveData = (data: Record<string, unknown>): Record<string, unknown> => {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      return [key, sensitiveDataKeys.includes(key) ? '******' : sanitise(value)];
    })
  );
};
```

- 递归遍历对象和数组
- 匹配 `password` 和 `secret` 字段替换为 `******`
- 仅在 `append` 时触发，`prepend` 不触发

---

## 4. 中间件覆盖路由全景

### 4.1 路由挂载总览 (`routes/init.ts`)

审计日志中间件采用**分级挂载**策略，不同路由组有不同的挂载方式：

```
initApis(tenant)
├─ experienceRouter
│  └─ use(koaAuditLog) → 所有 /experience/** 路由
├─ interactionRouter
│  └─ use(koaAuditLog) → 所有 /interaction/** 路由（v1 旧版）
├─ managementRouter
│  └─ 无直接挂载，部分子路由单独挂载
├─ anonymousRouter
│  ├─ /authn/saml/:connectorId → 路由级挂载
│  ├─ /authn/sso/saml/:connectorId → 路由级挂载
│  └─ /saml-applications/:id/* → 路由级挂载
└─ userRouter
   └─ 无直接挂载
```

### 4.2 Experience 路由 (`routes/init.ts:72-74`)

```typescript
const experienceRouter: AnonymousRouter = new Router();
experienceRouter.use(koaAuditLog(tenant.queries));  // 挂载审计日志
experienceRouter.use(koaEmailI18n(tenant.queries));
experienceApiRoutes(experienceRouter, tenant);
```

- **挂载级别**：Router 级（所有子路由自动继承）
- **覆盖范围**：所有 `/experience/**` 路由（v2 新版交互 API）
- **补充中间件**：`koaExperienceAuditLog` - 自动注入 `applicationId`

**Experience 内部调用链：**
```
PUT /experience
  ↓
koaAuditLog (注入 createLog)
  ↓
koaInteractionDetails
  ↓
koaExperienceInteractionHooks
  ↓
koaExperienceInteraction
  ↓
koaExperienceAuditLog (finally 中 prependAllLogEntries({ applicationId }))
  ↓
业务处理：ctx.createLog('Interaction.SignIn.Create')
  ↓
finally：注入 ip、userAgent、signInContext，持久化
```

### 4.3 Interaction 路由（v1 旧版）(`routes/interaction/index.ts:58-61`)

```typescript
const router = (anonymousRouter as Router<...>).use(
  koaAuditLog(queries),
  koaInteractionDetails(provider)
);
```

- **挂载级别**：Router 级
- **覆盖范围**：所有 `/interaction/**` 路由（v1 旧版交互 API）
- **日志记录点**：
  - `PUT /interaction` → `Interaction.${event}.Update`
  - `PUT /interaction/event` → `Interaction.${event}.Update`
  - `PATCH /interaction/identifiers` → `Interaction.${event}.Update`
  - `PUT /interaction/profile` → `Interaction.${event}.Profile.Create`
  - `PATCH /interaction/profile` → `Interaction.${event}.Profile.Update`
  - `DELETE /interaction/profile` → `Interaction.${event}.Profile.Delete`
  - `POST /interaction/submit` → `Interaction.${event}.Submit`

### 4.4 OIDC Provider (`oidc/init.ts:422`)

```typescript
// Provide audit log context for event listeners
oidc.use(koaAuditLog(queries));
```

- **挂载级别**：OIDC Provider 级
- **覆盖范围**：所有 OIDC 相关请求（授权、token、userinfo、revocation 等）
- **用途**：供 OIDC 事件监听器使用，不在路由处理器中直接调用
- **触发点**：OIDC Provider 内部事件回调

**OIDC 事件监听器调用链：**
```
authorization.success 事件
  ↓
createAuthorizationSuccessListener
  ↓
ctx.createLog('RevokeGrants')
  ↓
log.append({ ...extractInteractionContext(ctx), ... })
  ↓
finally：注入 ip、userAgent、signInContext，持久化
```

**OIDC 相关日志记录：**

| 事件 | 监听器 | LogKey | 字段来源 |
|------|--------|--------|---------|
| interaction.started | `interactionStartedListener` | `Interaction.Create` | `extractInteractionContext(ctx)` |
| interaction.ended | `interactionEndedListener` | `Interaction.End` | `extractInteractionContext(ctx)` |
| grant.success | `grantListener` | `ExchangeTokenBy.${type}` | `extractInteractionContext(ctx)` + token info |
| grant.revoked | `grantRevocationListener` | `RevokeToken` | `extractInteractionContext(ctx)` + grantId |

### 4.5 Authn 路由 (`routes/authn.ts`)

Authn 路由采用**路由级挂载**，而非 Router 级：

```typescript
router.post(
  `/authn/${ssoPath}/saml/:connectorId`,
  koaGuard({ ... }),
  koaAuditLog(queries),  // 仅挂载到此路由
  async (ctx, next) => {
    const log = ctx.createLog('Interaction.SignIn.Verification.IdpInitiatedSso.Create');
    log.append({ connectorId, ssoSessionId, assertionContent });
    // ...
  }
);
```

- **挂载级别**：单路由级
- **覆盖范围**：仅 `/authn/sso/saml/:connectorId`
- **LogKey**：`Interaction.SignIn.Verification.IdpInitiatedSso.Create`
- **记录字段**：`connectorId`、`ssoSessionId`、`assertionContent`（**无 applicationId**）

### 4.6 SAML 应用路由 (`routes/saml-application/anonymous.ts`)

SAML 路由也采用**路由级挂载**：

```typescript
// SAML 回调
router.get(
  '/saml-applications/:id/callback',
  koaGuard({ ... }),
  koaAuditLog(queries),
  async (ctx, next) => {
    const log = ctx.createLog('SamlApplication.Callback');
    log.append({ query, applicationId: id });
    // ...
  }
);

// SAML 认证请求（Redirect Binding）
router.get(
  '/saml/:id/authn',
  koaGuard({ ... }),
  koaAuditLog(queries),
  async (ctx, next) => {
    const log = ctx.createLog('SamlApplication.AuthnRequest');
    log.append({ query, applicationId: id });
    // ...
  }
);

// SAML 认证请求（POST Binding）
router.post(
  '/saml/:id/authn',
  koaGuard({ ... }),
  koaAuditLog(queries),
  async (ctx, next) => {
    const log = ctx.createLog('SamlApplication.AuthnRequest');
    log.append({ body, applicationId: id });
    // ...
  }
);
```

- **挂载级别**：单路由级
- **覆盖范围**：SAML 应用的回调和认证请求
- **LogKey**：
  - `SamlApplication.Callback`
  - `SamlApplication.AuthnRequest`

### 4.7 路由覆盖总结表

| 路由组 | 挂载级别 | 覆盖范围 | 典型 LogKey |
|--------|---------|---------|------------|
| Experience | Router 级 | `/experience/**` | `Interaction.SignIn.Create` |
| Interaction (v1) | Router 级 | `/interaction/**` | `Interaction.SignIn.Submit` |
| OIDC | Provider 级 | 所有 OIDC 端点 | `Interaction.Create`、`ExchangeTokenBy.Code`、`RevokeToken` |
| Authn SAML | 单路由级 | `/authn/sso/saml/:connectorId` | `Interaction.SignIn.Verification.IdpInitiatedSso.Create` |
| SAML Application | 单路由级 | `/saml-applications/:id/callback`、`/saml/:id/authn` | `SamlApplication.Callback`、`SamlApplication.AuthnRequest` |
| Management API | 无 | - | -（管理操作暂无审计日志） |

---

## 5. 关键字段完整链路：来源 → 记录 → 入库

### 5.1 字段链路总览

```
┌─────────────────┬─────────────────┬─────────────────┬─────────────────┬─────────────────┐
│      字段       │      来源       │   记录时机      │    记录方式     │    入库时机     │
├─────────────────┼─────────────────┼─────────────────┼─────────────────┼─────────────────┤
│       ip        │  ctx.request.ip │   finally 块    │    prepend      │   finally 块    │
│    userAgent    │  请求头 UA      │   finally 块    │    prepend      │   finally 块    │
│ userAgentParsed │ UAParser 解析   │   finally 块    │    prepend      │   finally 块    │
│  signInContext  │  注入请求头     │   finally 块    │    prepend      │   finally 块    │
│  applicationId  │  多来源         │  业务处理中     │ prepend/append  │   finally 块    │
│     userId      │  多来源         │  业务处理中     │     append      │   finally 块    │
└─────────────────┴─────────────────┴─────────────────┴─────────────────┴─────────────────┘
```

### 5.2 ip 字段链路

**来源**：
```typescript
// koa-audit-log.ts:163
const { ip } = ctx.request;
```

**记录时机**：finally 块中构造 basePayload
**记录方式**：prepend（不脱敏）
**入库时机**：finally 块中 `insertLog({ payload: { ...basePayload, ...payload } })`

### 5.3 User-Agent 字段链路

**来源**：
```typescript
// koa-audit-log.ts:165-180
const { headers: { 'user-agent': userAgent } } = ctx.request;
const userAgentParsed = new UAParser(userAgentValue).getResult();
```

**记录时机**：finally 块中构造 basePayload
**记录方式**：prepend（不脱敏）
**入库时机**：finally 块中插入数据库

### 5.4 signInContext 字段链路

**来源**：
```typescript
// injected-header-mapping.ts:100-126
export const getInjectedHeaderValues = (headers: IncomingHttpHeaders) => {
  // 从请求头提取：x-logto-cf-country, x-logto-cf-city 等
  const entries = Object.entries(injectedHeaderMapping).flatMap(([key, headerName]) => {
    const value = normalizeHeaderValue(headers[headerName]);
    return value === undefined ? [] : [[key, value]];
  });
  return Object.fromEntries(entries);
};
```

**记录时机**：finally 块中构造 basePayload
**记录方式**：prepend（不脱敏）
**入库时机**：finally 块中插入数据库

**支持的注入字段**：
| 字段名 | 请求头 | 说明 |
|--------|--------|------|
| country | x-logto-cf-country | 国家 |
| city | x-logto-cf-city | 城市 |
| latitude | x-logto-cf-latitude | 纬度 |
| longitude | x-logto-cf-longitude | 经度 |
| botScore | x-logto-cf-bot-score | 机器人评分 |
| botVerified | x-logto-cf-bot-verified | 机器人验证状态 |

### 5.5 applicationId 字段链路

**多来源**：

| 场景 | 来源 | 记录方式 | 代码位置 |
|------|------|---------|---------|
| Experience 路由 | `interactionDetails.params.client_id` | `prependAllLogEntries({ applicationId })` | `koa-experience-audit-log.ts:19` |
| OIDC 事件 | `ctx.oidc.entities.Client?.clientId` | `log.append(extractInteractionContext(ctx))` | `event-listeners/utils.ts:16` |
| SAML 路由 | 路由参数 `:id` | `log.append({ applicationId: id })` | `saml-application/anonymous.ts:133` |
| Authn SAML | **无** | **不记录 applicationId** | -（仅记录 connectorId、ssoSessionId、assertionContent，不写 applicationId） |

**Experience 路由的 applicationId 注入时机**：
```typescript
// koa-experience-audit-log.ts:11-21
export default function koaExperienceAuditLog() {
  return async (ctx, next) => {
    const { prependAllLogEntries, interactionDetails } = ctx;
    const applicationId = conditionalString(interactionDetails.params.client_id);

    try {
      await next();  // 先执行业务代码，业务代码调用 createLog 和 append
    } finally {
      prependAllLogEntries({ applicationId });  // 最后 prepend applicationId
    }
  };
}
```

**关键**：`prependAllLogEntries` 在 finally 中执行，此时业务代码已经创建了日志条目，prepend 的数据会被业务 append 的数据覆盖。

### 5.6 userId 字段链路

**多来源**：

| 场景 | 来源 | 记录方式 | 代码位置 |
|------|------|---------|---------|
| OIDC 事件 | `ctx.oidc.entities.Account?.accountId` | `log.append(extractInteractionContext(ctx))` | `event-listeners/utils.ts:20` |
| Experience Submit | `experienceInteraction.identifiedUserId` | `log.append({ userId })` | `experience/index.ts:188` |
| Token Revocation | `AccessToken?.accountId ?? RefreshToken?.accountId` | `log.append({ userId })` | `event-listeners/grant.ts:52` |
| SAML Callback | `samlApplication.handleOidcCallbackAndGetUserInfo()` | `log.append({ userInfo })` | `saml-application/anonymous.ts:166` |

**OIDC 事件中提取 userId**：
```typescript
// event-listeners/utils.ts:7-23
export const extractInteractionContext = (ctx): LogPayload => {
  const {
    entities: { Account, Session, Client, Interaction },
    params,
  } = ctx.oidc;

  return {
    applicationId: Client?.clientId,
    applicationSecret: ctx.appSecret,
    sessionId: Session?.jti,
    interactionId: Interaction?.jti,
    userId: Account?.accountId,  // 从 OIDC Account 实体提取
    params,
  };
};
```

### 5.7 userInfo 字段链路

**来源**：
```typescript
// saml-application/anonymous.ts:162-167
const userInfo = await samlApplication.handleOidcCallbackAndGetUserInfo({
  code,
});
log.append({
  userInfo,
});
```

**记录时机**：SAML Callback 业务处理中
**记录方式**：append（自动脱敏）
**入库时机**：finally 块中插入数据库

**说明**：
- `userInfo` 是 SAML 应用回调时从 OIDC 获取的完整用户信息对象
- 通常包含 `sub`（用户 ID）、`name`、`email`、`picture` 等字段
- **与 userId 字段的区别**：userId 是独立的字符串字段，userInfo 是完整的用户信息对象
- 仅在 `SamlApplication.Callback` 日志中记录

### 5.8 完整字段合并顺序

```
初始 payload (createLog 时):
{ key: 'Interaction.SignIn.Create', result: 'Success' }

业务 append:
log.append({ userId: 'user123', password: 'secret' })
→ { key: '...', result: 'Success', userId: 'user123', password: '******' }  // 脱敏

koaExperienceAuditLog prepend:
prependAllLogEntries({ applicationId: 'app456' })
→ { applicationId: 'app456', key: '...', result: 'Success', userId: 'user123', password: '******' }

finally basePayload prepend:
{ ip: '1.2.3.4', userAgent: '...', signInContext: { country: 'US' } }
→ 先 merge: { ...basePayload, ...payload }
→ 最终: { ip: '1.2.3.4', userAgent: '...', signInContext: {...}, applicationId: 'app456', key: '...', ... }
```

**合并优先级（从低到高）：**
1. basePayload（ip、userAgent、signInContext）- 最低，可被覆盖
2. prepend 的数据（applicationId 等）- 中等
3. append 的业务数据（userId、password 等）- 最高

---

## 6. 日志 Key 类型系统

### 6.1 类型定义 (`schemas/src/types/log/index.ts`)

```typescript
export type AuditLogKey =
  | typeof LogKeyUnknown
  | InteractionLogKey
  | TokenLogKey
  | SamlLogKey
  | JwtCustomizerLogKey;
```

### 6.2 Interaction Log Key 结构 (`schemas/src/types/log/interaction.ts`)

```typescript
export type LogKey =
  | `${Prefix}.${Action.Create | Action.End}`
  | `${Prefix}.${InteractionEvent}.${Action.Create | Action.Update | Action.Submit}`
  | `${Prefix}.${InteractionEvent}.${Field.Profile}.${Action.Update}`
  | `${Prefix}.${InteractionEvent}.${Field.Identifier}.${Method}.${Action}`
  | ...
```

**命名规范**：`{Prefix}.{InteractionEvent}.{Field?}.{Method?}.{Action}`

示例：
- `Interaction.SignIn.Create`
- `Interaction.SignIn.Identifier.Password.Submit`
- `Interaction.ForgotPassword.Profile.Update`
- `Interaction.SignIn.Verification.IdpInitiatedSso.Create`

### 6.3 Token Log Key 示例

- `ExchangeTokenBy.AuthorizationCode`
- `ExchangeTokenBy.RefreshToken`
- `ExchangeTokenBy.ClientCredentials`
- `RevokeToken`
- `RevokeGrants`

### 6.4 SAML Log Key 示例

- `SamlApplication.Callback`
- `SamlApplication.AuthnRequest`

---

## 7. 持久化层

### 7.1 数据库表结构

```sql
-- logs 表包含字段：
id (主键)
key (日志类型)
payload (JSONB 字段，存储所有日志数据)
createdAt (创建时间)
```

### 7.2 插入逻辑 (`queries/log.ts:77`)

```typescript
const insertLog = buildInsertIntoWithPool(pool)(Logs);
```

使用通用插入构建器，批量插入：

```typescript
await Promise.all(
  entries.map(async ({ payload }) => {
    return insertLog({
      id: generateStandardId(),
      key: payload.key,
      payload: { ...basePayload, ...payload },  // basePayload 在前，payload 在后
    });
  })
);
```

- 每个日志条目生成独立 ID
- `basePayload`（自动注入的上下文）与 `payload`（业务数据）合并
- 并行插入所有日志

### 7.3 查询逻辑 (`queries/log.ts:107-115`)

```typescript
const findLogs = async (limit: number, offset: number, logCondition: LogCondition) =>
  pool.any<Log>(sql`
    select ${sql.join(Object.values(fields), sql`,`)}
    from ${table}
    ${buildLogConditionSql(logCondition)}
    order by ${fields.createdAt} desc
    limit ${limit}
    offset ${offset}
  `);
```

支持的过滤条件：
- `logKey` - 精确匹配日志类型
- `payload.applicationId` - JSONB 字段匹配
- `payload.userId` - JSONB 字段匹配
- `startTime` / `endTime` - 时间范围
- `includeKeyPrefix` - 日志类型前缀匹配（如 `Interaction.`、`ExchangeTokenBy.`）

### 7.4 性能优化：计数上限 (`queries/log.ts:79-105`)

```typescript
const LOGS_COUNT_CAP = 10_000;

const countLogs = async (condition: LogCondition, options?: { capped?: boolean }) => {
  if (!options?.capped) {
    // 正常计数
  }

  const cappedLimit = LOGS_COUNT_CAP + 1;
  // 限制计数到 10001 条，避免大表全表扫描
};
```

- 当 `enableCap=true` 时，最多计数到 10,001 条
- 超过则返回 `isCapped: true`
- 解决大日志表 `count(*)` 性能问题

---

## 8. API 层

### 8.1 列表查询 (`routes/log.ts:24-87`)

```typescript
router.get(
  '/logs',
  koaPagination(),
  koaGuard({
    query: object({
      userId: string().optional(),
      applicationId: string().optional(),
      logKey: string().optional(),
      enableCap: string().optional(),
      start_time: string().optional(),
      end_time: string().optional(),
    }),
    response: Logs.guard.array(),
    status: [200, 400],
  }),
  async (ctx, next) => {
    // ...
  }
);
```

**查询白名单** (`routes/log.ts:49-57`)：

```typescript
const includeKeyPrefix: AuditLogPrefix[] = [
  token.Type.ExchangeTokenBy,
  token.Type.RevokeToken,
  token.Type.RevokeGrants,
  interaction.prefix,
  jwtCustomizer.prefix,
  saml.prefix,
  LogKeyUnknown,
];
```

仅允许查询上述前缀的日志，避免泄露 webhook 等内部日志。

### 8.2 详情查询 (`routes/log.ts:89-101`)

```typescript
router.get(
  '/logs/:id',
  koaGuard({ params: object({ id: string().min(1) }), response: Logs.guard, status: [200, 404] }),
  async (ctx, next) => {
    ctx.body = await findLogById(id);
    return next();
  }
);
```

---

## 9. 前端查询面板

### 9.1 AuditLogTable 组件 (`console/src/components/AuditLogTable/index.tsx`)

**核心功能：**
1. **分页查询**：使用 SWR 进行数据请求和缓存
2. **过滤条件**：
   - 事件类型（EventSelector）
   - 应用筛选（ApplicationSelector）
   - 时间范围（TimeRangePicker）
3. **表格展示**：
   - 事件名称 + 状态
   - 用户信息
   - 应用信息
   - 时间

### 9.2 查询参数构建

```typescript
const url = buildUrl('api/logs', {
  page: String(page),
  page_size: String(pageSize),
  enableCap: 'true',
  ...conditional(event && { logKey: event }),
  ...conditional(searchApplicationId && { applicationId: searchApplicationId }),
  ...conditional(userId && { userId }),
  ...conditional(isDevFeaturesEnabled && startTime !== undefined && { start_time: String(startTime) }),
  ...conditional(isDevFeaturesEnabled && endTime !== undefined && { end_time: String(endTime) }),
});
```

---

## 10. 完整调用链路示例

### 10.1 Experience 登录流程示例

```
1. 请求进入 PUT /experience
   ├─ 请求头包含：User-Agent、x-logto-cf-country、x-logto-cf-city
   └─ 请求体：{ interactionEvent: 'SignIn', captchaToken: '...' }
   ↓
2. koaAuditLog 中间件执行
   ├─ 注入 ctx.createLog 和 ctx.prependAllLogEntries
   └─ 初始化 entries = []
   ↓
3. koaInteractionDetails 执行
   └─ 从 cookie 解析 interactionDetails，提取 client_id = 'app_123'
   ↓
4. koaExperienceAuditLog 执行
   └─ 等待 next() 完成，finally 中注入 applicationId
   ↓
5. 业务处理
   ├─ const log = ctx.createLog('Interaction.SignIn.Create')
   ├─ 验证验证码
   ├─ 保存 interaction
   └─ log.append({ profile: { password: 'secret123' } })  // password 会被脱敏
   ↓
6. koaExperienceAuditLog finally 执行
   └─ prependAllLogEntries({ applicationId: 'app_123' })
   ↓
7. koaAuditLog finally 执行
   ├─ 提取 ip = '192.168.1.100'
   ├─ 提取 userAgent = 'Mozilla/5.0...'
   ├─ UAParser 解析 userAgentParsed
   ├─ getInjectedHeaderValues 提取 signInContext = { country: 'US', city: 'New York' }
   ├─ 构造 basePayload = { ip, userAgent, userAgentParsed, signInContext }
   ├─ 合并：{ ...basePayload, ...payload }
   └─ 调用 insertLog 插入数据库
   ↓
8. 最终入库 payload:
   {
     key: 'Interaction.SignIn.Create',
     result: 'Success',
     ip: '192.168.1.100',
     userAgent: 'Mozilla/5.0...',
     userAgentParsed: { browser: {...}, os: {...}, device: {...} },
     signInContext: { country: 'US', city: 'New York' },
     applicationId: 'app_123',
     profile: { password: '******' }
   }
```

### 10.2 OIDC 授权成功流程示例

```
1. OIDC authorization.success 事件触发
   ↓
2. createAuthorizationSuccessListener 执行
   ├─ 从 ctx.oidc 提取 userId = 'user_456'、clientId = 'app_789'
   ├─ const log = ctx.createLog('RevokeGrants')
   └─ log.append(extractInteractionContext(ctx))  // { userId, applicationId, ... }
   ↓
3. koaAuditLog finally 执行
   ├─ 注入 ip、userAgent、signInContext
   └─ 持久化到数据库
```

### 10.3 异常流程示例

```
1. 请求进入 POST /experience/submit
   ↓
2. ctx.createLog('Interaction.SignIn.Submit')
   ↓
3. 业务抛出 RequestError({ code: 'auth.password_invalid', status: 401 })
   ↓
4. koaAuditLog catch 块执行
   ├─ 所有日志 result = LogResult.Error
   └─ 附加 error 字段：{ message: '密码错误', code: 'auth.password_invalid', data: {...} }
   ↓
5. 重新抛出异常，返回给客户端
   ↓
6. koaAuditLog finally 执行
   ├─ 注入 ip、userAgent、signInContext
   └─ 持久化到数据库（包含错误信息）
```

---

## 11. 设计亮点

1. **非侵入式设计**：中间件注入上下文，业务代码按需记录
2. **自动脱敏**：敏感字段（password、secret）自动替换，避免人为遗漏
3. **批量持久化**：一次请求多个日志并行插入
4. **上下文自动补充**：IP、UA、地理位置等自动注入
5. **异常自动标记**：异常时自动标记所有日志为失败
6. **性能优化**：大表计数上限，避免全表扫描
7. **类型安全**：LogKey 采用模板字面量类型，编译时检查
8. **灵活挂载**：支持 Router 级、单路由级、Provider 级多种挂载方式
9. **可扩展上下文**：通过 `prependAllLogEntries` 可在任意中间件补充通用字段

---

## 12. 注意事项

1. **合并优先级**：`append` > `prepend` > `basePayload`，业务数据优先级最高
2. **日志条目生命周期**：LogEntry 实例需保存好，多个地方 append 需传递
3. **prepend vs append**：prepend 不脱敏，append 脱敏（password、secret）
4. **中间件顺序**：koaAuditLog 需在业务中间件之前挂载，koaExperienceAuditLog 需在之后
5. **查询白名单**：新增日志类型需在 `includeKeyPrefix` 中添加才能在管理后台查询
6. **OIDC 事件日志**：OIDC Provider 级挂载的中间件仅在事件监听器中使用，路由处理器不直接调用
7. **性能考虑**：日志量大时注意日志表分区或归档策略
8. **敏感字段扩展**：如需新增敏感字段，在 `sensitiveDataKeys` 数组中添加即可
