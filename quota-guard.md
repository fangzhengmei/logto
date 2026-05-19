# 配额守卫（Quota Guard）机制详解

## 一、核心架构概述

配额守卫是 Logto Cloud 环境中用于限制租户资源使用的机制，确保租户在订阅计划范围内使用系统资源。它由三层组成：

```
┌─────────────────────────────────────────────────────────┐
│                     业务路由层                           │
│  配额检查调用方式：                                     │
│  1. 中间件方式：koaQuotaGuard({ key, quota })           │
│  2. 显式调用：quota.guardTenantUsageByKey(key, options) │
│  特殊分支：custom domain 私有区域硬编码限制            │
│  用量上报方式：                                         │
│  1. 中间件方式：koaReportSubscriptionUpdates            │
│  2. 手动调用：void quota.reportSubscriptionUpdatesUsage │
└────────────────────────────┬────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│                   QuotaLibrary 核心层                   │
│  guardTenantUsageByKey(key) - 统一校验入口              │
│    入口短路：!isCloud / adminTenant（仅这两个）         │
│    按 key 类型分支：                                    │
│    ├─ isSystemUsageKey(key) → assertSystemLimit()      │
│    └─ isQuotaUsageKey(key)  → assertQuotaLimit()       │
│  assertSystemLimit: 系统限制校验（仅数值配额）          │
│  assertQuotaLimit: 订阅配额校验                         │
│    ├─ 布尔配额：直接判断 true/false                     │
│    ├─ 数值配额：查询用量 + Add-on 豁免判断              │
│    └─ Add-on 豁免：Pro/Enterprise 下跳过数值配额校验    │
│  reportSubscriptionUpdatesUsage: 用量上报               │
└────────────────────────────┬────────────────────────────┘
                             │
          ┌──────────────────┴──────────────────┐
          ▼                                     ▼
┌─────────────────────┐             ┌─────────────────────┐
│  订阅数据层          │             │  使用量查询层        │
│  - Subscription     │             │  - TenantUsageQuery │
│  - Redis 缓存       │             │  - SQL 实时查询      │
│  - Cloud API 对接   │             │  - Connector 库查询  │
│  键: tenantId:subscription:#    │  - 内存缓存          │
└─────────────────────┘             └─────────────────────┘
```

## 二、判定时机：什么时候被拦截？

### 2.1 拦截发生在**操作执行前**

配额守卫采用 **pre-action 校验** 模式，在实际执行数据库操作之前进行检查：

```typescript
// 示例：创建资源前检查
await quota.guardTenantUsageByKey('resourcesLimit');
// 检查通过后才执行创建
await queries.resources.insert(resourceData);
```

### 2.2 两种调用方式对比

#### 方式一：路由中间件（koaQuotaGuard）

**适用场景**：简单的租户级配额检查，无需 entityId 和批量参数。

**仓内真实调用点**：

```typescript
// packages/core/src/routes/subject-token.ts:28
router.post('/subject-tokens',
  koaQuotaGuard({ key: 'subjectTokenEnabled', quota }),  // 布尔配额
  koaGuard({ ... }),
  async (ctx) => { /* ... */ }
);

// packages/core/src/routes/resource.ts:82
router.post('/resources',
  koaQuotaGuard({ key: 'resourcesLimit', quota }),  // 数值配额
  koaGuard({ ... }),
  async (ctx) => { /* ... */ }
);

// packages/core/src/routes/hook.ts:184
router.post('/hooks',
  koaQuotaGuard({ key: 'hooksLimit', quota }),  // 数值配额
  koaGuard({ ... }),
  async (ctx) => { /* ... */ }
);

// packages/core/src/routes/sso-connector/index.ts:77
router.post('/sso-connectors',
  koaQuotaGuard({ key: 'enterpriseSsoLimit', quota }),  // 数值配额
  koaGuard({ ... }),
  async (ctx) => { /* ... */ }
);

// packages/core/src/routes/sign-in-experience/custom-ui-assets/index.ts:32
router.post('/sign-in-exp/default/custom-ui-assets',
  koaQuotaGuard({ key: 'bringYourUiEnabled', quota }),  // 布尔配额
  koaGuard({ ... }),
  async (ctx) => { /* ... */ }
);
```

#### 方式二：显式调用（guardTenantUsageByKey）

**适用场景**：需要传入 `entityId`（基于实体的配额）或 `consumeUsageCount`（批量操作）。

**仓内真实调用点**：

```typescript
// packages/core/src/routes/applications/application.ts:222-227
// 批量检查多个配额键
await Promise.all([
  rest.type === ApplicationType.MachineToMachine &&
    quota.guardTenantUsageByKey('machineToMachineLimit'),
  rest.isThirdParty && quota.guardTenantUsageByKey('thirdPartyApplicationsLimit'),
  quota.guardTenantUsageByKey('applicationsLimit'),
]);

// packages/core/src/routes/role.scope.ts:96-99
// 基于实体的配额 + 批量消耗
await quota.guardTenantUsageByKey('scopesPerRoleLimit', {
  entityId: roleId,
  consumeUsageCount: scopeIds.length,
});

// packages/core/src/routes/resource.scope.ts
// 基于实体的配额
await quota.guardTenantUsageByKey('scopesPerResourceLimit', {
  entityId: resourceId,
  consumeUsageCount: scopeIds.length,
});
```

> ✅ **重要事实**：`applications` 路由**没有**使用 `koaQuotaGuard` 中间件，而是在处理器内显式调用 `guardTenantUsageByKey`。

### 2.3 入口短路条件（不拦截的情况）

```typescript
// quota.ts:152-162
guardTenantUsageByKey = async (key, options) => {
  const { isCloud } = EnvSet.values;

  // 1. 非 Cloud 环境：开源部署无配额限制
  if (!isCloud) {
    return;
  }

  // 2. Admin 租户：管理后台不受限
  if (this.tenantId === adminTenantId) {
    return;
  }

  const subscriptionData = await this.subscription.getSubscriptionData();
  const tenantUsageQuery = new TenantUsageQuery(...);

  // ✅ 按 key 类型分支检查
  if (isSystemUsageKey(key)) {
    await this.assertSystemLimit(...);
  }

  if (isQuotaUsageKey(key)) {
    await this.assertQuotaLimit(...);
  }
};
```

入口处短路条件只有两个：
1. **非 Cloud 环境**：`!isCloud` - 开源部署无配额限制
2. **Admin 租户**：`tenantId === adminTenantId` - 管理后台不受限

> ⚠️ **重要事实**：Add-on 资源的豁免判断**不在入口处**，也不在 SystemLimit 阶段，**仅在 assertQuotaLimit 阶段**判断（见 5.4 节）。

## 三、生效范围：哪些资源被管控？

### 3.1 配额类型体系

```
UsageKey (所有需要检查的键，QuotaUsageKey | SystemUsageKey)
├── SystemUsageKey (系统级硬限制)
│   ├── SharedUsageKey (与 QuotaUsageKey 交集，14 个)
│   │   ├── applicationsLimit
│   │   ├── thirdPartyApplicationsLimit
│   │   ├── machineToMachineLimit
│   │   ├── resourcesLimit
│   │   ├── scopesPerResourceLimit
│   │   ├── scopesPerRoleLimit
│   │   ├── socialConnectorsLimit
│   │   ├── userRolesLimit
│   │   ├── machineToMachineRolesLimit
│   │   ├── hooksLimit
│   │   ├── enterpriseSsoLimit
│   │   ├── organizationsLimit
│   │   ├── samlApplicationsLimit
│   │   └── customDomainsLimit
│   └── System-only 扩展 (4 个，仅 SystemLimit 检查)
│       ├── usersPerOrganizationLimit
│       ├── organizationUserRolesLimit
│       ├── organizationMachineToMachineRolesLimit
│       └── organizationScopesLimit
│
└── QuotaUsageKey (订阅计划配额)
    ├── SharedUsageKey (与 SystemUsageKey 交集，14 个，数值配额)
    └── Quota-only 扩展 (9 个，仅 QuotaLimit 检查)
        ├── 布尔配额 (功能开关)
        │   ├── customJwtEnabled
        │   ├── subjectTokenEnabled
        │   ├── bringYourUiEnabled
        │   ├── collectUserProfileEnabled
        │   ├── passkeySignInEnabled
        │   ├── mfaEnabled
        │   ├── securityFeaturesEnabled
        │   └── idpInitiatedSsoEnabled
        └── 数值配额
            └── tenantMembersLimit (仅 Quota，不在 SystemLimit 中)
```

### 3.2 Key 类型分支检查

**核心纠正**：SystemLimit 并**不是始终执行**，而是按 key 类型分支：

```typescript
// quota.ts:172-190
if (isSystemUsageKey(key)) {
  await this.assertSystemLimit(...);  // ✅ 仅当 key 属于 SystemUsageKey 时才进入
}

if (isQuotaUsageKey(key)) {
  await this.assertQuotaLimit(...);   // ✅ 仅当 key 属于 QuotaUsageKey 时才进入
}
```

**各类型 Key 的检查路径**：

| Key 类型 | 示例 | SystemLimit | QuotaLimit |
|---------|------|-------------|------------|
| **仅 SystemUsageKey** | `usersPerOrganizationLimit` | ✅ 检查 | ❌ 不检查 |
| **仅 QuotaUsageKey（布尔）** | `subjectTokenEnabled`, `bringYourUiEnabled` | ❌ 不检查 | ✅ 检查 |
| **仅 QuotaUsageKey（数值）** | `tenantMembersLimit` | ❌ 不检查 | ✅ 检查 |
| **SharedUsageKey** | `applicationsLimit`, `hooksLimit` | ✅ 检查 | ✅ 检查 |

> ✅ **关键事实**：布尔配额 key（如 `subjectTokenEnabled`）**不会进入** SystemLimit 检查链路，因为它们**不属于** `SystemUsageKey`。

### 3.3 基于实体 vs 租户级

| 类型 | 示例 | 特点 |
|------|------|------|
| **租户级** | `applicationsLimit`, `hooksLimit` | 直接统计租户下总量，无需 entityId |
| **基于实体** | `scopesPerRoleLimit`, `scopesPerResourceLimit`, `usersPerOrganizationLimit` | 需要指定 `entityId`，统计该实体下的关联数量 |

## 四、校验逻辑详解

### 4.1 按 Key 类别划分的检查路径对照表

| Key 类别 | SystemLimit 检查 | QuotaLimit 检查 | 用量查询 | 校验逻辑 |
|---------|-----------------|----------------|---------|---------|
| **仅 System 的数值配额** | ✅ 检查数值 | ❌ 跳过 | SQL | `usage + consume <= systemLimit` |
| **仅 Quota 的布尔配额** | ❌ 跳过 | ✅ 检查布尔值 | 无 | `quota[key] === true` |
| **仅 Quota 的数值配额** | ❌ 跳过 | ✅ 检查数值 | SQL | `usage + consume <= quotaLimit` |
| **Shared 数值配额（Free）** | ✅ 检查数值 | ✅ 检查数值 | SQL | 两层检查都执行 |
| **Shared 数值配额（Pro/Ent）** | ✅ 检查数值 | ✅ 但 Add-on 豁免 | SQL | 仅 SystemLimit 生效 |

### 4.2 SystemLimit 检查逻辑（仅数值配额）

```typescript
// quota.ts:230-263
private readonly assertSystemLimit = async ({ key, entityId, ... }) => {
  const { systemLimit } = subscriptionData;
  const limit = systemLimit[key];

  if (limit === undefined) {
    return;  // 未设置系统限制，跳过
  }

  // ✅ 所有 SystemUsageKey 都是数值类型，统一查询用量
  const usage = await tenantUsageQuery.get(key, entityId);

  assertThat(
    usage + consumeUsageCount <= limit,
    new RequestError({ code: 'system_limit.limit_exceeded', status: 403 })
  );
};
```

> ✅ **事实**：SystemLimit **只处理数值配额**，布尔配额不会进入此阶段。

### 4.3 QuotaLimit 检查逻辑

```typescript
// quota.ts:265-334
private readonly assertQuotaLimit = async ({ key, entityId, ... }) => {
  const { planId, isEnterprisePlan, quota } = subscriptionData;

  // 1. Add-on 豁免：Pro/Enterprise 下跳过数值配额检查
  if (this.shouldReportSubscriptionUpdates(planId, isEnterprisePlan, key)) {
    return;
  }

  const { [key]: limit } = quota;

  if (limit === null) {
    return;  // 无限额，跳过
  }

  // 2. 布尔配额：直接判断
  if (isBooleanQuotaUsageKey(key)) {
    assertThat(
      limit === true,  // true=允许，false=禁止
      new RequestError({ code: 'subscription.limit_exceeded', status: 403 })
    );
    return;  // ✅ 直接返回，不查询用量
  }

  // 3. 数值配额：查询用量
  if (isNumericQuotaUsageKey(key)) {
    const usage = await tenantUsageQuery.get(key, entityId);
    assertThat(
      usage + consumeUsageCount <= limit,
      new RequestError({ code: 'subscription.limit_exceeded', status: 403 })
    );
  }
};
```

**校验公式（数值配额）**：`当前使用量 + 本次消耗数量 <= 配额限制`

- `consumeUsageCount` 默认为 1
- 批量操作时需手动传入（如一次性给角色分配 5 个 scope）

### 4.4 用量查询路径统一说明

**核心纠正**：并非所有配额键都走 SQL 查询。根据配额类型和检查阶段，查询路径分为三类：

| 配额类型 | 检查阶段 | 查询路径 | 代码证据 |
|---------|---------|---------|---------|
| **布尔型配额** | QuotaLimit | 直接取 `subscriptionData.quota[key]`，**不调用** `tenantUsageQuery.get()` | `quota.ts:293-308` 中 `isBooleanQuotaUsageKey(key)` 分支直接 return，无查询调用 |
| **socialConnectorsLimit** | SystemLimit / QuotaLimit | `connectorLibrary.getLogtoConnectors()`，**不查询数据库** | `quota.ts:371-379` 中 `key === 'socialConnectorsLimit'` 走特殊分支 |
| **其他数值配额** | SystemLimit / QuotaLimit | `tenantUsageQuery.get()` → SQL 查询 | `queries/tenant-usage/index.ts:69-88` 中各 count* 函数 |

#### 布尔配额：无用量查询

```typescript
// quota.ts:292-308
if (isBooleanQuotaUsageKey(key)) {
  assertThat(
    typeof limit === 'boolean',
    new TypeError('Feature availability settings must be boolean type.')
  );
  assertThat(
    limit,  // 直接检查配额值：true=允许，false=禁止
    new RequestError({ code: 'subscription.limit_exceeded', status: 403, data: { key } })
  );
  return;  // ✅ 直接返回，不调用 tenantUsageQuery.get()
}
```

> ✅ **代码证据**：布尔配额**不调用** `tenantUsageQuery.get()`，因此**不产生 SQL 查询**，也不经过 TenantUsageQuery 缓存层。

#### socialConnectorsLimit：ConnectorLibrary 路径

```typescript
// quota.ts:371-379
private readonly getTenantUsage: TenantUsageQueryFunction = async (key, entityId) => {
  if (key === 'socialConnectorsLimit') {
    // ✅ 不走 SQL，通过 ConnectorLibrary 获取已配置的连接器
    const connectors = await this.connectorLibrary.getLogtoConnectors();
    return connectors.filter((connector) => connector.type === ConnectorType.Social).length;
  }
  // 其他数值配额走 SQL 查询
  return this.queries.tenantUsage.getSelfComputedUsageByKey(this.tenantId, key, entityId);
};
```

> ✅ **代码证据**：`socialConnectorsLimit` **不查询数据库**，而是通过 ConnectorLibrary 实时获取已配置的社交连接器数量。

#### 类型系统佐证

```typescript
// queries/tenant-usage/types.ts:150-155
/**
 * Self-computed usage keys - usage data queryable from the database.
 * Excludes `socialConnectorsLimit` as it requires querying the Connector Library.
 */
export type SelfComputedUsageKey = Exclude<NumericUsageKey, 'socialConnectorsLimit'>;
```

> ✅ **代码证据**：类型定义明确排除了 `socialConnectorsLimit`，说明它不通过数据库自计算。

### 4.5 错误码区分

| 错误码 | 场景 |
|--------|------|
| `system_limit.limit_exceeded` | 超出系统硬限制（仅数值配额） |
| `subscription.limit_exceeded` | 超出订阅计划配额（数值或布尔配额） |

## 五、与计费数据的对接方式

### 5.1 订阅数据来源与缓存

**核心纠正**：真实的 Redis 缓存键结构。

```typescript
// caches/base-cache.ts:176-178
protected cacheKey(type: CacheKeyOf<CacheMapT>, key: string) {
  return `${this.tenantId}:${type}:${key}`;
}

// libraries/subscription.ts:80-84
this.getSubscriptionData = this.subscriptionCache.memoize(
  async () => getTenantSubscription(this.cloudConnection),
  [SubscriptionRedisCacheKey.Subscription],  // type = 'subscription'
  // 未提供 cacheKey 函数，使用 BaseCache.defaultKey = '#'
);
```

**真实缓存键**：`{tenantId}:subscription:#`

**数据链路**：
1. 调用 Cloud API `/api/tenants/my/subscription` 获取订阅数据
2. 通过 Redis 缓存，过期时间 = 当前订阅周期结束时间（最长 24 小时）
3. 缓存键示例：`tenant123:subscription:#`

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

> ⚠️ **注意**：布尔配额不经过此缓存层，因为它不调用 `tenantUsageQuery.get()`。

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

### 5.4 Add-on 资源：SystemLimit 与 QuotaLimit 的约束关系

**核心纠正**：Add-on 豁免**仅在 assertQuotaLimit 阶段判断**，SystemLimit 仅对属于 SystemUsageKey 的 key 生效。

```typescript
// quota.ts:172-190
if (isSystemUsageKey(key)) {
  await this.assertSystemLimit(...);  // 1. 仅当 key 属于 SystemUsageKey 时才检查
}

if (isQuotaUsageKey(key)) {
  await this.assertQuotaLimit(...);   // 2. 仅当 key 属于 QuotaUsageKey 时才检查
}

// quota.ts:278-294
private readonly assertQuotaLimit = async ({ key, ... }) => {
  const { planId, isEnterprisePlan, quota } = subscriptionData;

  // ✅ 仅在此处判断 Add-on 豁免
  if (this.shouldReportSubscriptionUpdates(planId, isEnterprisePlan, key)) {
    return;  // Pro/Enterprise 下 Add-on 资源跳过 QuotaLimit
  }
  // ... 后续校验
};
```

**执行顺序（以 SharedUsageKey 为例）**：
```
请求 → guardTenantUsageByKey('hooksLimit')
     ↓（入口仅检查 !isCloud 和 adminTenant）
  1. isSystemUsageKey('hooksLimit') = true
     → assertSystemLimit('hooksLimit') → 检查系统硬限制
     ↓（通过）
  2. isQuotaUsageKey('hooksLimit') = true
     → assertQuotaLimit('hooksLimit')
        ↓
        ├─ 是 Add-on 且是 Pro/Enterprise → return，跳过 QuotaLimit
        └─ 否则 → 执行配额校验
```

**执行顺序（以布尔配额为例）**：
```
请求 → guardTenantUsageByKey('subjectTokenEnabled')
     ↓（入口仅检查 !isCloud 和 adminTenant）
  1. isSystemUsageKey('subjectTokenEnabled') = false
     → ❌ 跳过 SystemLimit 检查
     ↓
  2. isQuotaUsageKey('subjectTokenEnabled') = true
     → assertQuotaLimit('subjectTokenEnabled')
        ↓
        ├─ isBooleanQuotaUsageKey = true
        └─ 直接判断 quota['subjectTokenEnabled'] === true
```

**Add-on 资源列表**（来自 `allReportSubscriptionUpdatesUsageKeys`）：
```typescript
// utils/subscription/types.ts:59-73
export const allReportSubscriptionUpdatesUsageKeys = Object.freeze([
  'machineToMachineLimit',
  'resourcesLimit',
  'mfaEnabled',
  'organizationsLimit',
  'tenantMembersLimit',
  'enterpriseSsoLimit',
  'hooksLimit',
  'securityFeaturesEnabled',
  'thirdPartyApplicationsLimit',
  'userRolesLimit',
  'machineToMachineRolesLimit',
  'samlApplicationsLimit',
  'customDomainsLimit',
]);
```

### 5.5 用量上报：trySafe + void 调用的失败不阻塞语义

#### 上报链路的错误处理

```typescript
// utils/subscription/index.ts:30-47
export const reportSubscriptionUpdates = async (cloudConnection, usageKey) => {
  if (!isReportSubscriptionUpdatesUsageKey(usageKey)) {
    return;
  }

  const client = await cloudConnection.getClient();
  // 使用 trySafe 包裹 API 调用，失败不抛出异常
  await trySafe(
    client.post('/api/tenants/my/subscription/item-updates', {
      body: { usageKey },
    })
  );
};
```

> ✅ **事实**：`trySafe` 确保即使上报 API 调用失败，也不会抛出异常，不会影响主业务流程。

#### void 调用的语义

**方式一：koaReportSubscriptionUpdates 中间件**
```typescript
// middleware/koa-quota-guard.ts:28-37
export function koaReportSubscriptionUpdates({ key, quota }) {
  return async (_, next) => {
    await next();  // 先执行业务逻辑
    void quota.reportSubscriptionUpdatesUsage(key);  // 异步上报，不等待
  };
}
```

**方式二：路由内手动调用（customDomains 采用此方式）**
```typescript
// routes/domain.ts:106-108
if (!isPrivateRegionFeature) {
  void quota.reportSubscriptionUpdatesUsage('customDomainsLimit');  // 不等待，不阻塞
}
```

> ✅ **事实**：`void` 关键字表示不等待 Promise 完成，请求响应不会等待上报完成。即使上报失败，用户也不会感知到错误。

#### 典型路由配置顺序

```typescript
// routes/sso-connector/index.ts:75-86
router.post(
  '/sso-connectors',
  koaQuotaGuard({ key: 'enterpriseSsoLimit', quota }),        // 1. Pre-action: 配额检查
  koaGuard({ ... }),                                           // 2. 参数校验
  koaReportSubscriptionUpdates({ key: 'enterpriseSsoLimit', quota }),  // 3. Post-action: 上报
  async (ctx, next) => { /* 业务逻辑 */ }
);
```

#### customDomains 的特殊上报方式

**核心纠正**：`customDomains` 在非私有区域**不使用 koaReportSubscriptionUpdates 中间件**，而是路由内手动调用。

```typescript
// routes/domain.ts:77-114
router.post('/domains', koaGuard({ ... }), async (ctx, next) => {
  const existingDomains = await findAllDomains();

  await assertCustomDomainLimit({
    isPrivateRegionFeature,
    quotaLibrary: quota,
    existingDomainCount: existingDomains.length,
  });

  // ... 业务逻辑 ...

  const syncedDomain = await addDomain(ctx.guard.body.domain);

  // ✅ 手动调用上报，而非通过中间件
  if (!isPrivateRegionFeature) {
    void quota.reportSubscriptionUpdatesUsage('customDomainsLimit');
  }

  ctx.status = 201;
  ctx.body = pick(syncedDomain, ...domainSelectFields);
  return next();
});
```

> ✅ **事实**：`customDomains` 的创建和删除操作都在路由内手动调用 `reportSubscriptionUpdatesUsage`，删除时同理（见 domain.ts:154-156）。

## 六、Custom Domain 完整分支分析

### 6.1 私有区域分支

```typescript
// utils/domain.ts:15-47
export const assertCustomDomainLimit = async ({
  isPrivateRegionFeature,
  quotaLibrary,
  existingDomainCount,
}) => {
  // 私有区域特殊处理：硬编码限制，不走配额系统
  if (isPrivateRegionFeature) {
    assertThat(
      existingDomainCount < maxCustomDomains,  // 默认 10
      new RequestError({ code: 'domain.exceed_domain_limit', status: 422 })
    );
    return;  // 直接返回，不走 quota guard
  }

  // 非私有区域：走正常配额守卫
  await quotaLibrary.guardTenantUsageByKey('customDomainsLimit');
};
```

**调用位置**：
```typescript
// routes/domain.ts:87-91
await assertCustomDomainLimit({
  isPrivateRegionFeature,
  quotaLibrary: quota,
  existingDomainCount: existingDomains.length,
});
```

### 6.2 四个操作分支的上报语义对比

| 操作 | 配额检查 | 用量上报 | 一致性 |
|------|---------|---------|-------|
| **POST /domains（非私有）** | `quota.guardTenantUsageByKey('customDomainsLimit')` | 路由内手动调用 `void quota.reportSubscriptionUpdatesUsage('customDomainsLimit')` | ✅ 一致 |
| **POST /domains（私有）** | 硬编码 `maxCustomDomains` 检查 | ❌ 无上报 | ⚠️ 不一致 |
| **DELETE /domains/:id（非私有）** | 无（删除操作不检查配额） | 路由内手动调用 `void quota.reportSubscriptionUpdatesUsage('customDomainsLimit')` | ✅ 上报触发 |
| **POST /domains/cleanup** | 无（清理操作不检查配额） | ❌ 无上报（见下方分析） | ⚠️ 缺失上报 |

### 6.3 Domains Cleanup 分支分析

**核心补充**：`/domains/cleanup` 分支会删除过期域名，但**未触发用量上报**。

```typescript
// routes/domain.ts:117-145
router.post(
  '/domains/cleanup',
  koaGuard({
    body: z.object({ staleDays: z.number().int().positive() }),
    response: z.object({
      scannedCount: z.number(),
      deletedCount: z.number(),  // 可能删除多个域名
      skippedActiveCount: z.number(),
      failedCount: z.number(),
    }),
    status: 200,
  }),
  async (ctx, next) => {
    const { staleDays } = ctx.guard.body;
    const summary = await cleanupDomains(staleDays);  // ✅ 内部会调用 deleteDomain 删除域名

    // 只同步 SAML 应用重定向 URL，未触发用量上报
    await trySafe(async () => {
      const domains = await findAllDomains();
      const syncedDomains = await Promise.all(
        domains.map(async (domain) => syncDomainStatus(domain))
      );
      await syncCustomDomainsToSamlApplicationRedirectUrls(tenantId, [...syncedDomains]);
    });

    ctx.status = 200;
    ctx.body = summary;
    return next();
  }
);
```

**cleanupDomains 内部实现**：
```typescript
// libraries/domain.ts:125-198
const cleanupDomains = async (staleDays: number): Promise<DomainCleanupSummary> => {
  // ...
  for (const domain of domains) {
    // 1. 孤立记录（无 Cloudflare 数据）：直接从 DB 删除
    if (!domain.cloudflareData) {
      await deleteDomainById(domain.id);
      summary.deletedCount += 1;
      continue;
    }
    // ...
    // 2. 过期非活跃域名：调用 deleteDomain 完整删除
    await deleteDomain(domain.id);  // ✅ 会删除 Cloudflare 和 DB 记录
    summary.deletedCount += 1;
  }
  return summary;
};
```

**影响说明**：
1. `cleanupDomains` 可能删除多个域名（`summary.deletedCount` 可能 > 1）
2. 但**未触发** `reportSubscriptionUpdatesUsage('customDomainsLimit')`
3. 这意味着 Cloud 侧的用量统计可能**滞后**，直到下次创建/删除单个域名时才会同步
4. 属于**最终一致性**设计：用量上报不追求实时精确，只要最终状态正确即可

### 6.4 与异步上报的一致性语义总结

**关键语义**：私有区域分支和 cleanup 分支是历史兼容/边缘场景，存在上报不一致。

| 场景 | 配额检查 | 用量上报 | 一致性 |
|------|---------|---------|-------|
| 非私有区域 CRUD | 经过配额系统 | 手动调用上报 | ✅ 一致 |
| 私有区域 | 硬编码限制 | ❌ 无上报 | ⚠️ 不一致，私有区域用量不会上报到 Cloud |
| Cleanup 批量删除 | 无配额检查 | ❌ 无上报 | ⚠️ 最终一致性，依赖后续操作同步 |

**私有区域分支**（未来将移除）：
1. 不检查订阅配额（QuotaLimit）
2. 不检查系统限制（SystemLimit）
3. 不触发用量上报
4. 仅受硬编码的全局限制（默认 10 个）

## 七、典型场景分析

### 场景 1：创建应用（显式调用方式，SharedUsageKey）

```typescript
// routes/applications/application.ts:222-227
await Promise.all([
  rest.type === ApplicationType.MachineToMachine &&
    quota.guardTenantUsageByKey('machineToMachineLimit'),
  rest.isThirdParty && quota.guardTenantUsageByKey('thirdPartyApplicationsLimit'),
  quota.guardTenantUsageByKey('applicationsLimit'),
]);
```

**执行链路**：
```
请求 → guardTenantUsageByKey('applicationsLimit')
     ↓（入口检查：isCloud=true, 非 admin）
  1. isSystemUsageKey('applicationsLimit') = true
     → assertSystemLimit → SQL 查询当前应用数 → 检查 <= systemLimit
     ↓（通过）
  2. isQuotaUsageKey('applicationsLimit') = true
     → assertQuotaLimit
        ↓
        ├─ Free 计划 → SQL 查询 → 检查 <= quotaLimit
        └─ Pro/Ent 计划 → 是 Add-on → return，跳过
```

### 场景 2：启用 Subject Token（布尔配额，仅 Quota）

```typescript
// routes/subject-token.ts:28
router.post('/subject-tokens',
  koaQuotaGuard({ key: 'subjectTokenEnabled', quota }),
  // ...
);
```

**执行链路**：
```
请求 → guardTenantUsageByKey('subjectTokenEnabled')
     ↓（入口检查：isCloud=true, 非 admin）
  1. isSystemUsageKey('subjectTokenEnabled') = false
     → ❌ 跳过 SystemLimit
     ↓
  2. isQuotaUsageKey('subjectTokenEnabled') = true
     → assertQuotaLimit
        ↓
        ├─ isBooleanQuotaUsageKey = true
        └─ 直接判断 quota['subjectTokenEnabled'] === true
```

### 场景 3：给角色分配 Scope（基于实体 + 批量，SharedUsageKey）

```typescript
// routes/role.scope.ts:96-99
await quota.guardTenantUsageByKey('scopesPerRoleLimit', {
  entityId: roleId,
  consumeUsageCount: scopeIds.length,
});
```

**执行链路**：
```
请求 → guardTenantUsageByKey('scopesPerRoleLimit', { entityId, consumeUsageCount })
     ↓（入口检查：isCloud=true, 非 admin）
  1. isSystemUsageKey('scopesPerRoleLimit') = true
     → assertSystemLimit → SQL 查询该角色当前 scope 数 → 检查 + consume <= systemLimit
     ↓（通过）
  2. isQuotaUsageKey('scopesPerRoleLimit') = true
     → assertQuotaLimit
        ↓
        ├─ Free 计划 → SQL 查询 → 检查 + consume <= quotaLimit
        └─ Pro/Ent 计划 → 非 Add-on → 同样检查
```

### 场景 4：Pro 计划下创建 Hook（Add-on 资源，SharedUsageKey）

```
请求 → guardTenantUsageByKey('hooksLimit')
     ↓（入口检查：isCloud=true, 非 admin）
  1. isSystemUsageKey('hooksLimit') = true
     → assertSystemLimit('hooksLimit') → 检查系统硬限制（始终执行）
     ↓（通过）
  2. isQuotaUsageKey('hooksLimit') = true
     → assertQuotaLimit('hooksLimit')
        ↓
        ├─ isReportablePlan(Pro) = true
        ├─ isReportSubscriptionUpdatesUsageKey('hooksLimit') = true
        └─ return → 跳过 QuotaLimit 检查
     ↓
  操作成功 → koaReportSubscriptionUpdates → void + trySafe 异步上报
```

### 场景 5：非私有区域创建 Custom Domain（手动上报）

```
请求 → POST /domains
     ↓
  await assertCustomDomainLimit({ isPrivateRegionFeature: false, ... })
     ↓
  await quota.guardTenantUsageByKey('customDomainsLimit')
     ↓
  业务逻辑：addDomain(domain)
     ↓
  void quota.reportSubscriptionUpdatesUsage('customDomainsLimit')
     ↓（不等待）
  返回 201 响应
```

### 场景 6：Cleanup 批量删除过期域名（无上报）

```
请求 → POST /domains/cleanup
     ↓
  const summary = await cleanupDomains(staleDays)
     ↓（内部可能删除多个域名）
  同步 SAML 应用重定向 URL
     ↓（无上报调用）
  返回 summary（含 deletedCount）
```

## 八、关键文件索引

| 文件 | 职责 |
|------|------|
| `packages/core/src/libraries/quota.ts` | 配额守卫核心逻辑（guardTenantUsageByKey 分支判断、assertSystemLimit、assertQuotaLimit） |
| `packages/core/src/middleware/koa-quota-guard.ts` | Koa 中间件包装 |
| `packages/core/src/queries/tenant-usage/types.ts` | 配额类型定义（isSystemUsageKey、isQuotaUsageKey、isBooleanQuotaUsageKey、SelfComputedUsageKey） |
| `packages/core/src/queries/tenant-usage/index.ts` | 使用量 SQL 查询 |
| `packages/core/src/libraries/subscription.ts` | 订阅数据获取与缓存 |
| `packages/core/src/utils/subscription/types.ts` | 订阅数据结构定义 |
| `packages/core/src/utils/subscription/index.ts` | 上报逻辑与 Add-on 判断（含 trySafe） |
| `packages/core/src/utils/domain.ts` | Custom Domain 私有区域分支 |
| `packages/core/src/routes/domain.ts` | Custom Domain 路由（手动调用上报 + cleanup 分支） |
| `packages/core/src/libraries/domain.ts` | Custom Domain 业务逻辑（cleanupDomains 实现） |
| `packages/core/src/caches/base-cache.ts` | 缓存键生成逻辑 |
| `packages/core/src/caches/tenant-subscription.ts` | 订阅缓存实现 |
