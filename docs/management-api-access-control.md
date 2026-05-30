# 后台管理接口访问控制分层架构

## 概述

Logto 后台管理接口（Management API）采用多层级的访问控制架构，通过租户上下文注入、多层权限守卫、双层缓存机制、越权拒绝和三类观测面（审计日志 / Management Hooks / AppInsights）的协同工作，实现安全、高效的访问控制。

## 一、managementRouter 中间件体系

### 1.1 全局固定中间件（三层）

managementRouter 在 `packages/core/src/routes/init.ts:76-79` 挂载了三个全局中间件，**所有**挂载在 managementRouter 下的路由均会依次经过：

```
managementRouter.use(koaAuth(...))           // 第 1 层：JWT 认证 + all scope 检查
managementRouter.use(koaTenantGuard(...))     // 第 2 层：租户暂停状态检查（云环境）
managementRouter.use(koaManagementApiHooks(...))  // 第 3 层：Hook 上下文注入 + 触发
```

关键特性：
- 这三层中间件是 **固定顺序**，业务路由无法跳过或重排
- `koaManagementApiHooks` 在 `try/finally` 中运行，**即使请求失败也会触发 exception hooks（如果有主动注册的异常上下文）**
- `koaAuth` 和 `koaTenantGuard` 拒绝请求时抛出 `RequestError`，错误会上抛至 `koaErrorHandler`

### 1.2 按需接入的守卫（各业务路由自行决定）

各业务路由在全局中间件之后，**按需**接入以下守卫，不同路由的守卫组合不同：

| 守卫 | 接入方式 | 典型路由 | 作用 |
|------|---------|---------|------|
| `koaGuard` | 几乎所有路由 | 所有 CRUD 端点 | 请求参数/响应体的 Zod 验证 |
| `koaQuotaGuard` | 写操作路由 | `POST /organizations` 等 | 资源配额限制 |
| `koaReportSubscriptionUpdates` | 写操作路由 | `POST/PUT/DELETE /organizations` 等 | 变更后上报 Cloud |
| `koaPagination` | 列表查询路由 | `GET /roles` 等 | 分页参数 |
| `koaRoleRlsErrorHandler` | 特定路由组 | `/roles(/.*)?` | RLS 错误处理 |
| `SchemaRouter middlewares` | SchemaRouter 子路由 | organizations 等 | 按 scope/method 精细控制 |

**示例对比**：

```
POST /roles 的中间件链：
  koaAuth → koaTenantGuard → koaManagementApiHooks  [全局固定]
  → koaGuard({ body, status, response })             [按需：参数验证]
  → quota.guardTenantUsageByKey('userRolesLimit')    [按需：配额检查（业务代码内调用）]

POST /organizations 的中间件链：
  koaAuth → koaTenantGuard → koaManagementApiHooks   [全局固定]
  → SchemaRouter middlewares:
    → koaQuotaGuard({ key: 'organizationsLimit' })   [按需：配额守卫（middleware 级别）]
    → koaReportSubscriptionUpdates(...)               [按需：变更上报]
  → koaGuard(...)                                     [按需：参数验证]
```

**关键差异**：配额守卫有两种接入方式：
1. **middleware 级别**（如 `koaQuotaGuard`）：在 `koaGuard` 之前执行，失败返回 403
2. **业务代码内调用**（如 `quota.guardTenantUsageByKey()`）：在 `koaGuard` 之后执行，更灵活但位置不固定

### 1.3 完整中间件执行顺序

```
请求进入 managementRouter
  │
  ├─ koaAuth                          ← 全局固定
  │   ├─ JWT 无效 → 401 RequestError
  │   ├─ 缺少 all scope → 403 RequestError
  │   └─ 通过 → ctx.auth = { type, id, scopes }
  │
  ├─ koaTenantGuard                   ← 全局固定
  │   ├─ OSS → 直接跳过
  │   ├─ 租户暂停 → 403 RequestError
  │   └─ 通过 → next()
  │
  ├─ koaManagementApiHooks            ← 全局固定
  │   ├─ 注入 ctx.appendDataHookContext
  │   ├─ 注入 ctx.appendExceptionHookContext
  │   ├─ try { await next() }
  │   │   ├─ [按需守卫: koaQuotaGuard 等]
  │   │   ├─ [按需守卫: koaGuard]
  │   │   └─ [业务逻辑]
  │   ├─ 成功: 触发 data hooks + 注册的自动 hooks
  │   └─ finally: 触发 exception hooks（如果有主动注册的异常上下文）
  │
  └─ 错误上抛至 koaErrorHandler        ← Tenant 级 Koa app
      └─ 所有 RequestError → AppInsights + HTTP 响应
```

## 二、租户上下文注入机制

### 2.1 租户上下文定义

**文件位置**: `packages/core/src/tenants/TenantContext.ts`

```typescript
export default abstract class TenantContext {
  public abstract readonly id: string;
  public abstract readonly envSet: EnvSet;
  public abstract readonly provider: Provider;
  public abstract readonly wellKnownCache: WellKnownCache;
  public abstract readonly queries: Queries;
  public abstract readonly logtoConfigs: LogtoConfigLibrary;
  public abstract readonly cloudConnection: CloudConnectionLibrary;
  public abstract readonly connectors: ConnectorLibrary;
  public abstract readonly libraries: Libraries;
  public abstract readonly sentinel: Sentinel;
  public abstract invalidateCache(): Promise<void>;
  public abstract scheduleSigningKeyRotation(timestamp: number): Promise<void>;
}
```

### 2.2 租户实例创建流程

**文件位置**: `packages/core/src/tenants/Tenant.ts`

1. **租户识别**: 通过请求域名或路径提取租户 ID
2. **数据库连接**: `getTenantDatabaseDsn(id)` 获取租户数据库 DSN
3. **环境初始化**: `EnvSet` 加载配置
4. **依赖实例化**（在 `Tenant` 构造函数中一次性完成）:
   - `Queries`: 数据库查询层
   - `LogtoConfigLibrary`: 配置读写
   - `CloudConnectionLibrary`: Cloud API 客户端
   - `ConnectorLibrary`: 连接器管理
   - `SubscriptionLibrary`: 订阅与配额（含 Redis 缓存）
   - `Libraries`: 聚合所有业务库（含 quota、hooks）
   - `BasicSentinel`: 安全哨兵

### 2.3 缓存失效：invalidateCache 的实际触发点

`invalidateCache()` 操作的是 `WellKnownCache`（SIE、connectors、signing-key-rotation-state 等），**不是** `TenantSubscriptionCache`。调用点在 `packages/core/src/routes/logto-config/index.ts` 中的三个路由处理器内（签名密钥轮换时）。订阅缓存有自己独立的 TTL 驱动失效机制。

## 三、权限守卫分层判定

### 3.1 全局第 1 层：认证守卫 (koaAuth)

**文件位置**: `packages/core/src/middleware/koa-auth/index.ts`

- 提取 Bearer Token → JWT 签名验证 → audience 检查 → `all` scope 检查
- 通过后注入 `ctx.auth = { type: sub === clientId ? 'app' : 'user', id: sub, scopes: new Set(scopes) }`
- 非生产环境支持 `development-user-id` header 跳过验证
- 跨租户代理：获取当前租户 JWKS + admin 租户 JWKS

### 3.2 全局第 2 层：租户状态守卫 (koaTenantGuard)

**文件位置**: `packages/core/src/middleware/koa-tenant-guard.ts`

- 仅云环境生效，OSS 直接跳过
- 查询 `tenants.findTenantMetadataById(tenantId).isSuspended`

### 3.3 全局第 3 层：Management API Hooks 中间件

**文件位置**: `packages/core/src/middleware/koa-management-api-hooks.ts`

此中间件不拒绝请求，而是注入 Hook 上下文并在请求完成后触发 hooks：

```typescript
ctx.appendDataHookContext = hooksContextManager.appendDataHookContext.bind(...);
ctx.appendExceptionHookContext = hooksContextManager.appendExceptionHookContext.bind(...);

try {
  await next();
  // 成功后：自动追加注册的 hook + 触发 data hooks
  const registeredDataHookContext = hooksContextManager.getRegisteredHookEventContext(ctx);
  if (registeredDataHookContext) hooksContextManager.appendDataHookContext(...);
  if (hooksContextManager.dataHookContextArray.length > 0) {
    void trySafe(hooks.triggerDataHooks(consoleLog, hooksContextManager));
  }
} finally {
  // 无论成功失败：触发 exception hooks（仅当有主动注册的异常上下文时）
  if (hooksContextManager.exceptionHookContextArray.length > 0) {
    void trySafe(hooks.triggerExceptionHooks(consoleLog, hooksContextManager));
  }
}
```

**自动 Hook 注册表**（`packages/schemas/src/foundations/jsonb-types/hooks.ts`）：

| 路由 | 触发事件 |
|------|---------|
| `POST /users` | `User.Created` |
| `PATCH /users/:userId` | `User.Data.Updated` |
| `PATCH /users/:userId/is-suspended` | `User.SuspensionStatus.Updated` |
| `POST /roles` | `Role.Created` |
| `DELETE /roles/:id` | `Role.Deleted` |
| `POST /organizations` | `Organization.Created` |
| `DELETE /organizations/:id` | `Organization.Deleted` |
| ... | ... |

自动 Hook 仅在请求成功时触发（`await next()` 之后），失败时不触发 data hooks。

### 3.4 按需守卫：配额守卫 (koaQuotaGuard + QuotaLibrary)

**文件位置**:
- 中间件: `packages/core/src/middleware/koa-quota-guard.ts`
- 核心逻辑: `packages/core/src/libraries/quota.ts`

**双重检查**：系统限制（硬上限）+ 订阅配额（软上限）

| 维度 | 系统限制 (SystemLimit) | 订阅配额 (SubscriptionQuota) |
|------|----------------------|---------------------------|
| 来源 | 订阅数据的 `systemLimit` 字段 | 订阅数据的 `quota` 字段 |
| 性质 | 硬上限（不可突破） | 软上限（付费计划可突破，仅上报） |
| 错误码 | `system_limit.limit_exceeded` | `subscription.limit_exceeded` |
| 付费计划豁免 | 不豁免 | Pro/Enterprise 豁免（仅上报 Cloud） |
| 类型 | 数值型 | 数值型 + 布尔型（功能开关） |

配额守卫的两种接入方式：

1. **middleware 级别**（SchemaRouter 的 `middlewares` 配置）：在 `koaGuard` 之前执行
2. **业务代码内调用**（`quota.guardTenantUsageByKey()`）：更灵活，可在业务逻辑中决定何时检查

**TenantUsageQuery 的请求级缓存**：`QuotaLibrary` 内部使用请求级 `Map` 避免同一请求中对同一 key+entityId 重复查询数据库。

### 3.5 按需守卫：Token 用量守卫 (koaTokenUsageGuard)

**文件位置**: `packages/core/src/middleware/koa-token-usage-guard.ts`

**不在 managementRouter 上**，仅挂载在 OIDC `/token` 端点、仅云环境生效。

### 3.6 按需守卫：输入输出守卫 (koaGuard)

**文件位置**: `packages/core/src/middleware/koa-guard.ts`

使用 Zod schema 验证请求 query/body/params/files，断言响应体和状态码。这不是权限层面的守卫，但它是请求进入业务逻辑前的常见拒绝点。

## 四、缓存机制

### 4.1 双层缓存架构

```
┌─────────────────────────────────────────────────────────────┐
│                      权限判定路径                             │
├──────────────────────┬──────────────────────────────────────┤
│  管理API配额守卫      │  OIDC /token Token用量守卫           │
│  QuotaLibrary        │  koaTokenUsageGuard                  │
│       │              │       │                              │
│       ▼              │       ▼                              │
│  SubscriptionLibrary │  SubscriptionLibrary                 │
│  .getSubscriptionData│  .getSubscriptionData                │
│       │              │       │                              │
│       ▼              │       ▼                              │
│  TenantSubscription  │  TenantSubscription                  │
│  Cache (Redis)       │  Cache (Redis) ← 同一实例            │
│                      │       │                              │
│                      │       ▼                              │
│                      │  TtlCache (进程内)                    │
│                      │  tokenUsageCache                     │
│                      │  (1小时本地缓存)                      │
└──────────────────────┴──────────────────────────────────────┘
```

### 4.2 BaseCache 基础设施

**文件位置**: `packages/core/src/caches/base-cache.ts`

- 缓存键格式: `{tenantId}:{type}:{key}`
- 默认过期时间: 30 分钟（1800 秒）
- `memoize`: 结果缓存 + `promiseCache` 防缓存击穿
- `mutate`: 成功后删除缓存

### 4.3 订阅数据缓存 (TenantSubscriptionCache + Redis)

**文件位置**:
- 缓存类: `packages/core/src/caches/tenant-subscription.ts`
- 库逻辑: `packages/core/src/libraries/subscription.ts`

**TTL 计算方法**：基于 `currentPeriodEnd` 动态计算：

```typescript
const maxSubscriptionCacheTtl = 24 * 60 * 60;  // 最大 24 小时

const getSubscriptionCacheExpiration = (currentPeriodEnd: string) => {
  const expiration = Math.floor((new Date(currentPeriodEnd).getTime() - Date.now()) / 1000);
  return Math.min(Math.max(expiration, 0), maxSubscriptionCacheTtl);
};
```

**缓存失效策略**：**没有显式的 `mutate` 或 `delete` 调用**，完全依赖 Redis TTL 过期：
1. TTL 到期自动失效
2. `currentPeriodEnd` 驱动：订阅周期结束时缓存恰好过期
3. Cloud 侧变更传播：最长需等 24 小时
4. `memoize` 防击穿

### 4.4 Token 用量缓存 (TtlCache + 进程内存)

**文件位置**: `packages/core/src/libraries/subscription.ts`

- 进程内 TtlCache（不走 Redis），最大 1 小时
- TTL 同样与 `currentPeriodEnd` 挂钩
- 缓存键: `{tenantId}:{from_date}:{to_date}:token-usage`

### 4.5 currentPeriodEnd 在权限判断中的核心角色

| 作用 | 关联缓存 | 影响 |
|------|---------|------|
| 订阅缓存 TTL | Redis TenantSubscriptionCache | 缓存精确在周期结束时过期 |
| Token 用量查询窗口 | 进程内 TtlCache | 确定查询时间范围 |
| Token 用量缓存 TTL | 进程内 TtlCache | 用量缓存也在周期结束时失效 |
| 付费计划判断 | 两者共用 | Pro/Enterprise 直接放行 |

```
Cloud API → Subscription (含 currentPeriodEnd)
                ├─→ Redis 缓存 (TTL = min(周期剩余秒数, 24h))
                └─→ Token 用量查询窗口 (from/to)
                         └─→ TtlCache (TTL = min(周期剩余毫秒数, 1h))
                                  └─→ tokenUsage vs tokenLimit → 429 or pass
```

## 五、越权拒绝路径与三类观测面

### 5.1 Exception Hooks 触发条件详解

**核心结论**：单纯的请求失败不会触发 exception hooks，必须由业务代码**主动调用** `ctx.appendExceptionHookContext()` 才会触发。

#### 两种触发场景对比

| 场景 | 是否触发 exception hooks | 说明 |
|------|------------------------|------|
| **请求失败但无主动调用** | ❌ 不触发 | 守卫拒绝、业务代码抛出 RequestError 等都不会触发 |
| **业务代码主动添加异常上下文** | ✅ 触发 | 只有调用了 `ctx.appendExceptionHookContext(event, context)` 才会在 finally 块中触发 |

**ExceptionHookEvent 类型**（`packages/schemas/src/foundations/jsonb-types/hooks.ts:51`）：
```typescript
export type ExceptionHookEvent = 'Identifier.Lockout';
```

**注意**：目前 ExceptionHookEvent 只有一个类型 `'Identifier.Lockout'`，这是一个故意的设计限制。

#### 实际触发代码（唯一位置）

**文件位置**: `packages/core/src/routes/experience/classes/libraries/sentinel-guard.ts:62-70`

```typescript
if (decision === SentinelDecision.Blocked) {
  // 主动添加异常上下文
  ctx.appendExceptionHookContext('Identifier.Lockout', {
    ...identifier,
  });
  // 然后抛出错误
  throw new RequestError({
    code: 'session.verification_blocked_too_many_attempts',
    // ...
  });
}
```

**触发位置说明**：
- 这个调用发生在 **Experience 路由**（前端体验 API）中，不是 managementRouter
- managementRouter 中**没有任何业务代码**调用 `appendExceptionHookContext`
- 因此，managementRouter 的所有拒绝场景都不会触发 exception hooks

#### managementRouter 中的 exception hooks 现状

虽然 `koaManagementApiHooks` 中间件注入了 `ctx.appendExceptionHookContext` 方法，但：

1. 没有业务代码调用这个方法
2. 因此 `exceptionHookContextArray` 始终为空
3. 因此 `finally` 块中的 `triggerExceptionHooks` 永远不会实际发送 Webhook

这是一个设计上的预留机制，目前仅在 Experience 路由中使用（用户锁定时）。

### 5.2 Hook 投递失败的处理路径

#### 5.2.1 sendWebhook 函数的异常捕获与 TriggerHook 日志

**文件位置**: `packages/core/src/libraries/hook/index.ts:46-87`

`sendWebhook` 函数在投递 Webhook 时会**捕获所有异常**，并将结果写入 `TriggerHook` 日志：

```typescript
const sendWebhook = async (hook, payload, consoleLog) => {
  const logEntry = new LogEntry(`TriggerHook.${payload.event}`);
  logEntry.append({ hookId: id, hookRequest: { body: json } });

  try {
    const response = await sendWebhookRequest({ ... });
    logEntry.append({ response: await parseResponse(response) });
  } catch (error: unknown) {
    logEntry.append({
      result: LogResult.Error,                          // 标记为失败
      response: conditional(error instanceof HTTPError && ...),
      error: String(normalizeError(error)),              // 记录错误信息
    });
  }

  // ✅ 无论成功失败，都写入 logs 表
  await insertLog({
    id: generateStandardId(),
    key: logEntry.key,
    payload: logEntry.payload,
  });
};
```

**关键特性**：
- ✅ **异常被捕获**：Webhook 投递失败不会影响原请求的响应
- ✅ **写入 TriggerHook 日志**：所有投递结果（成功/失败）都会写入数据库 `logs` 表
- ✅ **错误详情记录**：包含 `result: LogResult.Error`、`response`（如果是 HTTPError）、`error`（错误消息）
- ❌ **不触发 koaErrorHandler**：异常在 `sendWebhook` 内部被捕获，不会向外抛出
- ❌ **不触发 AppInsights**：`sendWebhook` 内部没有主动调用 `appInsights.trackException()`

#### 5.2.2 TriggerHook 日志与 Audit Log 的关系

**重要区分**：`TriggerHook.*` 日志属于 Webhook 日志，**不在 Audit Log 查询范围**。

**文件位置**: `packages/core/src/routes/log.ts:49-57`

Audit Log 查询接口的 `includeKeyPrefix` 仅包含：

```typescript
const includeKeyPrefix: AuditLogPrefix[] = [
  token.Type.ExchangeTokenBy,    // ExchangeTokenBy.*
  token.Type.RevokeToken,        // RevokeToken.*
  token.Type.RevokeGrants,       // RevokeGrants.*
  interaction.prefix,             // Interaction.*
  jwtCustomizer.prefix,           // JwtCustomizer.*
  saml.prefix,                    // SamlApplication.*
  LogKeyUnknown,                  // Unknown
];
```

**Webhook 日志前缀**（`packages/schemas/src/types/log/hook.ts`）：
```typescript
export enum Type {
  TriggerHook = 'TriggerHook',    // TriggerHook.*
}
```

**结论**：
- `TriggerHook.*` 日志存在于数据库中，但通过管理 API `/api/logs` 查询不到
- 需要直接查询数据库才能查看 Webhook 投递失败的记录

#### 5.2.3 trySafe 与异步触发

`koa-management-api-hooks.ts` 中 Hook 的触发使用了 `void trySafe(...)` 模式：

```typescript
// 成功路径
void trySafe(hooks.triggerDataHooks(consoleLog, hooksContextManager));

// finally 路径
void trySafe(hooks.triggerExceptionHooks(consoleLog, hooksContextManager));
```

**`trySafe` 函数行为**（从代码使用推断）：
- 捕获函数执行过程中的所有异常
- 返回 `Optional<T>`（即 `T | undefined`），异常时返回 `undefined`
- **不会向外抛出异常**，因此**不会触发 koaErrorHandler**

**`void` 关键字行为**：
- 丢弃 Promise，不等待异步操作完成
- 原请求不会被 Hook 投递延迟
- 如果 `trySafe` 内部的 Promise reject，`void` 会导致未处理的 Promise rejection（但 `trySafe` 应该已经捕获了异常）

**结论**：
- `trySafe` 捕获 `triggerDataHooks` 和 `triggerExceptionHooks` 执行过程中的异常
- **不会触发 koaErrorHandler**（因为异常被 trySafe 吞掉了）
- **不会触发 AppInsights**（因为 `trySafe` 内部没有上报，且异常没有到 koaErrorHandler）
- 但是 `sendWebhook` 内部的异常会被再次捕获并写入 TriggerHook 日志

#### 5.2.4 AppInsights 记录情况

Hook 投递失败时 **AppInsights 不会自动记录**，原因：

1. `sendWebhook` 内部捕获异常并写入日志，不向外抛出
2. `trySafe` 捕获 `triggerDataHooks` 执行中的异常，不向外抛出
3. `void` 关键字丢弃 Promise，即使有未捕获异常也不会到 koaErrorHandler
4. Hook 投递路径中没有主动调用 `appInsights.trackException()`

**唯一的观测路径**：通过数据库查询 `logs` 表中 `key LIKE 'TriggerHook.%'` 且 `payload.result = 'Error'` 的记录。

#### 5.2.5 Hook 投递失败的完整处理链

```
业务成功 → ctx.appendDataHookContext('User.Created', ...)
        → koaManagementApiHooks 成功路径
        → void trySafe(hooks.triggerDataHooks(...))
            → pMap(webhooks, sendWebhook, { concurrency: 10 })
                → sendWebhook(hook1, payload)
                    → try {
                        const response = await sendWebhookRequest(...)
                        logEntry.append({ response: ... })
                      } catch (error) {
                        logEntry.append({
                          result: LogResult.Error,    // ✅ 标记失败
                          response: ...,              // ✅ 记录响应（如有）
                          error: String(error),       // ✅ 记录错误
                        })
                      }
                    → await insertLog({ ... })        // ✅ 写入 TriggerHook 日志
                → sendWebhook(hook2, payload)
                    → ... (同上)
        → ✅ TriggerHook 日志写入数据库（包含失败详情）
        → ❌ AppInsights 无记录
        → ❌ Audit Log 查询接口不可见
```

### 5.3 六类拒绝/失败场景的观测面对比

以下分析针对 managementRouter 下的请求（管理 API）。

---

#### 场景 1：认证拒绝（koaAuth 401/403）

**触发条件**：
- JWT 无效/过期 → `auth.unauthorized` (401)
- 缺少 all scope → `auth.forbidden` (403)
- Token 缺少 sub → `auth.jwt_sub_missing` (401)

**执行路径**：
```
请求 → koaAuth (拒绝) → 抛出 RequestError
     → koaTenantGuard (跳过，因为 koaAuth 已抛出)
     → koaManagementApiHooks
         → catch 块接收错误，重新抛出
         → data hooks: ❌ 不触发
         → exception hooks: ❌ 不触发（无主动 appendExceptionHookContext 调用）
     → koaErrorHandler
         → AppInsights: ✅ 追踪（所有异常统一上报）
         → Audit Log: ❌ 不触发（managementRouter 未挂载 koaAuditLog）
         → Management Hooks (data): ❌ 不触发
         → Management Hooks (exception): ❌ 不触发
```

**观测面记录**：

| 观测面 | 记录状态 | 记录内容 |
|--------|---------|---------|
| **Audit Log** | ❌ 无 | managementRouter 未挂载 koaAuditLog |
| **Management Hooks (data)** | ❌ 无 | next() 未执行完成 |
| **Management Hooks (exception)** | ❌ 无 | 无主动 appendExceptionHookContext 调用 |
| **AppInsights** | ✅ 有 | `void appInsights.trackException(error, ...)` |
| **TriggerHook 日志** | ❌ 无 | 未触发任何 Hook 投递 |

---

#### 场景 2：租户拒绝（koaTenantGuard 403）

**触发条件**：
- 租户被暂停 → `subscription.tenant_suspended` (403)
- 仅云环境生效，OSS 跳过

**执行路径**：
```
请求 → koaAuth (通过)
     → koaTenantGuard (拒绝) → 抛出 RequestError
     → koaManagementApiHooks
         → catch 块接收错误，重新抛出
         → data hooks: ❌ 不触发
         → exception hooks: ❌ 不触发
     → koaErrorHandler
         → AppInsights: ✅ 追踪
         → Audit Log: ❌ 不触发
         → Management Hooks: ❌ 不触发
```

**观测面记录**：

| 观测面 | 记录状态 | 记录内容 |
|--------|---------|---------|
| **Audit Log** | ❌ 无 | managementRouter 未挂载 koaAuditLog |
| **Management Hooks (data)** | ❌ 无 | next() 未执行完成 |
| **Management Hooks (exception)** | ❌ 无 | 无主动 appendExceptionHookContext 调用 |
| **AppInsights** | ✅ 有 | 所有异常统一上报 |
| **TriggerHook 日志** | ❌ 无 | 未触发任何 Hook 投递 |

---

#### 场景 3：配额拒绝（QuotaLibrary 403）

**触发条件**：
- 系统限制超限 → `system_limit.limit_exceeded` (403)
- 订阅配额超限 → `subscription.limit_exceeded` (403)

**执行路径**（以业务代码内调用为例）：
```
请求 → koaAuth (通过)
     → koaTenantGuard (通过)
     → koaManagementApiHooks (try 块)
         → koaGuard (通过)
         → 业务代码: quota.guardTenantUsageByKey() → 403
         → 抛出 RequestError
     → koaManagementApiHooks (catch 块, 重新抛出)
         → data hooks: ❌ 不触发
         → exception hooks: ❌ 不触发（业务代码不调用 appendExceptionHookContext）
     → koaErrorHandler
         → AppInsights: ✅ 追踪
         → Audit Log: ❌ 不触发
         → Management Hooks: ❌ 不触发
```

**观测面记录**：

| 观测面 | 记录状态 | 记录内容 |
|--------|---------|---------|
| **Audit Log** | ❌ 无 | managementRouter 未挂载 koaAuditLog |
| **Management Hooks (data)** | ❌ 无 | next() 未执行完成 |
| **Management Hooks (exception)** | ❌ 无 | 无主动 appendExceptionHookContext 调用 |
| **AppInsights** | ✅ 有 | 所有异常统一上报 |
| **TriggerHook 日志** | ❌ 无 | 未触发任何 Hook 投递 |

---

#### 场景 4：参数校验失败（koaGuard 400）

**触发条件**：
- 请求参数 Zod 验证失败 → `guard.invalid_input` (400)

**执行路径**：
```
请求 → koaAuth (通过)
     → koaTenantGuard (通过)
     → koaManagementApiHooks (try 块)
         → koaGuard (参数验证失败) → 抛出 RequestError
     → koaManagementApiHooks (catch 块, 重新抛出)
         → data hooks: ❌ 不触发
         → exception hooks: ❌ 不触发
     → koaErrorHandler
         → AppInsights: ✅ 追踪
         → Audit Log: ❌ 不触发
         → Management Hooks: ❌ 不触发
```

**观测面记录**：

| 观测面 | 记录状态 | 记录内容 |
|--------|---------|---------|
| **Audit Log** | ❌ 无 | managementRouter 未挂载 koaAuditLog |
| **Management Hooks (data)** | ❌ 无 | next() 未执行完成 |
| **Management Hooks (exception)** | ❌ 无 | 无主动 appendExceptionHookContext 调用 |
| **AppInsights** | ✅ 有 | 所有异常统一上报 |
| **TriggerHook 日志** | ❌ 无 | 未触发任何 Hook 投递 |

---

#### 场景 5：业务异常（如 422 角色名重复等）

**触发条件**：
- 业务逻辑断言失败 → 如 `role.name_in_use` (422)
- 资源不存在 → 404

**执行路径**：
```
请求 → koaAuth (通过)
     → koaTenantGuard (通过)
     → koaManagementApiHooks (try 块)
         → koaGuard (通过)
         → 业务代码: assertThat(nameNotInUse) → 422
         → 抛出 RequestError
     → koaManagementApiHooks (catch 块, 重新抛出)
         → data hooks: ❌ 不触发
         → exception hooks: ❌ 不触发
     → koaErrorHandler
         → AppInsights: ✅ 追踪
         → Audit Log: ❌ 不触发
         → Management Hooks: ❌ 不触发
```

**观测面记录**：

| 观测面 | 记录状态 | 记录内容 |
|--------|---------|---------|
| **Audit Log** | ❌ 无 | managementRouter 未挂载 koaAuditLog |
| **Management Hooks (data)** | ❌ 无 | next() 未执行完成 |
| **Management Hooks (exception)** | ❌ 无 | 无主动 appendExceptionHookContext 调用 |
| **AppInsights** | ✅ 有 | 所有异常统一上报 |
| **TriggerHook 日志** | ❌ 无 | 未触发任何 Hook 投递 |

---

#### 场景 6：Hook 投递失败（业务成功但 Webhook 调用失败）

**触发条件**：
- 业务处理成功，触发了 Data Hook（如 `User.Created`）
- 外部 Webhook URL 无法访问或返回错误

**执行路径**：
```
请求 → koaAuth (通过)
     → koaTenantGuard (通过)
     → koaManagementApiHooks (try 块)
         → koaGuard (通过)
         → 业务代码: 成功创建用户
             → ctx.appendDataHookContext('User.Created', { user: ... })
         → await next() 返回（HTTP 200 响应已发送）
     → koaManagementApiHooks (成功路径)
         → ✅ 自动追加注册的 hook (POST /users → User.Created)
         → void trySafe(hooks.triggerDataHooks(...))
             → pMap(webhooks, sendWebhook, { concurrency: 10 })
                 → sendWebhook(hook1, payload) → 成功，写入 TriggerHook 日志
                 → sendWebhook(hook2, payload) → 失败
                     → catch 捕获异常
                     → logEntry.append({ result: LogResult.Error, error: 'Connection refused' })
                     → await insertLog({ ... })  // ✅ 写入 TriggerHook 日志
     → ✅ 原请求已返回 200 响应
     → ❌ AppInsights 无记录（异常被 sendWebhook 和 trySafe 双层捕获）
     → ❌ Audit Log 无记录（managementRouter 未挂载 koaAuditLog，且 TriggerHook 不在查询范围）
```

**观测面记录**：

| 观测面 | 记录状态 | 记录内容 |
|--------|---------|---------|
| **Audit Log** | ❌ 无 | managementRouter 未挂载 koaAuditLog；且 TriggerHook 不在 Audit Log 查询范围 |
| **Management Hooks (data)** | ✅ 投递尝试 | 已尝试投递，但外部 Webhook 返回错误 |
| **Management Hooks (exception)** | ❌ 无 | 业务成功路径，无异常上下文 |
| **AppInsights** | ❌ 无 | 异常被 sendWebhook 和 trySafe 双层捕获，未到达 koaErrorHandler |
| **TriggerHook 日志** | ✅ 有 | 数据库 `logs` 表中有 `TriggerHook.User.Created` 记录，`payload.result = 'Error'`，包含错误详情 |

---

### 5.4 六类场景观测面总览

| 场景 | Audit Log | Management Hooks (data) | Management Hooks (exception) | AppInsights | TriggerHook 日志 |
|------|-----------|------------------------|-----------------------------|-------------|-----------------|
| 认证拒绝（401/403） | ❌ 无 | ❌ 无 | ❌ 无 | ✅ 有 | ❌ 无 |
| 租户拒绝（403） | ❌ 无 | ❌ 无 | ❌ 无 | ✅ 有 | ❌ 无 |
| 配额拒绝（403） | ❌ 无 | ❌ 无 | ❌ 无 | ✅ 有 | ❌ 无 |
| 参数校验失败（400） | ❌ 无 | ❌ 无 | ❌ 无 | ✅ 有 | ❌ 无 |
| 业务异常（422/404） | ❌ 无 | ❌ 无 | ❌ 无 | ✅ 有 | ❌ 无 |
| Hook 投递失败 | ❌ 无 | ✅ 投递尝试 | ❌ 无 | ❌ 无 | ✅ 有（需直接查库） |
| **业务成功** | ❌ 无 | ✅ 投递 | ❌ 无 | ❌ 无 | ✅ 有（成功记录） |

### 5.5 三类观测面的设计边界与定位

| 观测面 | 定位 | 覆盖范围 | 触发方式 | 数据存储 |
|--------|------|---------|---------|---------|
| **Audit Log** | 身份安全审计 | 认证相关路由（OIDC/Experience/Interaction） | `koaAuditLog` 中间件 + 业务代码 `ctx.createLog()` | 数据库 `logs` 表 |
| **Management Hooks** | 数据变更通知 | managementRouter + userRouter | 主动 `ctx.appendDataHookContext()` + 自动注册 | 外部 Webhook URL |
| **AppInsights** | 全局异常监控 | 所有路由 | `koaErrorHandler` 统一上报 + 中间件主动上报 | Azure AppInsights |
| **TriggerHook 日志** | Webhook 投递审计 | 所有触发 Hook 的请求 | `sendWebhook` 内部自动写入 | 数据库 `logs` 表（不在 Audit Log 查询范围） |

**关键设计决策**：
- 管理 API 的拒绝事件不在审计日志中记录（因为未挂载 koaAuditLog）
- 管理 API 的数据变更成功时会触发 Management Hooks（data hooks）
- 所有异常（包括所有拒绝场景）都会在 AppInsights 中留痕
- exception hooks 目前仅在 Experience 路由中使用（用户锁定场景），managementRouter 中预留但未实际使用
- Hook 投递失败仅在 TriggerHook 日志中记录，不在 AppInsights 和 Audit Log 中留痕

### 5.6 AppInsights 的统一覆盖

`koaErrorHandler` 在 Tenant 级 Koa app 上全局挂载（`packages/core/src/tenants/Tenant.ts:125`），是**所有异常的最终兜底观测面**：

```typescript
// packages/core/src/middleware/koa-error-handler.ts
try {
  await next();
} catch (error: unknown) {
  // 所有异常都上报 AppInsights
  void appInsights.trackException(error, buildAppInsightsTelemetry(ctx));
  // ... 处理 HTTP 响应
}
```

此外，以下位置也会主动上报 AppInsights：
- `koa-guard.ts`: 响应状态码断言失败（生产环境仅告警，不抛出）
- `koa-token-usage-guard.ts`: 非预期的意外错误（不阻断请求时）
- `koa-oidc-error-handler.ts`: OIDC 错误
- OIDC 事件监听器 `server_error`

**注意**：Hook 投递失败不会到达 AppInsights，因为异常被 `sendWebhook` 和 `trySafe` 双层捕获。

## 六、关键决策点

### 6.1 Scope 设计决策

**决策**: 管理 API 使用单一 `all` scope

**权衡**:
- ✅ 简化权限模型
- ⚠️ 粒度较粗，细粒度控制由 Cloud 侧角色分配和配额限制实现

### 6.2 Exception Hooks 触发机制决策

**决策**: exception hooks 仅在业务代码主动调用 `appendExceptionHookContext` 时触发

**理由**:
- 避免所有错误都触发 Webhook 导致噪声过大
- 目前仅 `Identifier.Lockout` 一个事件类型，按需触发
- managementRouter 中预留接口但暂不使用，未来可扩展

### 6.3 Hook 投递失败的静默处理决策

**决策**: Webhook 投递失败仅写入 TriggerHook 日志，不触发 AppInsights 告警

**理由**:
- Webhook 是外部依赖，失败不应影响原请求
- 避免因外部服务故障导致 AppInsights 告警风暴
- 但缺乏主动告警机制，需用户定期查询数据库或实现自定义监控

### 6.4 TriggerHook 日志与 Audit Log 分离决策

**决策**: `TriggerHook.*` 日志写入数据库但不纳入 Audit Log 查询范围

**理由**:
- Audit Log 聚焦于身份安全事件
- Webhook 投递日志属于运维级数据，量可能较大
- 但降低了可观测性，用户无法通过管理 API 查看 Webhook 失败记录

### 6.5 管理 API 拒绝事件不留审计日志决策

**决策**: managementRouter 不挂载 `koaAuditLog`

**权衡**:
- ✅ 减少数据库写入压力
- ✅ 审计日志聚焦于身份认证事件
- ⚠️ 管理操作拒绝无法通过审计日志追溯，需依赖 AppInsights

### 6.6 AppInsights 作为统一观测面决策

**决策**: 所有异常通过 `koaErrorHandler` 统一上报 AppInsights

**理由**:
- 保证异常可观测性的底线
- 与审计日志、Webhook 形成互补
- 生产环境可快速排查问题

### 6.7 配额守卫两种接入方式的权衡

**middleware 级别**（如 `koaQuotaGuard`）：
- 在 `koaGuard` 之前执行，更早拒绝
- 拒绝时不会触发 data hooks（因为 next() 未完成）
- 配额检查与路由声明一体化，易于文档化

**业务代码内调用**（如 `quota.guardTenantUsageByKey()`）：
- 更灵活，可根据业务逻辑决定何时检查
- 可传 `consumeUsageCount` 和 `entityId`
- 位置不固定，需要阅读业务代码才能了解配额检查逻辑

### 6.8 订阅缓存 TTL 决策

**决策**: 基于 `currentPeriodEnd` 动态计算，上限 24 小时

**理由**: 周期结束时缓存自然失效，无需失效推送。权衡：Cloud 侧变更最长需 24 小时生效。

## 七、代码路径索引

| 功能模块 | 文件路径 |
|---------|---------|
| 租户上下文定义 | `packages/core/src/tenants/TenantContext.ts` |
| 租户实例创建 | `packages/core/src/tenants/Tenant.ts` |
| 路由初始化（中间件挂载） | `packages/core/src/routes/init.ts` |
| 认证守卫 | `packages/core/src/middleware/koa-auth/index.ts` |
| 租户守卫 | `packages/core/src/middleware/koa-tenant-guard.ts` |
| Management API Hooks 中间件 | `packages/core/src/middleware/koa-management-api-hooks.ts` |
| Hook 上下文管理器 | `packages/core/src/libraries/hook/context-manager.ts` |
| Hook 核心逻辑（触发 Webhook + TriggerHook 日志） | `packages/core/src/libraries/hook/index.ts` |
| 管理 API Hook 注册表 | `packages/schemas/src/foundations/jsonb-types/hooks.ts` |
| Sentinel Guard（Identifier.Lockout 触发） | `packages/core/src/routes/experience/classes/libraries/sentinel-guard.ts` |
| Experience Interaction Hooks | `packages/core/src/routes/experience/middleware/koa-experience-interaction-hooks.ts` |
| 配额守卫中间件 | `packages/core/src/middleware/koa-quota-guard.ts` |
| 配额判定核心 | `packages/core/src/libraries/quota.ts` |
| Token 用量守卫 | `packages/core/src/middleware/koa-token-usage-guard.ts` |
| 订阅库（缓存核心） | `packages/core/src/libraries/subscription.ts` |
| 输入输出守卫 | `packages/core/src/middleware/koa-guard.ts` |
| 全局错误处理 | `packages/core/src/middleware/koa-error-handler.ts` |
| 审计日志中间件 | `packages/core/src/middleware/koa-audit-log.ts` |
| 审计日志查询接口 | `packages/core/src/routes/log.ts` |
| LogKey 类型定义 | `packages/schemas/src/types/log/index.ts` |
| Webhook LogKey 类型定义 | `packages/schemas/src/types/log/hook.ts` |
| 基础缓存 | `packages/core/src/caches/base-cache.ts` |
| 订阅缓存 | `packages/core/src/caches/tenant-subscription.ts` |
| SchemaRouter | `packages/core/src/utils/SchemaRouter.ts` |
| 错误处理 | `packages/core/src/errors/RequestError/index.ts` |
| 管理 API Scope 定义 | `packages/schemas/src/seeds/management-api.ts` |
| 角色路由（配额接入示例） | `packages/core/src/routes/role.ts` |
