# 管理控制台特性开关与路由显隐策略

本文档从代码实现角度梳理管理控制台（Console）的特性开关读取、路由配置、权限叠加后的最终显隐策略。

---

## 1. 特性开关定义与读取

### 1.1 核心开关 `isDevFeaturesEnabled`

这是控制台最主要的特性开关，控制开发中功能的可见性。

**前端读取逻辑** (`packages/console/src/consts/env.ts:15-18`)：

```typescript
export const isDevFeaturesEnabled =
  !isProduction ||
  yes(normalizeEnv(import.meta.env.DEV_FEATURES_ENABLED)) ||
  yes(localStorage.getItem(storageKeys.isDevFeaturesEnabled));
```

**读取优先级（或逻辑，任一满足即为 `true`）**：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | `!isProduction` | 非生产环境默认为 `true` |
| 2 | 环境变量 `DEV_FEATURES_ENABLED` | 构建时注入的环境变量 |
| 3 | `localStorage` | 运行时用户可手动设置，存储 key 为 `isDevFeaturesEnabled` |

**后端读取逻辑** (`packages/shared/src/node/env/GlobalValues.ts:69`)：

```typescript
public readonly isDevFeaturesEnabled = !this.isProduction || yes(getEnv('DEV_FEATURES_ENABLED'));
```

> **注意**：后端读取不包含 localStorage 逻辑，仅依赖环境和环境变量。

### 1.2 其他环境开关

| 开关 | 定义位置 | 来源 | 说明 |
|------|---------|------|------|
| `isCloud` | `consts/env.ts:9` | `import.meta.env.IS_CLOUD` | 是否为云服务环境 |
| `isProduction` | `consts/env.ts:8` | `import.meta.env.PROD` | 是否为生产构建 |
| `isProtectedAppEnabled` | `consts/env.ts:12` | `isCloud \|\| isProtectedAppLocalDevEnabled` | 受保护应用功能是否启用 |

---

## 2. 路由层级与守卫链

### 2.1 整体路由结构

```
App.tsx
└── ConsoleRoutes (containers/ConsoleRoutes/index.tsx)
    └── [/:tenantId] 租户路径
        ├── callback
        ├── welcome
        ├── __internal__/import-error  (isDevFeaturesEnabled 控制)
        └── ProtectedRoutes 「认证守卫」
            ├── profile/*
            └── TenantAccess 「租户访问权限守卫」
                ├── onboarding  (!isCloud && isProduction && isDevFeaturesEnabled 控制)
                ├── checkout-success-callback  (isCloud 控制)
                └── OssOnboardingGuard 「OSS 入门流程守卫」
                    └── AppContent
                        ├── RedirectToFirstItem (默认重定向到第一个可见菜单)
                        └── ConsoleContent
                            ├── Sidebar (侧边栏菜单)
                            └── useConsoleRoutes (动态路由配置)
```

### 2.2 各守卫职责

| 守卫 | 位置 | 职责 |
|------|------|------|
| `ProtectedRoutes` | `containers/ProtectedRoutes/index.tsx` | 确保用户已认证，未认证则重定向到登录 |
| `TenantAccess` | `containers/TenantAccess/index.tsx` | 确保用户有权访问当前租户，无权限则重定向到首页 |
| `OssOnboardingGuard` | `containers/OssOnboardingGuard/index.tsx` | OSS 生产环境下强制完成入门流程，使用 `isDevFeaturesEnabled` 判断是否显示 |

### 2.3 路由级开关控制示例

在 `ConsoleRoutes/index.tsx` 中：

```typescript
// 仅开发特性启用时，暴露内部调试路由
{isDevFeaturesEnabled && (
  <Route path="__internal__/import-error" element={<__Internal__ImportError />} />
)}

// OSS 生产环境且开发特性启用时，显示入门流程
{!isCloud && isProduction && isDevFeaturesEnabled && (
  <Route path="onboarding" element={<OssOnboarding />} />
)}
```

---

## 3. 侧边栏菜单显隐逻辑

### 3.1 菜单数据结构

定义于 `containers/ConsoleContent/Sidebar/hook.tsx:23-36`：

```typescript
type SidebarItem = {
  Icon: FC;
  title: TFuncKey;
  isHidden?: boolean;      // 控制单个菜单项隐藏
  modal?: ReactNode;
  externalLink?: string;
  path?: string;
};

type SidebarSection = {
  title: TFuncKey;
  isHidden?: boolean;      // 控制整个菜单分组隐藏
  items: SidebarItem[];
};
```

### 3.2 显隐判断逻辑

**第一步：Hook 内过滤 section** (`hook.tsx:155`)：
```typescript
const enabledSections = allSections.filter((section) => !section.isHidden);
```

**第二步：渲染时过滤 item** (`index.tsx:32-33`)：
```typescript
{items.map(
  ({ title, Icon, isHidden, modal, externalLink, path }) =>
    !isHidden && (<Item ... />)
)}
```

**第三步：默认重定向目标过滤** (`hook.tsx:38-46`)：
```typescript
const findFirstItem = (sections: SidebarSection[]): Optional<SidebarItem> => {
  for (const section of sections) {
    const found = section.items.find((item) => !item.isHidden);
    if (found) return found;
  }
};
```

> **注意**：当前代码中 `isHidden` 字段在静态配置中均未设置值。特性开关和配额控制主要在**页面内部**进行，而非直接控制菜单项显隐。

### 3.3 当前菜单分组

| 分组 | 菜单项 |
|------|--------|
| `overview` | get_started, dashboard |
| `authentication` | applications, sign_in_experience, mfa, connectors, enterprise_sso, security |
| `authorization` | api_resources, roles, organization_template |
| `users` | organizations, users |
| `developer` | customize_jwt, webhooks, audit_logs |
| `tenant` | tenant_settings |

---

## 4. 配额（Quota）对功能的控制

配额数据来源于 `SubscriptionDataContext`，通过订阅 API 获取（云环境）或使用默认值（OSS 环境）。

配额控制**不在路由或菜单级别**，而是在**页面内部**精细控制各功能按钮和组件的显隐。

### 4.1 各功能配额控制详情

| 功能 | 配额字段 | 控制逻辑 | 代码位置 |
|------|---------|---------|----------|
| **MFA** | `mfaEnabled` | 付费计划才能使用，免费计划显示升级提示 | `pages/Mfa/PageWrapper/index.tsx:16-23` |
| **组织** | `organizationsLimit` | 云环境下需 `isFeatureEnabled(limit) && isPaidTenant` | `pages/Organizations/index.tsx:36-37` |
| **企业 SSO** | `enterpriseSsoLimit` | `!isCloud \|\| limit === null \|\| limit > 0` | `pages/EnterpriseSso/SsoCreationModal/index.tsx:62-65` |
| **自定义 JWT** | `customJwtEnabled` | `!isCloud \|\| customJwtEnabled` | `pages/CustomizeJwt/CreateButton/index.tsx:27` |
| **IdP 发起 SSO** | `idpInitiatedSsoEnabled` | `isDevFeaturesEnabled && isCloud && SAML && idpInitiatedSsoEnabled` | `pages/EnterpriseSsoDetails/index.tsx:70-77` |
| **安全功能** | `securityFeaturesEnabled` | 配额中定义，在各安全子功能中检查 | `consts/tenants.ts` |

### 4.2 配额检查工具函数

**`isFeatureEnabled`** (`utils/subscription.ts:120-122`)：
```typescript
export const isFeatureEnabled = (quota: Nullable<number>): boolean => {
  return quota === null || quota > 0;
};
```

**`hasSurpassedSubscriptionQuotaLimit`** (`contexts/SubscriptionDataProvider/utils.ts:36-38`)：
```typescript
export const hasSurpassedSubscriptionQuotaLimit = <T>(options) => 
  !isSubscriptionUsageWithInLimit(options);
```

**`shouldEnforcePaywallInUI`** (`utils/paywall.ts:25-40`)：
- Development 计划：仅 `tenantMembersLimit` 强制执行付费墙
- 其他计划：所有配额都强制执行付费墙

---

## 5. 权限（Scope）控制

### 5.1 租户成员权限

定义于 `hooks/use-current-tenant-scopes.ts:32-40`：

```typescript
const access = useMemo(
  () => ({
    canInviteMember: Boolean(scopes?.includes(TenantScope.InviteMember)),
    canRemoveMember: Boolean(scopes?.includes(TenantScope.RemoveMember)),
    canUpdateMemberRole: Boolean(scopes?.includes(TenantScope.UpdateMemberRole)),
    canManageTenant: Boolean(scopes?.includes(TenantScope.ManageTenant)),
  }),
  [scopes]
);
```

### 5.2 权限获取方式

云环境下通过 API 获取：
```
GET /api/tenants/:tenantId/members/:userId/scopes
```

OSS 环境下不调用此 API，`scopes` 为 `undefined`，所有权限判断默认为 `false`，但 OSS 环境不强制权限检查。

---

## 6. 最终显隐策略叠加

### 6.1 路由可访问性

```
路由可访问 = 
  ✓ 用户已认证 (ProtectedRoutes)
  AND
  ✓ 用户有权访问当前租户 (TenantAccess)
  AND
  ✓ OSS 入门流程已完成 (OssOnboardingGuard，仅 OSS 生产环境)
  AND
  ✓ 路由级特性开关满足 (如 isDevFeaturesEnabled)
```

### 6.2 菜单可见性

```
菜单可见 = 
  ✓ 所属 section.isHidden !== true
  AND
  ✓ 菜单项自身 isHidden !== true
```

### 6.3 页面内功能可见性

```
功能可见 = 
  ✓ 特性开关满足 (isDevFeaturesEnabled 等)
  AND
  ✓ 配额检查通过 (Quota limit)
  AND
  ✓ 权限检查通过 (TenantScope)
  AND
  ✓ 付费墙规则满足 (Paywall)
```

### 6.4 完整判断流程示例（以「创建企业 SSO 连接器」为例）

```
1. 路由 /enterprise-sso 可访问
   ↓
2. 侧边栏「enterprise_sso」菜单项可见 (isHidden 未设置)
   ↓
3. 进入页面后，点击「创建」按钮时检查：
   ├─ isCloud = false ? → 允许创建
   ├─ enterpriseSsoLimit = null ? → 允许创建
   └─ enterpriseSsoLimit > 0 ? → 允许创建
   ↓
4. 付费计划检查：isPaidTenant = true ? → 显示 Add-on 收费提示
   ↓
5. 最终允许创建
```

---

## 7. 关键开关来源汇总表

| 开关类型 | 来源 | 读取位置 |
|---------|------|----------|
| `isDevFeaturesEnabled` | 1. `!isProduction`<br>2. `DEV_FEATURES_ENABLED` 环境变量<br>3. `localStorage.isDevFeaturesEnabled` | `consts/env.ts:15-18` |
| `isCloud` | `IS_CLOUD` 环境变量 | `consts/env.ts:9` |
| `isProduction` | `import.meta.env.PROD` | `consts/env.ts:8` |
| 订阅配额 Quota | 云环境：`/api/tenants/:tenantId/subscription-usage`<br>OSS：`defaultSubscriptionQuota` | `contexts/SubscriptionDataProvider` |
| 租户权限 Scope | 云环境：`/api/tenants/:tenantId/members/:userId/scopes`<br>OSS：无 | `hooks/use-current-tenant-scopes.ts` |

---

## 8. 典型使用场景

### 8.1 新增一个受特性开关保护的页面

1. 在 `use-console-routes/routes/` 中定义路由配置
2. 在 `ConsoleRoutes/index.tsx` 或对应路由文件中用 `isDevFeaturesEnabled` 包裹
3. 在 `Sidebar/hook.tsx` 中添加菜单项，可选设置 `isHidden`
4. 页面内部根据需要添加配额和权限检查

### 8.2 新增一个配额控制的功能

1. 在 `SubscriptionQuota` 类型中添加对应字段
2. 在 `defaultSubscriptionQuota` 中设置默认值
3. 在页面组件中通过 `useContext(SubscriptionDataContext)` 获取配额
4. 使用 `isFeatureEnabled()` 或自定义逻辑判断显隐

### 8.3 手动开启开发特性（生产环境）

在浏览器控制台执行：
```javascript
localStorage.setItem('isDevFeaturesEnabled', 'true');
// 刷新页面后生效
```
