# 后台管理接口访问控制分层架构

## 概述

Logto 后台管理接口（Management API）采用多层级的访问控制架构，通过租户上下文注入、多层权限守卫、缓存机制、越权拒绝和审计日志五个核心模块的协同工作，实现安全、高效的访问控制。

## 一、分层架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                     客户端请求                                   │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│  第一层：租户上下文注入 (Tenant Context Injection)               │
│  - 租户识别与实例创建                                           │
│  - 数据库连接池初始化                                           │
│  - 依赖注入（Queries/Libraries/Caches）                        │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│  第二层：认证守卫 (Authentication Guard)                        │
│  - JWT Token 验证                                               │
│  - Bearer Token 提取                                            │
│  - 签名验证与受众检查                                           │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│  第三层：租户状态守卫 (Tenant Guard)                            │
│  - 租户暂停状态检查                                             │
│  - 云环境专属验证                                               │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│  第四层：配额守卫 (Quota Guard)                                 │
│  - 资源使用配额检查                                             │
│  - 订阅计划限制                                                 │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│  第五层：业务权限守卫 (Business Permission Guard)               │
│  - Scope 权限验证 (all scope)                                  │
│  - 组织级权限检查                                               │
│  - SchemaRouter 中间件链                                        │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│  第六层：输入输出守卫 (Input/Output Guard)                      │
│  - 请求参数 Zod 验证                                           │
│  - 响应体格式验证                                               │
│  - 状态码断言                                                   │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                     业务逻辑处理                                 │
└─────────────────────────────────────────────────────────────────┘
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

**创建流程**:

1. **租户识别**: 通过请求域名或路径提取租户 ID
2. **数据库连接**: `getTenantDatabaseDsn(id)` 获取租户数据库 DSN
3. **环境初始化**: `EnvSet` 加载配置
4. **依赖实例化**:
   - `Queries`: 数据库查询层
   - `Libraries`: 业务逻辑库（quota、hooks 等）
   - `WellKnownCache`: 缓存层
   - `Provider`: OIDC Provider

```typescript
static async create({ id, redisCache, customDomain }: CreateTenant): Promise<Tenant> {
  const tenantDatabaseDsn = await getTenantDatabaseDsn(id);
  const envSet = new EnvSet(id, tenantDatabaseDsn);
  await envSet.load(customDomain);
  return new Tenant(envSet, id, new WellKnownCache(id, redisCache));
}
```

### 2.3 路由挂载与上下文传递

**文件位置**: `packages/core/src/routes/init.ts`

租户上下文通过 `initApis` 函数传递给所有路由：

```typescript
export default function initApis(tenant: TenantContext): Koa {
  const apisApp = new Koa();
  // ...
  for (const router of createRouters(tenant)) {
    apisApp.use(router.routes()).use(router.allowedMethods());
  }
  return apisApp;
}
```

管理 API 路由（`managementRouter`）接收完整的租户上下文：

```typescript
const managementRouter: ManagementApiRouter = new Router();
managementRouter.use(koaAuth(tenant.envSet, getManagementApiResourceIndicator(tenant.id)));
managementRouter.use(koaTenantGuard(tenant.id, tenant.queries));
managementRouter.use(koaManagementApiHooks(tenant.libraries.hooks));
// 挂载所有管理 API 路由
applicationRoutes(managementRouter, tenant);
adminUserRoutes(managementRouter, tenant);
// ...
```

## 三、权限守卫分层判定

### 3.1 第一层：认证守卫 (koaAuth)

**文件位置**: `packages/core/src/middleware/koa-auth/index.ts`

**核心职责**:
- 提取 Bearer Token
- 验证 JWT 签名
- 检查受众（audience）
- 验证 Scope 权限

**判定逻辑**:

```typescript
export default function koaAuth<StateT, ContextT extends IRouterParamContext, ResponseBodyT>(
  envSet: EnvSet,
  audience: string
): MiddlewareType<StateT, WithAuthContext<ContextT>, ResponseBodyT> {
  return async (ctx, next) => {
    const { sub, clientId, scopes } = await verifyBearerTokenFromRequest(
      envSet,
      ctx.request,
      audience
    );

    // 关键检查：必须包含 all scope
    assertThat(
      scopes.includes(PredefinedScope.All),
      new RequestError({ code: 'auth.forbidden', status: 403 })
    );

    ctx.auth = {
      type: sub === clientId ? 'app' : 'user',
      id: sub,
      scopes: new Set(scopes),
    };

    return next();
  };
}
```

**Token 验证流程**:
1. 从 Authorization header 提取 Bearer Token
2. 获取 JWKS（JSON Web Key Set）
3. 验证签名、签发者（issuer）、受众（audience）
4. 检查 `sub` 声明存在
5. 验证 `all` scope 存在（管理API的关键权限）

### 3.2 第二层：租户状态守卫 (koaTenantGuard)

**文件位置**: `packages/core/src/middleware/koa-tenant-guard.ts`

**核心职责**:
- 检查租户是否被暂停
- 仅在云环境生效

```typescript
export default function koaTenantGuard<StateT, ContextT extends IRouterParamContext, BodyT>(
  tenantId: string,
  { tenants }: Queries
): Middleware<StateT, ContextT, BodyT> {
  return async (ctx, next) => {
    const { isCloud } = EnvSet.values;

    if (!isCloud) {
      return next();
    }

    const { isSuspended } = await tenants.findTenantMetadataById(tenantId);

    if (isSuspended) {
      throw new RequestError('subscription.tenant_suspended', 403);
    }

    await next();
  };
}
```

### 3.3 第三层：配额守卫 (koaQuotaGuard)

**文件位置**: `packages/core/src/middleware/koa-quota-guard.ts`

**核心职责**:
- 检查资源使用配额
- 阻止超额操作

```typescript
export function koaQuotaGuard<StateT, ContextT, ResponseBodyT>({
  key,
  quota,
}: UsageGuardConfig): MiddlewareType<StateT, ContextT, ResponseBodyT> {
  return async (_, next) => {
    await quota.guardTenantUsageByKey(key);
    return next();
  };
}
```

**在 SchemaRouter 中的应用** (组织路由示例):

```typescript
const router = new SchemaRouter(Organizations, organizations, {
  middlewares: [
    {
      middleware: koaQuotaGuard({ key: 'organizationsLimit', quota }),
      scope: 'native',
      method: ['post', 'put'],
      status: [403],
    },
    // ...
  ],
});
```

### 3.4 第四层：SchemaRouter 中间件系统

**文件位置**: `packages/core/src/utils/SchemaRouter.ts`

SchemaRouter 提供灵活的中间件配置系统，支持：
- 按作用域应用（native/relation）
- 按 HTTP 方法过滤
- 自动收集响应状态码

**中间件配置类型**:

```typescript
type MiddlewareConfig = {
  middleware: SchemaMiddleware;
  scope?: MiddlewareScope; // 'native' | 'relation'
  method?: RouteMethod[]; // ['get', 'post', ...]
  status?: number[];
};
```

## 四、缓存机制

### 4.1 缓存架构

**基础缓存类**: `packages/core/src/caches/base-cache.ts`

```typescript
export abstract class BaseCache<CacheMapT extends Record<string, unknown>> {
  constructor(
    public tenantId: string,
    protected cacheStore: CacheStore
  ) {}

  async get<Type extends CacheKeyOf<CacheMapT>>(
    type: Type,
    key: string
  ): Promise<Optional<CacheMapT[Type]>>;

  async set<Type extends CacheKeyOf<CacheMapT>>(
    type: Type,
    key: string,
    value: Readonly<CacheMapT[Type]>,
    expire?: number
  );

  async delete(type: CacheKeyOf<CacheMapT>, key: string);

  // 装饰器模式：缓存失效
  mutate<Args extends unknown[], Return>(
    run: (...args: Args) => Promise<Return>,
    ...types: Array<CacheKeyConfig<Args, CacheKeyOf<CacheMapT>>>
  );

  // 装饰器模式：结果缓存
  memoize<Type extends CacheKeyOf<CacheMapT>, Args extends unknown[]>(
    run: (...args: Args) => Promise<Value>,
    config: CacheKeyConfig<Args, Type>,
    getExpiresIn?: (value: Value) => number
  );
}
```

### 4.2 缓存键设计

```
格式: {tenantId}:{type}:{key}

示例:
- tenant1:Subscription:#
- tenant2:WellKnown:jwks
```

### 4.3 租户订阅缓存

**文件位置**: `packages/core/src/caches/tenant-subscription.ts`

```typescript
type SubscriptionCacheMap = {
  [SubscriptionRedisCacheKey.Subscription]: Subscription;
};

export class TenantSubscriptionCache extends BaseCache<SubscriptionCacheMap> {
  name = 'Tenant Subscription';
  getValueGuard = getValueGuard;
}
```

### 4.4 缓存与权限的结合

缓存机制在权限判定中的作用：
1. **租户订阅数据缓存**: 减少对 Cloud API 的调用
2. **JWKS 缓存**: 加速 JWT 验证
3. **配额数据缓存**: 提升配额检查性能
4. **并发控制**: `memoize` 方法通过 `promiseCache` 防止缓存击穿

## 五、越权拒绝路径

### 5.1 错误类型与状态码

| 层级 | 错误场景 | 错误码 | HTTP 状态码 |
|------|---------|--------|------------|
| 认证守卫 | Token 无效 | `auth.unauthorized` | 401 |
| 认证守卫 | Token 缺少 sub | `auth.jwt_sub_missing` | 401 |
| 认证守卫 | 缺少 all scope | `auth.forbidden` | 403 |
| 租户守卫 | 租户被暂停 | `subscription.tenant_suspended` | 403 |
| 配额守卫 | 配额超限 | `subscription.quota_exceeded` | 403 |
| 输入守卫 | 参数验证失败 | `guard.invalid_input` | 400 |

### 5.2 RequestError 类

**文件位置**: `packages/core/src/errors/RequestError/index.ts`

```typescript
export default class RequestError extends Error {
  code: LogtoErrorCode;
  status: number;
  expose: boolean;
  data: unknown;

  constructor(input: RequestErrorMetadata | LogtoErrorCode, data?: unknown) {
    // ...
  }

  toBody(i18next: i18n): RequestErrorBody {
    return { code, data, details, message };
  }
}
```

### 5.3 错误处理流程

1. **守卫抛出错误**: 各层守卫检查失败时抛出 `RequestError`
2. **koa-error-handler 捕获**: 统一处理错误
3. **审计日志记录**: `koaAuditLog` 在 `finally` 块中记录错误结果
4. **国际化响应**: `toBody()` 方法生成客户端友好的错误信息

## 六、审计系统关联

### 6.1 审计日志中间件

**文件位置**: `packages/core/src/middleware/koa-audit-log.ts`

**核心功能**:
- 注入 `createLog` 方法到上下文
- 自动收集请求上下文（IP、User Agent）
- 错误自动标记为失败
- 敏感数据自动脱敏

### 6.2 LogEntry 类

```typescript
export class LogEntry {
  payload: LogContextPayload;

  constructor(public readonly key: LogKey) {
    this.payload = { key, result: LogResult.Success };
  }

  prepend(data: Readonly<LogPayload>) { /* ... */ }
  append(data: Readonly<LogPayload>) { /* ... */ }
}
```

### 6.3 与权限系统的结合点

**1. 成功路径记录**:

```typescript
// 在路由处理中创建日志
const log = ctx.createLog('Interaction.Create');
log.append({ applicationId: 'foo', userId: 'bar' });
```

**2. 失败路径自动记录**:

```typescript
try {
  await next();
} catch (error: unknown) {
  for (const entry of entries) {
    entry.append({
      result: LogResult.Error,
      error: error instanceof RequestError
        ? pick(error, 'message', 'code', 'data')
        : { message: String(error) },
    });
  }
  throw error;
}
```

**3. 请求上下文自动注入**:

```typescript
const basePayload = removeUndefinedKeys({
  ip,
  userAgent: userAgentValue,
  userAgentParsed,
  signInContext,
});
```

**4. 敏感数据脱敏**:

```typescript
const sensitiveDataKeys = Object.freeze(['password', 'secret']);

const sanitise = (value: unknown): unknown => {
  // 递归脱敏 password 和 secret 字段
};
```

### 6.4 审计日志写入时机

日志在 `finally` 块中批量写入数据库，确保：
- 无论请求成功失败都会记录
- 使用 `Promise.all` 并行写入提升性能
- 不阻塞请求响应（通过 `void` 异步执行）

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
- ✅ 简化权限模型
- ✅ 降低实现复杂度
- ⚠️ 粒度较粗，依赖上层 RBAC 系统

### 7.2 中间件顺序决策

**决策**: 认证守卫 → 租户守卫 → 配额守卫 → 业务守卫

**理由**:
1. 先验证身份（"你是谁"）
2. 再验证租户状态（"你的租户是否正常"）
3. 再验证配额（"你是否有足够资源"）
4. 最后验证业务权限

### 7.3 缓存策略决策

**决策**:
- **订阅数据**: 30分钟缓存（减少 Cloud API 调用）
- **JWKS**: 较长缓存（签名密钥不频繁变更）
- **并发控制**: 使用 `promiseCache` 防止缓存击穿

### 7.4 审计日志写入决策

**决策**: 在 `finally` 块中异步写入

**理由**:
- 确保日志不丢失
- 不阻塞请求响应
- 统一处理成功和失败场景

## 八、代码路径索引

| 功能模块 | 文件路径 |
|---------|---------|
| 租户上下文定义 | `packages/core/src/tenants/TenantContext.ts` |
| 租户实例创建 | `packages/core/src/tenants/Tenant.ts` |
| 路由初始化 | `packages/core/src/routes/init.ts` |
| 认证守卫 | `packages/core/src/middleware/koa-auth/index.ts` |
| OIDC 认证守卫 | `packages/core/src/middleware/koa-auth/koa-oidc-auth.ts` |
| 租户守卫 | `packages/core/src/middleware/koa-tenant-guard.ts` |
| 配额守卫 | `packages/core/src/middleware/koa-quota-guard.ts` |
| 输入输出守卫 | `packages/core/src/middleware/koa-guard.ts` |
| 审计日志 | `packages/core/src/middleware/koa-audit-log.ts` |
| 基础缓存 | `packages/core/src/caches/base-cache.ts` |
| SchemaRouter | `packages/core/src/utils/SchemaRouter.ts` |
| 错误处理 | `packages/core/src/errors/RequestError/index.ts` |
| 管理 API Scope 定义 | `packages/schemas/src/seeds/management-api.ts` |
