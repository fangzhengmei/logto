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
| 3 | `localStorage` | 运行时用户可手动设置 |

**后端读取逻辑** (`packages/shared/src/node/env/GlobalValues.ts:69`)：

```typescript
public readonly isDevFeaturesEnabled = !this.isProduction || yes(getEnv('DEV_FEATURES_ENABLED'));
```

> **注意**：后端读取不包含 localStorage 逻辑，仅依赖环境和环境变量。

### 1.2 本地存储键详情

定义于 `packages/console/src/consts/storage.ts:14-27`：

```typescript
export type StorageType =
  | 'is_dev_features_enabled'
  | ...;

export const getStorageKey = <T extends StorageType>(forType: T) =>
  `logto:admin_console:${forType}` as const;

export const storageKeys = Object.freeze({
  /** Whether the under-development features are enabled. */
  isDevFeaturesEnabled: getStorageKey('is_dev_features_enabled'),
  // => 实际存储键: "logto:admin_console:is_dev_features_enabled"
});
```

**完整存储键**：`logto:admin_console:is_dev_features_enabled`

### 1.3 手动开启开发特性（生产环境）

**正确方式**（在浏览器控制台执行）：

```javascript
// 设置（注意是完整的存储键）
localStorage.setItem('logto:admin_console:is_dev_features_enabled', 'true');

// 验证
console.log(localStorage.getItem('logto:admin_console:is_dev_features_enabled'));
// => "true"

// 刷新页面后生效
location.reload();

// 关闭开发特性
localStorage.removeItem('logto:admin_console:is_dev_features_enabled');
location.reload();
```

> **注意**：存储键带有 `logto:admin_console:` 前缀，直接使用 `isDevFeaturesEnabled` 作为 key **不会生效**。

### 1.4 其他环境开关

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
                            ├── useTenantScopeListener (权限变更监听)
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

## 3. 租户权限变更触发的重定向与重新授权链路

### 3.1 核心监听器 `useTenantScopeListener`

位置：`containers/ConsoleContent/hooks.ts:20-67`

这个 hook 仅在云环境下生效，监听租户权限（scope）的变更，并自动触发相应的处理流程。

```typescript
const useTenantScopeListener = () => {
  const { currentTenantId, removeTenant, navigateTenant } = useContext(TenantsContext);
  const { clearAccessToken, clearAllTokens, getOrganizationTokenClaims, signIn } = useLogto();
  const { scopes, isLoading } = useCurrentTenantScopes();
  
  // ...
};
```

### 3.2 权限数据对比机制

**第一步：获取当前 Token 中的权限声明** (`hooks.ts:27-33`)：
```typescript
useEffect(() => {
  (async () => {
    const organizationId = getTenantOrganizationId(currentTenantId);
    const claims = await getOrganizationTokenClaims(organizationId);
    setTokenClaims(claims?.scope?.split(' ') ?? []);
  })();
}, [currentTenantId, getOrganizationTokenClaims]);
```

**第二步：从 API 获取最新权限列表**：
通过 `useCurrentTenantScopes()` hook 调用 API：
```
GET /api/tenants/:tenantId/members/:userId/scopes
```

**第三步：对比两组权限** (`hooks.ts:48-49`)：
```typescript
// 新授予的权限：API 有但 Token 中没有
const hasScopesGranted = scopes?.some((scope) => !tokenClaims.includes(scope));

// 已撤销的权限：Token 中有但 API 中没有
const hasScopesRevoked = tokenClaims.some((claim) => !scopes?.includes(claim));
```

### 3.3 三种场景的处理流程

#### 场景 1：用户完全失去租户访问权限 (`scopes.length === 0`)

**触发条件** (`hooks.ts:35-42`)：
```typescript
if (isCloud && !isLoading && scopes?.length === 0) {
  removeTenant(currentTenantId);
  navigateTenant('');
}
```

**处理流程**：
```
scopes.length === 0
  ↓
调用 removeTenant() 从本地租户列表中移除该租户
  ↓
调用 navigateTenant('') 重定向到根路径
  ↓
根路径逻辑：返回最后访问的租户，或跳转到创建新租户页面
```

#### 场景 2：用户被授予新权限 (`hasScopesGranted = true`)

**触发条件** (`hooks.ts:50-59`)：
```typescript
if (hasScopesGranted) {
  saveRedirect();           // 保存当前页面，授权后返回
  await clearAllTokens();   // 清除所有 Token 缓存
  signIn({                  // 重新发起登录授权
    redirectUri: redirectUri.href,
    prompt: Prompt.Consent, // 强制显示同意页面
  });
}
```

**完整流程**：
```
检测到新权限 (API scopes ⊃ Token scopes)
  ↓
保存当前页面 URL 到 localStorage
  ↓
清除所有 Token (access token + refresh token)
  ↓
跳转到 Logto 授权页面，携带 prompt=consent
  ↓
用户同意授权，获取包含新权限的新 Token
  ↓
跳回之前保存的页面
  ↓
新权限立即生效，相关功能按钮变为可用
```

#### 场景 3：用户权限被撤销 (`hasScopesRevoked = true`)

**触发条件** (`hooks.ts:61-65`)：
```typescript
if (hasScopesRevoked) {
  clearAccessToken();  // 仅清除 access token
}
```

**处理流程**：
```
检测到权限被撤销 (Token scopes ⊃ API scopes)
  ↓
清除缓存的 access token
  ↓
后续请求自动使用 refresh token 获取新的 access token
  ↓
新 token 已排除已撤销的权限
  ↓
页面内权限检查 (`canManageTenant` 等) 自动变为 false
  ↓
相关功能按钮隐藏或禁用
```

### 3.4 权限变更链路时序图

```
管理员在后台修改成员权限
    │
    ▼
API 端权限数据库更新
    │
    ▼
Console 端 SWR 缓存自动过期 / 手动 revalidate
    │
    ▼
useCurrentTenantScopes 获取最新 scopes
    │
    ├─► scopes.length === 0 ──► 移除租户，跳转根路径
    │
    ├─► hasScopesGranted ──► 保存重定向，清除全部 Token，重新授权
    │
    └─► hasScopesRevoked ──► 清除 access token，自动刷新获取缩小范围的新 Token
    │
    ▼
页面内 useCurrentTenantScopes().access 反映最新权限
    │
    ▼
UI 自动更新（按钮隐藏/禁用、标签页裁剪等）
```

---

## 4. 侧边栏菜单显隐逻辑

### 4.1 菜单数据结构

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

### 4.2 显隐判断逻辑

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

### 4.3 当前菜单分组

| 分组 | 菜单项 |
|------|--------|
| `overview` | get_started, dashboard |
| `authentication` | applications, sign_in_experience, mfa, connectors, enterprise_sso, security |
| `authorization` | api_resources, roles, organization_template |
| `users` | organizations, users |
| `developer` | customize_jwt, webhooks, audit_logs |
| `tenant` | tenant_settings |

---

## 5. 租户设置页按权限和套餐裁剪标签页的路由构建逻辑

租户设置页面是最典型的「动态路由构建 + 标签页裁剪」示例。

### 5.1 云环境与 OSS 环境分流

位置：`hooks/use-console-routes/routes/tenant-settings.tsx:113`

```typescript
export const useTenantSettings = isCloud ? useCloudTenantSettings : useOssTenantSettings;
```

### 5.2 云环境租户设置路由构建

Hook：`useCloudTenantSettings` (`tenant-settings.tsx:32-83`)

**依赖的上下文数据**：
```typescript
const { isDevTenant } = useContext(TenantsContext);
const { currentSubscription: { quotaScope } } = useContext(SubscriptionDataContext);
const { access: { canInviteMember, canManageTenant } } = useCurrentTenantScopes();
```

**路由构建逻辑** (`tenant-settings.tsx:41-78`)：

```typescript
const tenantSettings: RouteObject = useMemo(() => ({
  path: 'tenant-settings',
  element: <TenantSettings />,
  children: condArray(
    // 1. 默认重定向：有管理权限跳转到设置，否则跳转到成员
    {
      index: true,
      element: (
        <Navigate
          replace
          to={canManageTenant ? TenantSettingsTabs.Settings : TenantSettingsTabs.Members}
        />
      ),
    },
    // 2. 始终可见的标签页
    { path: TenantSettingsTabs.Settings, element: <TenantBasicSettings /> },
    {
      path: `${TenantSettingsTabs.Members}/*`,
      element: <TenantMembers />,
      children: [
        { path: '*', element: <NotFound /> },
        { index: true, element: <Members /> },
        // 3. 邀请标签页：仅当有邀请权限时可见
        ...condArray(canInviteMember && [{ path: 'invitations', element: <Invitations /> }]),
      ],
    },
    { path: TenantSettingsTabs.Domains, element: <TenantDomainSettings /> },
    { path: TenantSettingsTabs.OidcConfigs, element: <OidcConfigs /> },
    // 4. 订阅和账单：仅非开发租户且有管理权限时可见
    !isDevTenant && canManageTenant && [
      { path: TenantSettingsTabs.Subscription, element: <Subscription /> },
      // 5. 账单历史：共享企业订阅配额时隐藏
      ...condArray(
        quotaScope !== 'shared' && [
          { path: TenantSettingsTabs.BillingHistory, element: <BillingHistory /> },
        ]
      ),
    ]
  ),
}), [canInviteMember, canManageTenant, isDevTenant, quotaScope]);
```

### 5.3 云环境标签页可见性规则

| 标签页 | 路由路径 | 可见条件 |
|--------|---------|---------|
| **Settings** | `/tenant-settings/settings` | 始终可见 |
| **Members** | `/tenant-settings/members` | 始终可见<br>子标签页 Invitations：`canInviteMember = true` |
| **Domains** | `/tenant-settings/domains` | 始终可见 |
| **OIDC Configs** | `/tenant-settings/oidc-configs` | 始终可见 |
| **Subscription** | `/tenant-settings/subscription` | `!isDevTenant && canManageTenant` |
| **Billing History** | `/tenant-settings/billing-history` | `!isDevTenant && canManageTenant && quotaScope !== 'shared'` |

### 5.4 UI 层标签页同步裁剪

位置：`pages/TenantSettings/index.tsx:33-59`

UI 层的标签页渲染逻辑与路由构建逻辑**完全一致**，确保不会出现「路由存在但标签页不可见」或「标签页可见但路由不存在」的情况：

```tsx
<TabNav className={styles.tabs}>
  <TabNavItem href={`/tenant-settings/${TenantSettingsTabs.Settings}`}>
    <DynamicT forKey="tenants.tabs.settings" />
  </TabNavItem>
  <TabNavItem href={`/tenant-settings/${TenantSettingsTabs.Domains}`}>...</TabNavItem>
  <TabNavItem href={`/tenant-settings/${TenantSettingsTabs.OidcConfigs}`}>...</TabNavItem>
  <TabNavItem href={`/tenant-settings/${TenantSettingsTabs.Members}`}>...</TabNavItem>
  {/* 与路由构建相同的条件判断 */}
  {!isDevTenant && canManageTenant && (
    <>
      <TabNavItem href={`/tenant-settings/${TenantSettingsTabs.Subscription}`}>...</TabNavItem>
      {quotaScope !== 'shared' && (
        <TabNavItem href={`/tenant-settings/${TenantSettingsTabs.BillingHistory}`}>...</TabNavItem>
      )}
    </>
  )}
</TabNav>
```

### 5.5 OSS 环境租户设置路由构建

Hook：`useOssTenantSettings` (`tenant-settings.tsx:85-111`)

OSS 环境标签页大幅简化，仅保留核心配置：

```typescript
const useOssTenantSettings = (): RouteObject =>
  useMemo(() => {
    const shouldShowMembersTab = shouldShowOssTenantMembersTab({ isCloud: false });
    // shouldShowMembersTab = !isCloud => 始终为 true

    return {
      path: 'tenant-settings',
      element: <OssTenantSettings />,
      children: [
        { index: true, element: <Navigate replace to={TenantSettingsTabs.OidcConfigs} /> },
        { path: TenantSettingsTabs.OidcConfigs, element: <OidcConfigs /> },
        ...condArray(
          shouldShowMembersTab && [
            { path: TenantSettingsTabs.Members, element: <OssTenantMembers /> },
          ]
        ),
      ],
    };
  }, []);
```

### 5.6 成员页面内的次级权限控制

位置：`pages/TenantSettings/TenantMembers/index.tsx:37-91`

即使路由存在且标签页可见，页面内部仍会根据权限进一步裁剪功能：

```tsx
function TenantMembers() {
  const { access: { canInviteMember } } = useCurrentTenantScopes();
  const isInvitationTab = match(`/tenant-settings/${TenantSettingsTabs.Members}/invitations`);

  return (
    <div className={styles.container}>
      {/* 仅当有邀请权限时，显示标签切换按钮和邀请按钮 */}
      {canInviteMember && (
        <div className={styles.tabButtons}>
          <Button>Members</Button>
          <Button>Invitations</Button>
          <Spacer />
          <Button type="primary">Invite Members</Button>
        </div>
      )}
      <Outlet />
      {/* 仅当有邀请权限时，显示邀请弹窗 */}
      {canInviteMember && <InviteMemberModal ... />}
    </div>
  );
}
```

> **关键点**：即使路由 `/tenant-settings/members/invitations` 不存在（`canInviteMember = false` 时未加入路由），如果用户手动输入 URL，由于父路由 `members/*` 存在，但 `<Outlet />` 渲染的子路由不匹配，会显示 `NotFound` 页面。

---

## 6. 配额（Quota）对功能的控制

配额数据来源于 `SubscriptionDataContext`，通过订阅 API 获取（云环境）或使用默认值（OSS 环境）。

配额控制**不在路由或菜单级别**，而是在**页面内部**精细控制各功能按钮和组件的显隐。

### 6.1 各功能配额控制详情

| 功能 | 配额字段 | 控制逻辑 | 代码位置 |
|------|---------|---------|----------|
| **MFA** | `mfaEnabled` | 付费计划才能使用，免费计划显示升级提示 | `pages/Mfa/PageWrapper/index.tsx:16-23` |
| **组织** | `organizationsLimit` | 云环境下需 `isFeatureEnabled(limit) && isPaidTenant` | `pages/Organizations/index.tsx:36-37` |
| **企业 SSO** | `enterpriseSsoLimit` | `!isCloud \|\| limit === null \|\| limit > 0` | `pages/EnterpriseSso/SsoCreationModal/index.tsx:62-65` |
| **自定义 JWT** | `customJwtEnabled` | `!isCloud \|\| customJwtEnabled` | `pages/CustomizeJwt/CreateButton/index.tsx:27` |
| **IdP 发起 SSO** | `idpInitiatedSsoEnabled` | `isDevFeaturesEnabled && isCloud && SAML && idpInitiatedSsoEnabled` | `pages/EnterpriseSsoDetails/index.tsx:70-77` |
| **安全功能** | `securityFeaturesEnabled` | 配额中定义，在各安全子功能中检查 | `consts/tenants.ts` |

### 6.2 配额检查工具函数

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

## 7. 权限（Scope）控制

### 7.1 租户成员权限

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

### 7.2 权限获取方式

云环境下通过 API 获取：
```
GET /api/tenants/:tenantId/members/:userId/scopes
```

OSS 环境下不调用此 API，`scopes` 为 `undefined`，所有权限判断默认为 `false`，但 OSS 环境不强制权限检查。

---

## 8. 最终显隐策略叠加

### 8.1 路由可访问性

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

### 8.2 菜单可见性

```
菜单可见 = 
  ✓ 所属 section.isHidden !== true
  AND
  ✓ 菜单项自身 isHidden !== true
```

### 8.3 页面内功能可见性

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

### 8.4 完整判断流程示例（以「租户设置-账单历史」为例）

```
1. 路由 /tenant-settings/billing-history 可访问性检查
   ├─ ✓ 用户已认证
   ├─ ✓ 用户有权访问当前租户
   └─ ✓ 路由构建时条件满足：
      ├─ isCloud = true
      ├─ !isDevTenant = true
      ├─ canManageTenant = true
      └─ quotaScope !== 'shared' = true
   ↓
2. 标签页可见性检查（与路由条件完全一致）
   └─ ✓ UI 层 TabNav 中条件满足，标签页显示
   ↓
3. 进入页面后，页面内功能检查
   └─ ✓ 所有按钮和操作均可使用（因为路由已保证权限）
   ↓
4. 权限变更场景
   ├─ 若 canManageTenant 变为 false：路由重建 → 标签页隐藏 → 访问 URL 显示 NotFound
   └─ 若 quotaScope 变为 'shared'：路由重建 → 账单历史标签页隐藏
```

---

## 9. 关键开关来源汇总表

| 开关类型 | 来源 | 读取位置 |
|---------|------|----------|
| `isDevFeaturesEnabled` | 1. `!isProduction`<br>2. `DEV_FEATURES_ENABLED` 环境变量<br>3. `localStorage['logto:admin_console:is_dev_features_enabled']` | `consts/env.ts:15-18` |
| `isCloud` | `IS_CLOUD` 环境变量 | `consts/env.ts:9` |
| `isProduction` | `import.meta.env.PROD` | `consts/env.ts:8` |
| 订阅配额 Quota | 云环境：`/api/tenants/:tenantId/subscription-usage`<br>OSS：`defaultSubscriptionQuota` | `contexts/SubscriptionDataProvider` |
| 租户权限 Scope | 云环境：`/api/tenants/:tenantId/members/:userId/scopes`<br>OSS：无 | `hooks/use-current-tenant-scopes.ts` |

---

## 10. 典型使用场景

### 10.1 新增一个受特性开关保护的页面

1. 在 `use-console-routes/routes/` 中定义路由配置
2. 在 `ConsoleRoutes/index.tsx` 或对应路由文件中用 `isDevFeaturesEnabled` 包裹
3. 在 `Sidebar/hook.tsx` 中添加菜单项，可选设置 `isHidden`
4. 页面内部根据需要添加配额和权限检查

### 10.2 新增一个配额控制的功能

1. 在 `SubscriptionQuota` 类型中添加对应字段
2. 在 `defaultSubscriptionQuota` 中设置默认值
3. 在页面组件中通过 `useContext(SubscriptionDataContext)` 获取配额
4. 使用 `isFeatureEnabled()` 或自定义逻辑判断显隐

### 10.3 手动开启开发特性（生产环境）

**正确方式**（注意完整的存储键）：

```javascript
// 开启
localStorage.setItem('logto:admin_console:is_dev_features_enabled', 'true');
location.reload();

// 关闭
localStorage.removeItem('logto:admin_console:is_dev_features_enabled');
location.reload();
```

> **错误方式**：`localStorage.setItem('isDevFeaturesEnabled', 'true')` — 缺少前缀，不会生效。

### 10.4 模拟权限变更测试

在云环境中，可以通过修改其他租户成员的权限来验证权限变更链路：

1. 用两个浏览器窗口登录不同账号（管理员 A 和成员 B）
2. 管理员 A 给成员 B 授予新权限或撤销现有权限
3. 观察成员 B 的控制台：
   - 授予新权限：自动跳转到授权页面，同意后返回原页面
   - 撤销权限：页面静默刷新，相关功能按钮消失
   - 移除所有权限：自动跳转回租户选择页面
