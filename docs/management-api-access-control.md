# 后台管理接口访问控制分层架构

## 概述

Logto 后台管理接口（Management API）采用多层级的访问控制架构，通过租户上下文注入、多层权限守卫、双层缓存机制、越权拒绝和审计日志五个核心模块的协同工作，实现安全、高效的访问控制。

## 一、分层架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                     客户端请求                                   │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│  第一层：租户上下文注入 (Tenant Context Injection)               │
│  - 租户识别与实例创建 (Tenant.create)                           │
│  - 数据库连接池初始化                                           │
│  - 依赖注入（Queries/Libraries/Caches）                        │
└───────────────────────────────┬─────────────────────────────────┘
                                │
          ┌─────────────────────┴──────────────────────┐
          │                                            │
┌─────────▼──────────┐                     ┌──────────▼──────────┐
│  Management API    │                     │  OIDC /token 端点    │
│  路由树             │                     │                      │
├────────────────────┤                     ├──────────────────────┤
│ 2a. koaAuth        │                     │ 2b. koaAuditLog      │
│     JWT验证+scope  │                     │     审计日志上下文    │
│ 3a. koaTenantGuard │                     │ 3b. koaTokenUsageGuard│
│     租户暂停检查    │                     │     Token用量守卫     │
│ 4a. koaQuotaGuard  │                     │                      │
│     配额限制检查    │                     │                      │
│ 5a. koaGuard       │                     │                      │
│     输入输出验证    │                     │                      │
└────────────────────┘                     └──────────────────────┘
```

**关键区分**：管理 API 和 OIDC /token 端点是两条独立的守卫链路。管理 API 走 `koaAuth → koaTenantGuard → koaQuotaGuard → koaGuard`；OIDC /token 端点走 `koaAuditLog → koaTokenUsageGuard`，并且 Token 用量守卫仅挂载在云环境。

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
3. **环境初始化**: `EnvSet` 加载配置（包括 OIDC issuer、JWKS、admin URL 等）
4. **依赖实例化**（在 `Tenant` 构造函数中一次性完成）:
   - `Queries`: 数据库查询层
   - `LogtoConfigLibrary`: 配置读写
   - `CloudConnectionLibrary`: Cloud API 客户端
   - `ConnectorLibrary`: 连接器管理
   - `SubscriptionLibrary`: 订阅与配额（含 Redis 缓存）
   - `Libraries`: 聚合所有业务库（含 quota）
   - `BasicSentinel`: 安全哨兵

```typescript
// Tenant 构造函数中组装 tenantContext 对象
const tenantContext: TenantContext = {
  id,
  provider,
  wellKnownCache: this.wellKnownCache,
  queries,
  logtoConfigs,
  cloudConnection,
  connectors,
  libraries,
  envSet,
  sentinel,
  invalidateCache: this.invalidateCache.bind(this),
  scheduleSigningKeyRotation: this.scheduleSigningKeyRotation.bind(this),
};
```

### 2.3 路由挂载与上下文传递

**文件位置**: `packages/core/src/routes/init.ts`

租户上下文通过 `initApis` 函数传递给所有路由。管理 API 路由（`managementRouter`）在挂载时即注入三层全局中间件：

```typescript
const managementRouter: ManagementApiRouter = new Router();
managementRouter.use(koaAuth(tenant.envSet, getManagementApiResourceIndicator(tenant.id)));
managementRouter.use(koaTenantGuard(tenant.id, tenant.queries));
managementRouter.use(koaManagementApiHooks(tenant.libraries.hooks));
```

**OIDC 路由**在 `packages/core/src/oidc/init.ts` 中独立挂载，中间件链不同：

```typescript
// packages/core/src/oidc/init.ts
oidc.use(koaAuditLog(queries));
// ...
if (EnvSet.values.isCloud) {
  oidc.use(koaTokenUsageGuard(subscription));
}
```

### 2.4 缓存失效：invalidateCache 的实际触发点

`invalidateCache()` 不是权限判定路径上的常规步骤，而是在签名密钥轮换等配置变更后触发的运维操作：

**文件位置**: `packages/core/src/tenants/Tenant.ts:313`

```typescript
public async invalidateCache() {
  const tenantCacheExpiresAt = Date.now();
  const signingKeyRotationState =
    await this.queries.logtoConfigs.setTenantCacheExpiresAt(tenantCacheExpiresAt);
  await syncSigningKeyRotationStateCache(this.wellKnownCache, signingKeyRotationState);
}
```

调用点在 `packages/core/src/routes/logto-config/index.ts` 中的三个路由处理器内：
- 更新 OIDC 签名密钥配置时
- 轮换签名密钥时

它操作的是 `WellKnownCache`（存储 SIE、connectors、signing-key-rotation-state 等），**不是** `TenantSubscriptionCache`。订阅缓存有自己独立的 TTL 驱动失效机制。

## 三、权限守卫分层判定

### 3.1 第一层：认证守卫 (koaAuth)

**文件位置**: `packages/core/src/middleware/koa-auth/index.ts`

**核心职责**:
- 提取 Bearer Token
- 验证 JWT 签名（使用本地 JWKS + 可选的 admin tenant JWKS）
- 检查受众（audience）匹配 Management API Resource Indicator
- 验证 Scope 包含 `all`

**判定逻辑**:

```typescript
const { sub, clientId, scopes } = await verifyBearerTokenFromRequest(
  envSet,
  ctx.request,
  audience
);

assertThat(
  scopes.includes(PredefinedScope.All),
  new RequestError({ code: 'auth.forbidden', status: 403 })
);

ctx.auth = {
  type: sub === clientId ? 'app' : 'user',  // M2M 应用 vs 人类用户
  id: sub,
  scopes: new Set(scopes),
};
```

**Token 验证流程**:
1. 从 Authorization header 提取 Bearer Token
2. 非生产环境支持 `development-user-id` header 跳过验证
3. 获取 JWKS：当前租户公钥 + admin 租户公钥（跨租户代理场景）
4. 使用 `jose.jwtVerify` 验证签名、签发者、受众
5. 检查 `sub` 声明存在
6. 验证 `all` scope 存在 → 否则 403

### 3.2 第二层：租户状态守卫 (koaTenantGuard)

**文件位置**: `packages/core/src/middleware/koa-tenant-guard.ts`

**核心职责**:
- 检查租户是否被暂停（`isSuspended`）
- 仅在云环境（`isCloud`）生效，OSS 直接跳过

```typescript
if (!isCloud) {
  return next();
}
const { isSuspended } = await tenants.findTenantMetadataById(tenantId);
if (isSuspended) {
  throw new RequestError('subscription.tenant_suspended', 403);
}
```

### 3.3 第三层：配额守卫 (koaQuotaGuard + QuotaLibrary)

**文件位置**: 
- 中间件: `packages/core/src/middleware/koa-quota-guard.ts`
- 核心逻辑: `packages/core/src/libraries/quota.ts`

**两层配额检查**:

配额守卫执行**双重检查**：先查系统限制（硬上限），再查订阅配额（软上限）。

```typescript
guardTenantUsageByKey = async (key, { entityId, consumeUsageCount = 1 } = {}) => {
  if (!isCloud) return;                    // OSS 跳过
  if (this.tenantId === adminTenantId) return;  // admin 租户豁免

  const subscriptionData = await this.subscription.getSubscriptionData();  // 命中 Redis 缓存
  const tenantUsageQuery = new TenantUsageQuery(this.tenantId, this.queries, this.connectorLibrary);

  if (isSystemUsageKey(key)) {
    await this.assertSystemLimit({ key, entityId, subscriptionData, tenantUsageQuery, consumeUsageCount });
  }
  if (isQuotaUsageKey(key)) {
    await this.assertQuotaLimit({ key, entityId, subscriptionData, tenantUsageQuery, consumeUsageCount });
  }
};
```

**系统限制 vs 订阅配额**:

| 维度 | 系统限制 (SystemLimit) | 订阅配额 (SubscriptionQuota) |
|------|----------------------|---------------------------|
| 来源 | 订阅数据中的 `systemLimit` 字段 | 订阅数据中的 `quota` 字段 |
| 性质 | 硬上限（不可突破） | 软上限（付费计划可突破，仅上报） |
| 错误码 | `system_limit.limit_exceeded` | `subscription.limit_exceeded` |
| 付费计划豁免 | 不豁免 | Pro/Enterprise 豁免（仅上报 Cloud） |
| 类型 | 数值型 | 数值型 + 布尔型（功能开关） |

**布尔型配额示例**（功能开关类）:

```typescript
if (isBooleanQuotaUsageKey(key)) {
  assertThat(limit, new RequestError({ code: 'subscription.limit_exceeded', status: 403, data: { key } }));
  return;
}
```

**数值型配额示例**:

```typescript
if (isNumericQuotaUsageKey(key)) {
  const usage = await tenantUsageQuery.get(key, entityId);
  assertThat(
    usage + consumeUsageCount <= limit,
    new RequestError({ code: 'subscription.limit_exceeded', status: 403, data: { key, limit, usage } })
  );
}
```

**TenantUsageQuery 的请求级缓存**:

`TenantUsageQuery` 是一个请求级别的内存缓存，避免同一请求中对同一 key+entityId 重复查询数据库：

```typescript
class TenantUsageQuery {
  private readonly cache = new Map<string, number>();

  get = async (key, entityId) => {
    const cacheKey = entityId ? `${key}:${entityId}` : key;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const usage = await this.getTenantUsage(key, entityId);
    this.cache.set(cacheKey, usage);
    return usage;
  };
}
```

**SchemaRouter 中的应用** (组织路由示例):

```typescript
const router = new SchemaRouter(Organizations, organizations, {
  middlewares: [
    {
      middleware: koaQuotaGuard({ key: 'organizationsLimit', quota }),
      scope: 'native',
      method: ['post', 'put'],       // 仅在创建/替换时检查
      status: [403],
    },
    {
      middleware: koaReportSubscriptionUpdates({ key: 'organizationsLimit', quota }),
      scope: 'native',
      method: ['post', 'put', 'delete'],  // 变更后上报 Cloud
    },
  ],
});
```

### 3.4 第四层：Token 用量守卫 (koaTokenUsageGuard)

**文件位置**: `packages/core/src/middleware/koa-token-usage-guard.ts`

**挂载位置**: 仅在 OIDC `/token` 端点、仅云环境生效。

```typescript
// packages/core/src/oidc/init.ts
if (EnvSet.values.isCloud) {
  oidc.use(koaTokenUsageGuard(subscription));
}
```

**判定逻辑**:

```typescript
if (path !== '/token') return next();
if (subscriptionLibrary.tenantId === adminTenantId) return next();  // admin 租户豁免

const { planId, isEnterprisePlan, currentPeriodEnd, currentPeriodStart, quota: { tokenLimit } }
  = await subscriptionLibrary.getSubscriptionData();  // 命中 Redis 缓存

// 付费计划直接放行
if (isReportablePlan(planId, isEnterprisePlan)) {
  await next();
  return;
}

// 免费计划：检查 token 用量
const tokenUsage = await subscriptionLibrary.getTenantTokenUsage({
  from: new Date(currentPeriodStart),
  to: new Date(currentPeriodEnd),
});

assertThat(
  tokenLimit === null || tokenUsage.totalUsage < tokenLimit,
  new RequestError({ code: 'auth.exceed_token_limit', status: 429 })
);
```

**异常容错**：非 `RequestError` 的意外错误不会阻断请求，仅上报 App Insights：

```typescript
catch (error: unknown) {
  if (error instanceof RequestError) throw error;
  void appInsights.trackException(error, buildAppInsightsTelemetry(ctx));
}
```

### 3.5 第五层：输入输出守卫 (koaGuard)

**文件位置**: `packages/core/src/middleware/koa-guard.ts`

使用 Zod schema 对请求的 query、body、params、files 进行验证，并对响应体和状态码进行断言。这不是权限层面的守卫，但它是请求进入业务逻辑前的最后一道验证。

### 3.6 SchemaRouter 中间件系统

**文件位置**: `packages/core/src/utils/SchemaRouter.ts`

SchemaRouter 提供灵活的中间件配置系统，支持：
- 按作用域应用（`native` = CRUD 路由，`relation` = 关联路由）
- 按 HTTP 方法过滤
- 自动收集中间件声明的额外状态码

## 四、缓存机制

### 4.1 双层缓存架构

访问控制涉及两层独立的缓存系统，服务于不同的守卫层：

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
│       │              │       │                              │
│                      │       ▼                              │
│                      │  TtlCache (进程内)                    │
│                      │  tokenUsageCache                     │
│                      │  (1小时本地缓存)                      │
└──────────────────────┴──────────────────────────────────────┘
```

### 4.2 BaseCache 基础设施

**文件位置**: `packages/core/src/caches/base-cache.ts`

```typescript
export abstract class BaseCache<CacheMapT extends Record<string, unknown>> {
  constructor(
    public tenantId: string,
    protected cacheStore: CacheStore   // Redis 后端
  ) {}

  // 默认过期时间：30 分钟 (1800 秒)
  async set(type, key, value, expire?) {
    return this.cacheStore.set(this.cacheKey(type, key), JSON.stringify(value), expire);
  }

  // 装饰器：成功后删除缓存（Write-Through 失效）
  mutate(run, ...types) { /* ... */ }

  // 装饰器：结果缓存 + 防缓存击穿
  memoize(run, [type, cacheKey], getExpiresIn?) { /* ... */ }
}
```

**缓存键格式**: `{tenantId}:{type}:{key}`

`memoize` 的并发控制机制：通过 `promiseCache`（`Map<unknown, Promise>`）确保同一 key 同时只有一个正在执行的查询，防止缓存击穿。

### 4.3 订阅数据缓存 (TenantSubscriptionCache + Redis)

**文件位置**: 
- 缓存类: `packages/core/src/caches/tenant-subscription.ts`
- 库逻辑: `packages/core/src/libraries/subscription.ts`

**TTL 计算方法**：TTL 不是固定值，而是基于 `currentPeriodEnd` 动态计算：

```typescript
const maxSubscriptionCacheTtl = 24 * 60 * 60;  // 最大 24 小时（秒）

const getSubscriptionCacheExpiration = (currentPeriodEnd: string) => {
  const expiration = Math.floor((new Date(currentPeriodEnd).getTime() - Date.now()) / 1000);
  return Math.min(Math.max(expiration, 0), maxSubscriptionCacheTtl);
};
```

**TTL 计算逻辑**:
- 取 `currentPeriodEnd - now`（秒）作为基础过期时间
- 下限为 0（订阅期已结束则立即过期）
- 上限为 24 小时（86400 秒）
- 这意味着：如果订阅期还剩 2 小时，缓存 TTL 就是 2 小时；如果还剩 30 天，TTL 为 24 小时

**缓存创建方式**:

```typescript
this.getSubscriptionData = this.subscriptionCache.memoize(
  async () => getTenantSubscription(this.cloudConnection),  // 从 Cloud API 获取
  [SubscriptionRedisCacheKey.Subscription],                  // 缓存类型
  ({ currentPeriodEnd }) => getSubscriptionCacheExpiration(currentPeriodEnd)  // 动态 TTL
);
```

**缓存失效策略**:

订阅缓存**没有显式的 `mutate` 或 `delete` 调用**。其失效完全依赖 Redis TTL 过期：

1. **TTL 到期自动失效**: Redis 在 TTL 过期后自动删除 key
2. **currentPeriodEnd 驱动**: 当订阅周期结束时缓存恰好过期，下一个请求重新从 Cloud API 拉取最新订阅数据
3. **Cloud 侧变更传播**: 如果 Cloud 侧更新了订阅数据（如升级计划），需要等待当前缓存 TTL 到期后才能生效（最长 24 小时）
4. **memoize 防击穿**: 在缓存失效瞬间，通过 `promiseCache` 保证只有一个请求去 Cloud API 获取数据

### 4.4 Token 用量缓存 (TtlCache + 进程内存)

**文件位置**: `packages/core/src/libraries/subscription.ts`

这是一个**进程内**的 TTL 缓存（`@logto/shared` 的 `TtlCache`），不走 Redis：

```typescript
const tokenUsageCacheTtl = 60 * 60 * 1000;  // 1 小时（毫秒）

private readonly tokenUsageCache = new TtlCache<string, TokenUsageCounts>(tokenUsageCacheTtl);
```

**TTL 计算方法**：同样基于时间窗口动态计算：

```typescript
const getTokenUsageCacheTtl = (to: Date) => {
  const expiration = Math.floor(to.getTime() - Date.now());
  return Math.min(expiration, tokenUsageCacheTtl);  // 最大 1 小时
};
```

**缓存键格式**: `{tenantId}:{from_date}:{to_date}:token-usage`

**与权限判断的联系**:

```
koaTokenUsageGuard 调用链：

1. subscriptionLibrary.getSubscriptionData()
   → 命中 Redis 缓存 → 获取 { currentPeriodStart, currentPeriodEnd, quota: { tokenLimit } }

2. subscriptionLibrary.getTenantTokenUsage({ from: currentPeriodStart, to: currentPeriodEnd })
   → 先查 TtlCache（进程内，最长1小时）
   → 未命中则查数据库 dailyTokenUsage 表
   → 写入 TtlCache，TTL = min(当前周期剩余时间, 1小时)

3. 比较 tokenUsage.totalUsage < tokenLimit
   → 超限则 429
```

**关键设计**：token 用量缓存的 TTL 与 `currentPeriodEnd` 挂钩，确保在订阅周期结束时缓存恰好失效，避免使用过期周期的用量数据。

### 4.5 currentPeriodEnd 在权限判断中的核心角色

`currentPeriodEnd` 是连接两层缓存的枢纽：

| 作用 | 关联缓存 | 影响 |
|------|---------|------|
| 订阅缓存 TTL | Redis TenantSubscriptionCache | 缓存精确在周期结束时过期 |
| Token 用量查询窗口 | 进程内 TtlCache | 确定查询 token 用量的时间范围 |
| Token 用量缓存 TTL | 进程内 TtlCache | 用量缓存也在周期结束时失效 |
| 付费计划判断 | 两者共用 | Pro/Enterprise 直接放行，跳过用量检查 |

**数据流**:

```
Cloud API → Subscription (含 currentPeriodEnd)
                │
                ├─→ Redis 缓存 (TTL = min(周期剩余秒数, 24h))
                │
                └─→ Token 用量查询窗口 (from: currentPeriodStart, to: currentPeriodEnd)
                         │
                         └─→ TtlCache (TTL = min(周期剩余毫秒数, 1h))
                                  │
                                  └─→ tokenUsage.totalUsage vs tokenLimit → 429 or pass
```

### 4.6 WellKnownCache（非权限相关，供参考）

**文件位置**: `packages/core/src/caches/well-known.ts`

存储 SIE、connectors、signing-key-rotation-state 等公开数据。默认过期 30 分钟。通过 `Tenant.invalidateCache()` 主动失效（签名密钥轮换时调用）。

## 五、越权拒绝路径

### 5.1 错误类型与状态码

| 层级 | 错误场景 | 错误码 | HTTP 状态码 | 所在文件 |
|------|---------|--------|------------|---------|
| 认证守卫 | Token 无效/过期 | `auth.unauthorized` | 401 | `koa-auth/index.ts` |
| 认证守卫 | Token 缺少 sub | `auth.jwt_sub_missing` | 401 | `koa-auth/index.ts` |
| 认证守卫 | 缺少 all scope | `auth.forbidden` | 403 | `koa-auth/index.ts` |
| 租户守卫 | 租户被暂停 | `subscription.tenant_suspended` | 403 | `koa-tenant-guard.ts` |
| 配额守卫 | 系统限制超限 | `system_limit.limit_exceeded` | 403 | `libraries/quota.ts` |
| 配额守卫 | 订阅配额超限 | `subscription.limit_exceeded` | 403 | `libraries/quota.ts` |
| Token用量守卫 | Token用量超限 | `auth.exceed_token_limit` | 429 | `koa-token-usage-guard.ts` |
| 输入守卫 | 参数验证失败 | `guard.invalid_input` | 400 | `koa-guard.ts` |

### 5.2 RequestError 类

**文件位置**: `packages/core/src/errors/RequestError/index.ts`

```typescript
export default class RequestError extends Error {
  code: LogtoErrorCode;
  status: number;
  expose: boolean;   // 是否向客户端暴露错误详情
  data: unknown;     // 附加数据（如 { key, limit, usage }）
}
```

- 支持 i18n：`toBody(i18next)` 生成客户端友好的国际化错误信息
- `data` 字段携带结构化上下文（如配额超限时包含 key、limit、usage）

### 5.3 错误处理流程

1. **守卫抛出 RequestError**: 各层守卫检查失败时抛出
2. **koa-error-handler 统一捕获**: 转换为标准 HTTP 响应
3. **审计日志记录**: 如果当前路由启用了 `koaAuditLog`，catch 块自动将错误标记到日志条目
4. **国际化响应**: `toBody()` 方法生成客户端错误信息

### 5.4 特殊容错：Token 用量守卫

`koaTokenUsageGuard` 对非 `RequestError` 的意外错误采用**容错策略**，不阻断请求：

```typescript
catch (error: unknown) {
  if (error instanceof RequestError) throw error;
  void appInsights.trackException(error, buildAppInsightsTelemetry(ctx));
}
// 继续执行 next()
```

## 六、审计系统关联

### 6.1 审计日志的实际挂载位置

**重要纠正**：`koaAuditLog` 并未在 Management API 路由（`managementRouter`）上全局挂载。

审计日志中间件的实际挂载位置：

| 路由 | 挂载方式 | 文件位置 |
|------|---------|---------|
| OIDC 路由 | `oidc.use(koaAuditLog(queries))` | `packages/core/src/oidc/init.ts:422` |
| Experience 路由 | `experienceRouter.use(koaAuditLog(tenant.queries))` | `packages/core/src/routes/init.ts:72` |
| Interaction 路由 | `interactionRouter` 子路由级别挂载 | `packages/core/src/routes/interaction/index.ts:59` |
| SAML 匿名路由 | 子路由级别挂载 | `packages/core/src/routes/saml-application/anonymous.ts` |
| Authn 路由 | 子路由级别挂载 | `packages/core/src/routes/authn.ts:186` |
| **Management API** | **未挂载** | — |
| **User API** | **未挂载** | — |

**结论**：管理 API 的 CRUD 操作（如创建应用、修改角色等）**不会自动产生审计日志**。审计日志仅覆盖身份认证流程（登录、Token 交换、SAML 回调等）。

### 6.2 审计日志的触发条件

审计日志需要**两个条件同时满足**：

1. **中间件挂载**: 路由或其父级使用了 `koaAuditLog(queries)`
2. **业务代码主动调用**: `ctx.createLog(key)` 创建日志条目

如果仅挂载了中间件但业务代码未调用 `createLog`，则不会产生任何日志记录。

### 6.3 LogKey 体系

**文件位置**: `packages/schemas/src/types/log/index.ts`

```
LogKey (所有日志键)
├── AuditLogKey (面向用户的审计日志)
│   ├── InteractionLogKey   → "Interaction.SignIn.Update" 等
│   ├── TokenLogKey         → "ExchangeTokenBy.AuthorizationCode" 等
│   ├── SamlLogKey          → "SamlApplication.Callback" 等
│   ├── JwtCustomizerLogKey → "JwtCustomizer.*" 等
│   └── "Unknown"           → 兜底键
└── WebhookLogKey (内部 Webhook 日志，非审计)
```

**Token 审计日志**通过 OIDC 事件监听器触发：

```typescript
// packages/core/src/event-listeners/grant.ts
provider.addListener('grant.success', grantListener);
provider.addListener('grant.error', grantListener);
provider.addListener('grant.revoked', grantRevocationListener);

export const grantListener = (ctx, error?) => {
  const log = ctx.createLog(`${token.Type.ExchangeTokenBy}.${getExchangeByType(params?.grant_type)}`);
  log.append({
    result: error && LogResult.Error,
    tokenTypes,
    scope,
    error: error && stringifyError(error),
  });
};
```

### 6.4 审计日志的异常路径

**正常路径**:

```
koaAuditLog 中间件 → next() → 业务代码 createLog → log.append() → finally 写入
```

**异常路径 1：守卫拦截（如 koaAuth 403）**

当审计日志中间件挂载在守卫之前时（如 OIDC 路由），守卫抛出的错误会被 `koaAuditLog` 的 catch 块捕获：

```typescript
try {
  await next();  // koaAuth → koaTokenUsageGuard → 业务逻辑
} catch (error: unknown) {
  for (const entry of entries) {
    entry.append({
      result: LogResult.Error,
      error: error instanceof RequestError
        ? pick(error, 'message', 'code', 'data')
        : { message: String(error) },
    });
  }
  throw error;  // 重新抛出，由上游错误处理器处理
} finally {
  // 写入日志（包含错误信息）
}
```

但此时如果业务代码尚未调用 `createLog`，则 `entries` 数组为空，不会写入任何日志。

**异常路径 2：Management API 守卫拦截**

由于 Management API 未挂载 `koaAuditLog`，所有被 `koaAuth`、`koaTenantGuard`、`koaQuotaGuard` 拦截的请求**不会产生审计日志**。这些拒绝记录仅存在于服务端 console 日志和 App Insights 遥测中。

**异常路径 3：koaGuard 验证失败**

`koaGuard` 抛出的 `guard.invalid_input` 错误在 `koaAuditLog` 的 catch 块中会被记录（如果审计中间件已挂载），但由于是输入验证失败，通常没有业务日志条目需要追加。

### 6.5 审计日志写入机制

**文件位置**: `packages/core/src/middleware/koa-audit-log.ts`

```typescript
finally {
  const basePayload = removeUndefinedKeys({
    ip,
    userAgent: userAgentValue,
    ...conditional(userAgentParsed && { userAgentParsed }),
    ...conditional(signInContext && { signInContext }),
  });

  await Promise.all(
    entries.map(async ({ payload }) => {
      return insertLog({
        id: generateStandardId(),
        key: payload.key,
        payload: { ...basePayload, ...payload },
      });
    })
  );
}
```

**写入特点**:
- 在 `finally` 块中执行，确保无论成功失败都会写入
- 自动注入请求 IP、User Agent、登录上下文
- 敏感数据自动脱敏（`password`、`secret` 字段替换为 `******`）
- 使用 `Promise.all` 并行写入多条日志
- `await` 等待写入完成，日志写入失败不影响错误传播

### 6.6 审计日志查询

**文件位置**: `packages/core/src/routes/log.ts`

Management API 提供日志查询端点（`GET /api/logs`、`GET /api/logs/:id`），但这是管理接口本身的 CRUD 功能，不是访问控制流程的一部分。查询的日志范围包括：

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

## 七、关键决策点

### 7.1 Scope 设计决策

**决策**: 管理 API 使用单一 `all` scope 而非细粒度 scope

**代码位置**: `packages/schemas/src/seeds/management-api.ts`

```typescript
scopes: [
  {
    name: PredefinedScope.All,
    description: 'Default scope for Management API, allows all permissions.',
  },
],
```

**权衡**:
- ✅ 简化权限模型，降低实现复杂度
- ✅ 与 RBAC 系统解耦（角色 → scope → 访问权）
- ⚠️ 粒度较粗，无法在 API 层面做细粒度资源权限控制
- ⚠️ 实际的细粒度控制由 Cloud 侧的角色分配和配额限制实现

### 7.2 中间件顺序决策

**决策**: 认证守卫 → 租户守卫 → 配额守卫 → 业务守卫

**理由**:
1. 先验证身份（"你是谁"）— 无 Token 则一切免谈
2. 再验证租户状态（"你的租户是否正常"）— 暂停租户直接拒绝
3. 再验证配额（"你是否有足够资源"）— 配额检查需要订阅数据，依赖 Redis 缓存
4. 最后验证业务权限 — 输入输出格式等

### 7.3 订阅缓存 TTL 决策

**决策**: 基于 `currentPeriodEnd` 动态计算 TTL，上限 24 小时

**理由**:
- 在订阅周期结束时缓存自然失效，无需额外的失效推送机制
- 24 小时上限防止长期订阅的缓存数据过旧
- 权衡：Cloud 侧的订阅变更最长需要 24 小时才能生效

### 7.4 Token 用量缓存决策

**决策**: 两级缓存（Redis 订阅数据 + 进程内 TtlCache 用量数据）

**理由**:
- 订阅数据变化不频繁 → Redis 缓存，跨请求共享
- Token 用量每个请求都需要查询 → 进程内缓存，避免数据库压力
- 两层缓存的 TTL 都与 `currentPeriodEnd` 挂钩，确保周期切换时数据一致

### 7.5 审计日志覆盖范围决策

**决策**: 仅在身份认证流程路由上挂载审计日志，管理 API CRUD 操作不记录审计日志

**权衡**:
- ✅ 减少日志写入量，降低存储和查询成本
- ✅ 聚焦安全审计（谁登录了、谁的 Token 被换了）
- ⚠️ 管理操作（如删除用户、修改角色）无法通过审计日志追溯
- ⚠️ 如果需要管理操作审计，需要通过 Cloud 侧的 Webhook 机制实现

### 7.6 Token 用量守卫容错决策

**决策**: Token 用量守卫的意外错误不阻断请求

**理由**:
- Token 发放是核心功能，不应因配额检查的意外故障而中断
- 错误上报到 App Insights 以便运维发现
- 仅对明确的 `RequestError`（如 429 超限）阻断请求

## 八、代码路径索引

| 功能模块 | 文件路径 |
|---------|---------|
| 租户上下文定义 | `packages/core/src/tenants/TenantContext.ts` |
| 租户实例创建 | `packages/core/src/tenants/Tenant.ts` |
| 路由初始化 | `packages/core/src/routes/init.ts` |
| 认证守卫 | `packages/core/src/middleware/koa-auth/index.ts` |
| OIDC 认证守卫 | `packages/core/src/middleware/koa-auth/koa-oidc-auth.ts` |
| 租户守卫 | `packages/core/src/middleware/koa-tenant-guard.ts` |
| 配额守卫中间件 | `packages/core/src/middleware/koa-quota-guard.ts` |
| 配额判定核心 | `packages/core/src/libraries/quota.ts` |
| Token 用量守卫 | `packages/core/src/middleware/koa-token-usage-guard.ts` |
| 订阅库（缓存核心） | `packages/core/src/libraries/subscription.ts` |
| 输入输出守卫 | `packages/core/src/middleware/koa-guard.ts` |
| 审计日志中间件 | `packages/core/src/middleware/koa-audit-log.ts` |
| OIDC 事件监听器 | `packages/core/src/event-listeners/index.ts` |
| Grant 审计日志 | `packages/core/src/event-listeners/grant.ts` |
| 基础缓存 | `packages/core/src/caches/base-cache.ts` |
| 订阅缓存 | `packages/core/src/caches/tenant-subscription.ts` |
| WellKnown 缓存 | `packages/core/src/caches/well-known.ts` |
| SchemaRouter | `packages/core/src/utils/SchemaRouter.ts` |
| 错误处理 | `packages/core/src/errors/RequestError/index.ts` |
| 管理 API Scope 定义 | `packages/schemas/src/seeds/management-api.ts` |
| 订阅类型定义 | `packages/core/src/utils/subscription/types.ts` |
| LogKey 类型定义 | `packages/schemas/src/types/log/index.ts` |
| OIDC 初始化 | `packages/core/src/oidc/init.ts` |
