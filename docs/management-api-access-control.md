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
- `koaManagementApiHooks` 在 `try/finally` 中运行，**即使请求失败也会触发 exception hooks**
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
  │   └─ finally: 触发 exception hooks
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
  // 无论成功失败：触发 exception hooks
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

自动 Hook 仅在请求成功时触发（`await next()` 之后），失败时不触发 data hooks，但可能触发 exception hooks（如果业务代码主动调用了 `appendExceptionHookContext`）。

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

### 5.1 错误类型与状态码

| 拒绝点 | 错误码 | HTTP 状态码 | 拒绝位置 |
|--------|--------|------------|---------|
| JWT 无效/过期 | `auth.unauthorized` | 401 | 全局: koaAuth |
| 缺少 all scope | `auth.forbidden` | 403 | 全局: koaAuth |
| Token 缺少 sub | `auth.jwt_sub_missing` | 401 | 全局: koaAuth |
| 租户暂停 | `subscription.tenant_suspended` | 403 | 全局: koaTenantGuard |
| 系统限制超限 | `system_limit.limit_exceeded` | 403 | 按需: QuotaLibrary |
| 订阅配额超限 | `subscription.limit_exceeded` | 403 | 按需: QuotaLibrary |
| Token 用量超限 | `auth.exceed_token_limit` | 429 | 按需: koaTokenUsageGuard |
| 参数验证失败 | `guard.invalid_input` | 400 | 按需: koaGuard |
| 响应状态码不符 | StatusCodeError (500) | - | 按需: koaGuard |

### 5.2 三类观测面概述

| 观测面 | 触发机制 | 数据存储 | 覆盖范围 |
|--------|---------|---------|---------|
| **Audit Log** | `koaAuditLog` 中间件 + `ctx.createLog()` | 数据库 `logs` 表 | 仅身份认证路由 |
| **Management Hooks** | `koaManagementApiHooks` 中间件 | 外部 Webhook URL | managementRouter + userRouter |
| **AppInsights** | `koaErrorHandler` + 各中间件主动上报 | Azure AppInsights | 所有路由 |

### 5.3 各拒绝场景的观测面触发详情

#### 场景 A：全局守卫拒绝（koaAuth 401/403、koaTenantGuard 403）

```
请求 → koaAuth (拒绝) → 抛出 RequestError
     → koaTenantGuard (跳过，因为 koaAuth 已抛出)
     → koaManagementApiHooks (catch 块)
         → data hooks: 不触发 (entries 为空)
         → exception hooks: 不触发 (无 appendExceptionHookContext 调用)
     → koaErrorHandler
         → AppInsights: ✅ 追踪 (所有异常)
         → Audit Log: ❌ 不触发 (managementRouter 未挂载 koaAuditLog)
         → Management Hooks (data): ❌ 不触发 (next() 未执行)
         → Management Hooks (exception): ❌ 不触发 (无主动 appendExceptionHookContext)
```

**结论**：全局守卫拒绝仅在 AppInsights 中留痕。

#### 场景 B：按需守卫拒绝（koaQuotaGuard 403、koaGuard 400）

```
请求 → koaAuth (通过)
     → koaTenantGuard (通过)
     → koaManagementApiHooks (try 块)
         → koaQuotaGuard (拒绝) → 抛出 RequestError
         或
         → koaGuard (参数验证失败) → 抛出 RequestError
     → koaManagementApiHooks (catch 块, 重新抛出)
         → data hooks: ❌ 不触发 (next() 未完成)
         → exception hooks: ❌ 不触发 (无主动 appendExceptionHookContext)
     → koaErrorHandler
         → AppInsights: ✅ 追踪
         → Audit Log: ❌ 不触发
         → Management Hooks (data): ❌ 不触发
         → Management Hooks (exception): ❌ 不触发
```

**结论**：按需守卫拒绝同样仅在 AppInsights 中留痕。

#### 场景 C：业务逻辑拒绝（如角色名重复 422、配额检查 403）

```
请求 → koaAuth (通过)
     → koaTenantGuard (通过)
     → koaManagementApiHooks (try 块)
         → koaGuard (通过)
         → 业务代码: quota.guardTenantUsageByKey() → 403
         或 业务代码: assertThat(nameNotInUse) → 422
         → 抛出 RequestError
     → koaManagementApiHooks (catch 块, 重新抛出)
         → data hooks: ❌ 不触发
         → exception hooks: ❌ 不触发 (业务代码通常不调用 appendExceptionHookContext)
     → koaErrorHandler
         → AppInsights: ✅ 追踪
         → Audit Log: ❌ 不触发
         → Management Hooks: ❌ 不触发
```

**结论**：业务逻辑拒绝仅在 AppInsights 中留痕。

#### 场景 D：业务成功

```
请求 → koaAuth (通过)
     → koaTenantGuard (通过)
     → koaManagementApiHooks (try 块)
         → koaGuard (通过)
         → 业务代码: 成功
             → 可能调用 ctx.appendDataHookContext('User.Created', {...})
         → await next() 返回
     → koaManagementApiHooks (成功路径)
         → 自动追加注册的 hook (如 POST /users → User.Created)
         → data hooks: ✅ 触发 (业务主动 + 自动注册)
         → finally: exception hooks: 不触发 (无 exception 上下文)
     → koaErrorHandler (不介入)
         → AppInsights: ❌ 无异常可追踪
         → Audit Log: ❌ 不触发
         → Management Hooks (data): ✅ 触发
```

**结论**：业务成功时仅 Management Hooks 触发。

#### 场景 E：OIDC /token 路由拒绝

```
请求 → koaAuditLog (注入 createLog)
     → koaTokenUsageGuard (拒绝: 429)
     → koaAuditLog (catch 块)
         → entries: 取决于是否已调用 createLog
         → 如果有 entries → ✅ 追加 LogResult.Error
         → 如果无 entries → ❌ 无日志
     → koaErrorHandler / koaOidcErrorHandler
         → AppInsights: ✅ 追踪
         → Audit Log: ⚠️ 取决于事件监听器是否已调用 createLog
```

**注意**：OIDC 路由中 `createLog` 主要在事件监听器中调用（如 `grant.success`、`grant.error`），而非在守卫层。如果 Token 用量守卫在事件监听器触发之前就拒绝了请求，则不会有审计日志。

#### 场景 F：koaGuard 响应状态码断言失败

**文件位置**: `packages/core/src/middleware/koa-guard.ts:191-209`

```typescript
const assertStatusCode = (value: number) => {
  if (Array.isArray(status) ? status.includes(value) : status === value) return;
  if (EnvSet.values.isProduction) {
    consoleLog.warn('Unexpected status code:', value, 'expected:', status);
    void appInsights.trackException(new StatusCodeError(status, value), ...);
    return;  // 生产环境仅告警，不抛出
  }
  throw new StatusCodeError(status, value);  // 非生产环境抛出
};
```

**结论**：koaGuard 的状态码断言失败在生产环境仅上报 AppInsights，不影响请求。

### 5.4 观测面触发矩阵

| 拒绝场景 | Audit Log | Management Hooks (data) | Management Hooks (exception) | AppInsights |
|---------|-----------|------------------------|-----------------------------|-------------|
| koaAuth 401/403 | ❌ | ❌ | ❌ | ✅ |
| koaTenantGuard 403 | ❌ | ❌ | ❌ | ✅ |
| koaQuotaGuard 403 | ❌ | ❌ | ❌ | ✅ |
| koaGuard 400 | ❌ | ❌ | ❌ | ✅ |
| QuotaLibrary 业务内 403 | ❌ | ❌ | ❌ | ✅ |
| 业务逻辑 422 | ❌ | ❌ | ❌ | ✅ |
| Token 用量 429 | ⚠️ 取决于 | N/A | N/A | ✅ |
| koaGuard 状态码断言 | ❌ | ❌ | ❌ | ✅(生产) / 抛出(非生产) |
| 业务成功 | ❌ | ✅ | ❌ | ❌ |
| OIDC Token 交换成功 | ✅ | N/A | N/A | ❌ |

### 5.5 Audit Log 与 Management Hooks 的设计边界

**Audit Log** (`koaAuditLog`)：
- 覆盖：OIDC / Experience / Interaction / SAML / Authn 路由
- 内容：身份认证事件（登录、Token 交换、MFA 等）
- 存储：数据库 `logs` 表
- 触发方式：业务代码主动 `ctx.createLog(key)`

**Management Hooks** (`koaManagementApiHooks`)：
- 覆盖：managementRouter + userRouter
- 内容：数据变更事件（用户创建、角色删除等）+ 异常事件
- 存储：外部 Webhook URL
- 触发方式：业务代码主动 `ctx.appendDataHookContext()` + 自动注册表

**两者互不重叠**：审计日志和 Management Hooks 服务于不同的观测需求，覆盖不同的路由集合。

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
- `koa-guard.ts`: 响应状态码断言失败（生产环境）
- `koa-token-usage-guard.ts`: 非预期的意外错误（不阻断请求时）
- `koa-oidc-error-handler.ts`: OIDC 错误
- OIDC 事件监听器 `server_error`

## 六、关键决策点

### 6.1 Scope 设计决策

**决策**: 管理 API 使用单一 `all` scope

**权衡**:
- ✅ 简化权限模型
- ⚠️ 粒度较粗，细粒度控制由 Cloud 侧角色分配和配额限制实现

### 6.2 配额守卫两种接入方式的权衡

**middleware 级别**（如 `koaQuotaGuard`）：
- 在 `koaGuard` 之前执行，更早拒绝
- 拒绝时不会触发 data hooks（因为 next() 未完成）
- 配额检查与路由声明一体化，易于文档化

**业务代码内调用**（如 `quota.guardTenantUsageByKey()`）：
- 更灵活，可根据业务逻辑决定何时检查
- 可传 `consumeUsageCount` 和 `entityId`
- 位置不固定，需要阅读业务代码才能了解配额检查逻辑

### 6.3 Management Hooks 仅触发成功路径

**决策**: data hooks 仅在 `await next()` 成功完成后触发

**理由**:
- 避免部分失败的请求触发不完整的 Webhook
- 注册的自动 Hook 也仅在成功后追加
- Exception hooks 通过 `finally` 块保证触发，但需要业务代码主动调用 `appendExceptionHookContext`

### 6.4 审计日志与 Management Hooks 互不覆盖

**决策**: Audit Log 覆盖认证流程，Management Hooks 覆盖管理操作

**权衡**:
- ✅ 职责清晰，避免重复记录
- ⚠️ 管理操作（如删除用户）无审计日志记录
- ⚠️ 认证流程（如 Token 交换）无 Management Hooks 触发

### 6.5 订阅缓存 TTL 决策

**决策**: 基于 `currentPeriodEnd` 动态计算，上限 24 小时

**理由**: 周期结束时缓存自然失效，无需失效推送。权衡：Cloud 侧变更最长需 24 小时生效。

### 6.6 Token 用量守卫容错决策

**决策**: 意外错误不阻断请求，仅上报 AppInsights

**理由**: Token 发放是核心功能，不应因配额检查意外故障中断。仅明确的 429 阻断。

## 七、代码路径索引

| 功能模块 | 文件路径 |
|---------|---------|
| 租户上下文定义 | `packages/core/src/tenants/TenantContext.ts` |
| 租户实例创建 | `packages/core/src/tenants/Tenant.ts` |
| 路由初始化（中间件挂载） | `packages/core/src/routes/init.ts` |
| 认证守卫 | `packages/core/src/middleware/koa-auth/index.ts` |
| OIDC 认证守卫 | `packages/core/src/middleware/koa-auth/koa-oidc-auth.ts` |
| 租户守卫 | `packages/core/src/middleware/koa-tenant-guard.ts` |
| Management API Hooks 中间件 | `packages/core/src/middleware/koa-management-api-hooks.ts` |
| Hook 上下文管理器 | `packages/core/src/libraries/hook/context-manager.ts` |
| Hook 核心逻辑（触发 Webhook） | `packages/core/src/libraries/hook/index.ts` |
| 管理 API Hook 注册表 | `packages/schemas/src/foundations/jsonb-types/hooks.ts` |
| 配额守卫中间件 | `packages/core/src/middleware/koa-quota-guard.ts` |
| 配额判定核心 | `packages/core/src/libraries/quota.ts` |
| Token 用量守卫 | `packages/core/src/middleware/koa-token-usage-guard.ts` |
| 订阅库（缓存核心） | `packages/core/src/libraries/subscription.ts` |
| 输入输出守卫 | `packages/core/src/middleware/koa-guard.ts` |
| 全局错误处理 | `packages/core/src/middleware/koa-error-handler.ts` |
| 审计日志中间件 | `packages/core/src/middleware/koa-audit-log.ts` |
| OIDC 事件监听器 | `packages/core/src/event-listeners/index.ts` |
| Grant 审计日志 | `packages/core/src/event-listeners/grant.ts` |
| 基础缓存 | `packages/core/src/caches/base-cache.ts` |
| 订阅缓存 | `packages/core/src/caches/tenant-subscription.ts` |
| SchemaRouter | `packages/core/src/utils/SchemaRouter.ts` |
| 错误处理 | `packages/core/src/errors/RequestError/index.ts` |
| 管理 API Scope 定义 | `packages/schemas/src/seeds/management-api.ts` |
| 订阅类型定义 | `packages/core/src/utils/subscription/types.ts` |
| OIDC 初始化 | `packages/core/src/oidc/init.ts` |
| 角色路由（配额接入示例） | `packages/core/src/routes/role.ts` |
