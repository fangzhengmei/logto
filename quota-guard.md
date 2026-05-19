# 配额守卫（Quota Guard）机制详解

## 一、核心架构概述

配额守卫是 Logto Cloud 环境中用于限制租户资源使用的机制，确保租户在订阅计划范围内使用系统资源。它由三层组成：

```
┌─────────────────────────────────────────────────────────┐
│                     业务路由层                           │
│  - 显式调用 quota.guardTenantUsageByKey()              │
│  - 或使用 koaQuotaGuard 中间件                           │
└────────────────────────────┬────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│                   QuotaLibrary 核心层                   │
│  - guardTenantUsageByKey: 统一校验入口                  │
│  - assertSystemLimit: 系统限制校验                      │
│  - assertQuotaLimit: 订阅配额校验                       │
│  - reportSubscriptionUpdatesUsage: 用量上报             │
└────────────────────────────┬────────────────────────────┘
                             │
          ┌──────────────────┴──────────────────┐
          ▼                                     ▼
┌─────────────────────┐             ┌─────────────────────┐
│  订阅数据层          │             │  使用量查询层        │
│  - Subscription     │             │  - TenantUsageQuery │
│  - Redis 缓存       │             │  - SQL 实时查询      │
│  - Cloud API 对接   │             │  - 内存缓存          │
└─────────────────────┘             └─────────────────────┘
```

## 二、判定时机：什么时候被拦截？

### 2.1 拦截发生在**操作执行前**

配额守卫采用 **pre-action 校验** 模式，在实际执行数据库操作之前进行检查：

```typescript
// 示例：创建应用前检查
await quota.guardTenantUsageByKey('applicationsLimit');
// 检查通过后才执行创建
await queries.applications.insert(applicationData);
```

### 2.2 两种调用方式

#### 方式一：路由中间件（koaQuotaGuard）
适用于简单的租户级配额检查，在路由定义时直接挂载：

```typescript
// packages/core/src/middleware/koa-quota-guard.ts:13-21
router.post('/applications', koaQuotaGuard({ key: 'applicationsLimit', quota }), async (ctx) => {
  // 实际创建逻辑
});
```

#### 方式二：显式调用（guardTenantUsageByKey）
适用于需要传入 `entityId` 或批量操作的场景：

```typescript
// packages/core/src/routes/role.scope.ts:96-99
await quota.guardTenantUsageByKey('scopesPerRoleLimit', {
  entityId: roleId,           // 基于实体的配额需要指定实体 ID
  consumeUsageCount: 5,       // 批量操作时指定本次消耗数量
});
```

### 2.3 短路条件（不拦截的情况）

在 `quota.ts:152-162` 中定义了三个跳过条件，满足任一即不校验：

1. **非 Cloud 环境**：`!isCloud` - 开源部署无配额限制
2. **Admin 租户**：`tenantId === adminTenantId` - 管理后台不受限
3. **Pro/Enterprise 计划的 Add-on 资源**：这些资源按需付费，不硬拦截

## 三、生效范围：哪些资源被管控？

### 3.1 配额类型体系

```
UsageKey (所有需要检查的键)
├── SystemUsageKey (系统级硬限制，优先级更高)
│   ├── applicationsLimit
│   ├── thirdPartyApplicationsLimit
│   ├── machineToMachineLimit
│   ├── resourcesLimit
│   ├── scopesPerResourceLimit
│   ├── scopesPerRoleLimit
│   ├── socialConnectorsLimit
│   ├── userRolesLimit
│   ├── machineToMachineRolesLimit
│   ├── hooksLimit
│   ├── enterpriseSsoLimit
│   ├── organizationsLimit
│   ├── samlApplicationsLimit
│   ├── customDomainsLimit
│   ├── usersPerOrganizationLimit           # 系统限制独有
│   ├── organizationUserRolesLimit         # 系统限制独有
│   ├── organizationMachineToMachineRolesLimit  # 系统限制独有
│   └── organizationScopesLimit            # 系统限制独有
│
└── QuotaUsageKey (订阅计划配额)
    ├── 数值型配额（同 SystemUsageKey 重叠部分）
    └── 布尔型配额（功能开关）
        ├── mfaEnabled
        ├── customJwtEnabled
        ├── subjectTokenEnabled
        ├── bringYourUiEnabled
        ├── collectUserProfileEnabled
        ├── passkeySignInEnabled
        ├── securityFeaturesEnabled
        └── idpInitiatedSsoEnabled
```

### 3.2 检查优先级

1. **先检查 SystemLimit**（系统硬限制）- `quota.ts:172-179`
2. **再检查 QuotaLimit**（订阅配额）- `quota.ts:182-190`

同一键可能同时存在于两者中，系统限制优先级更高。

### 3.3 基于实体 vs 租户级

| 类型 | 示例 | 特点 |
|------|------|------|
| **租户级** | `applicationsLimit`, `hooksLimit` | 直接统计租户下总量，无需 entityId |
| **基于实体** | `scopesPerRoleLimit`, `scopesPerResourceLimit`, `usersPerOrganizationLimit` | 需要指定 `entityId`，统计该实体下的关联数量 |

## 四、校验逻辑详解

### 4.1 数值型配额校验（NumericQuotaUsageKey）

```typescript
// quota.ts:312-333
const usage = await tenantUsageQuery.get(key, entityId);
assertThat(
  usage + consumeUsageCount <= limit,  // 核心公式：当前用量 + 本次消耗 <= 限制
  new RequestError({ code: 'subscription.limit_exceeded', status: 403 })
);
```

**校验公式**：`当前使用量 + 本次消耗数量 <= 配额限制`

- `consumeUsageCount` 默认为 1
- 批量操作时需手动传入（如一次性给角色分配 5 个 scope）

### 4.2 布尔型配额校验（BooleanQuotaUsageKey）

```typescript
// quota.ts:293-308
assertThat(
  limit,  // 直接检查配额值：true=允许，false=禁止
  new RequestError({ code: 'subscription.limit_exceeded', status: 403 })
);
```

布尔型配额是**功能开关**，不涉及用量统计，直接判断该功能在当前订阅计划中是否启用。

### 4.3 错误码区分

| 错误码 | 场景 |
|--------|------|
| `system_limit.limit_exceeded` | 超出系统硬限制 |
| `subscription.limit_exceeded` | 超出订阅计划配额 |

## 五、与计费数据的对接方式

### 5.1 订阅数据来源

```typescript
// libraries/subscription.ts:80-84
this.getSubscriptionData = this.subscriptionCache.memoize(
  async () => getTenantSubscription(this.cloudConnection),  // 从 Cloud API 获取
  [SubscriptionRedisCacheKey.Subscription],
  ({ currentPeriodEnd }) => getSubscriptionCacheExpiration(currentPeriodEnd)
);
```

**数据链路**：
1. 调用 Cloud API `/api/tenants/my/subscription` 获取订阅数据
2. 通过 Redis 缓存，过期时间 = 当前订阅周期结束时间（最长 24 小时）
3. 缓存键：`tenant:{tenantId}:subscription`

### 5.2 订阅数据结构

```typescript
// utils/subscription/types.ts:18-165
type Subscription = {
  id: string;
  planId: string;                    // 计划 ID: Free / Pro / Enterprise
  isEnterprisePlan: boolean;         // 是否企业版
  status: SubscriptionStatus;        // 订阅状态
  currentPeriodStart: string;        // 当前周期开始
  currentPeriodEnd: string;          // 当前周期结束
  quota: SubscriptionQuota;          // 订阅配额（计划级）
  systemLimit: SystemLimit;          // 系统硬限制（管理员级）
};
```

### 5.3 使用量查询机制

#### TenantUsageQuery 缓存层

```typescript
// quota.ts:347-379
class TenantUsageQuery {
  private readonly cache = new Map<string, number>();  // 内存缓存

  get(key, entityId) {
    const cacheKey = entityId ? `${key}:${entityId}` : key;
    if (cached) return cached;
    const usage = await this.getTenantUsage(key, entityId);  // 实际查询
    this.cache.set(cacheKey, usage);
    return usage;
  }
}
```

**作用**：同一次请求中，若同时检查 SystemLimit 和 QuotaLimit，避免重复查询数据库。

#### 自计算使用量查询

```typescript
// queries/tenant-usage/index.ts:69-88
private get selfComputedUsageQueryRegistery(): UsageQueryRegistery {
  return {
    applicationsLimit: this.countAllApplications,
    scopesPerRoleLimit: this.countScopesForRole,
    // ... 其他查询函数映射
  };
}
```

每个配额键对应一个 SQL 查询函数，实时统计数据库中的实际使用量。

### 5.4 用量上报（Add-on 资源）

对于 Pro/Enterprise 计划的 Add-on 资源（如 organizationsLimit, hooksLimit），不硬拦截，而是**上报使用量**：

```typescript
// quota.ts:193-216
reportSubscriptionUpdatesUsage = async (key) => {
  if (this.shouldReportSubscriptionUpdates(planId, isEnterprisePlan, key)) {
    await reportSubscriptionUpdates(this.cloudConnection, key);  // 上报到 Cloud
  }
};
```

**上报时机**：操作成功后异步上报（不阻塞请求）

```typescript
// middleware/koa-quota-guard.ts:28-37
export function koaReportSubscriptionUpdates({ key, quota }) {
  return async (_, next) => {
    await next();  // 先执行业务逻辑
    void quota.reportSubscriptionUpdatesUsage(key);  // 异步上报
  };
}
```

## 六、典型场景分析

### 场景 1：创建应用

```typescript
// routes/applications/application.ts:222-227
await Promise.all([
  rest.type === ApplicationType.MachineToMachine &&
    quota.guardTenantUsageByKey('machineToMachineLimit'),
  rest.isThirdParty && quota.guardTenantUsageByKey('thirdPartyApplicationsLimit'),
  quota.guardTenantUsageByKey('applicationsLimit'),
]);
```

**检查项**：
1. 总应用数不超限
2. 若是 M2M 应用，M2M 应用数不超限
3. 若是第三方应用，第三方应用数不超限

### 场景 2：给角色分配 Scope

```typescript
// routes/role.scope.ts:96-99
await quota.guardTenantUsageByKey('scopesPerRoleLimit', {
  entityId: id,                // 角色 ID
  consumeUsageCount: scopeIds.length,  // 本次分配的数量
});
```

**检查公式**：`该角色已有的 scope 数 + 本次分配数 <= scopesPerRoleLimit`

## 七、关键文件索引

| 文件 | 职责 |
|------|------|
| `packages/core/src/libraries/quota.ts` | 配额守卫核心逻辑 |
| `packages/core/src/middleware/koa-quota-guard.ts` | Koa 中间件包装 |
| `packages/core/src/queries/tenant-usage/types.ts` | 配额类型定义 |
| `packages/core/src/queries/tenant-usage/index.ts` | 使用量 SQL 查询 |
| `packages/core/src/libraries/subscription.ts` | 订阅数据获取与缓存 |
| `packages/core/src/utils/subscription/types.ts` | 订阅数据结构定义 |
