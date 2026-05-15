# Session、Consent 和 OIDC Grant 协同机制分析报告

## 1. Session（会话）存储内容分析

### 1.1 核心数据结构 (`OidcSessionInstancePayload`)

```typescript
{
  exp: number;           // 过期时间（秒级时间戳）
  iat: number;           // 签发时间（秒级时间戳）
  jti: string;           // JWT ID，唯一标识符
  uid: string;           // 会话唯一标识符
  kind: 'Session';       // 类型标记，固定为 'Session'
  loginTs: number;       // 登录时间戳
  accountId: string;     // 关联的用户账户ID
  authorizations?: {     // 客户端授权映射（client_id -> 授权详情）
    [clientId: string]: {
      sid?: string;      // 该客户端的会话ID
      grantId?: string;  // 关联的授权ID
      persistsLogout?: boolean;  // 登出后是否保留授权
    }
  };
}
```

### 1.2 Session 扩展数据 (`oidc_session_extensions` 表)

```typescript
{
  sessionUid: string;     // 会话UID（外键）
  accountId: string;      // 用户账户ID
  clientId: string | null;  // 关联的客户端ID
  lastSubmission: object | null;  // 最后一次交互提交的数据
  createdAt: Date;
  updatedAt: Date;
}
```

### 1.3 Session 的关键功能

1. **用户身份持久化**：通过 `accountId` 关联已认证的用户
2. **多客户端授权管理**：`authorizations` 字段存储每个客户端的授权状态
3. **登录上下文追溯**：`lastSubmission` 保存交互过程中的提交数据
4. **会话生命周期管理**：通过 `exp`（过期时间）和 `loginTs`（登录时间）管理会话有效性

---

## 2. Consent（授权同意）记录内容分析

### 2.1 Consent 的本质

Consent 不是一个独立的数据库实体，而是**交互流程中的一个步骤**，其结果最终存储在 **Grant** 中。

### 2.2 Consent 流程记录的数据

在 Consent 交互过程中，记录以下信息：

1. **缺失的 OIDC Scope** (`missingOIDCScope`)
   - 例如：`openid`, `profile`, `email`, `offline_access` 等

2. **缺失的资源 Scope** (`missingResourceScopes`)
   - 结构：`{ [resourceIndicator: string]: string[] }`
   - 例如：`{ "https://api.example.com": ["read", "write"] }`

3. **用户同意的 Scope**（通过 Grant 存储）
   - `grant.addOIDCScope(scopes)` - 添加 OIDC 标准 Scope
   - `grant.addResourceScope(indicator, scopes)` - 添加资源 Scope

4. **用户拒绝的 Scope**
   - `grant.rejectResourceScope(indicator, scopes)` - 拒绝特定资源 Scope

### 2.2 Consent 除了 Grant 之外的持久化记录

Consent 流程除了创建/更新 Grant 外，还会产生以下持久化记录：

#### 2.2.1 组织授权记录（`application_user_consent_organizations` 表）

当用户在授权页面选择了组织并提交同意时，系统会记录用户对应用的组织授权关系：

```typescript
// 数据结构
{
  id: string;
  tenantId: string;
  applicationId: string;  // 应用ID
  userId: string;         // 用户ID
  organizationId: string; // 组织ID
}
```

**记录时机**：用户在 Consent 页面选择组织并提交同意时
**代码对齐**（`routes/interaction/consent/index.ts:71-82`）：
```typescript
if (organizationIds?.length) {
  // 1. Assert that user is a member of all organizations
  await validateUserConsentOrganizationMembership(userId, organizationIds);

  // 2. Direct INSERT into relations table (NOT delete-then-insert)
  await queries.applications.userConsentOrganizations.insert(
    ...organizationIds.map((organizationId) => ({
      applicationId,
      userId,
      organizationId,
    }))
  );
}
```

**关键逻辑**：
1. 成员校验：先调用 `validateUserConsentOrganizationMembership()` 验证用户是所有所选组织的成员
2. 直接插入：批量 INSERT 授权关系记录（非先删后插）
   - 先删后插的 `replace()` 方法仅在管理 API 中使用，Consent 流程中使用的是直接 `insert()`

#### 2.2.2 Scope 拒绝记录（存储在 Grant 中）

当用户拒绝某些资源 Scope 时，这些拒绝信息会存储在 Grant 对象中：

```typescript
// 调用 grant.rejectResourceScope 方法
grant.rejectResourceScope(resourceIndicator, rejectedScopes.join(' '));
```

**存储位置**：`oidc_model_instances` 表中 Grant 实例的 payload
**作用**：确保后续授权流程不会再次请求已被拒绝的 Scope

#### 2.2.3 用户首次同意的应用ID

- 存储位置：`users` 表的 `applicationId` 字段
- 触发时机：用户第一次对任意第三方应用授权时
- 用途：记录用户第一次使用的应用，用于后续分析

#### 2.2.4 交互提交数据持久化到 Session Extensions

将 Interaction 的 `lastSubmission` 数据（包含登录上下文、MFA 验证信息等）持久化到 `oidc_session_extensions` 表：

```typescript
// 存储内容
{
  sessionUid: string;
  accountId: string;
  clientId?: string;
  lastSubmission: object;  // 交互提交的完整数据
  createdAt: Date;
  updatedAt: Date;
}
```

**用途**：
1. 为后续 JWT 自定义提供上下文
2. 审计和问题排查
3. 支持登录后的个性化流程

### 2.3 First-Party 自动同意 vs Third-Party 手动同意路径对比

| 维度 | First-Party 应用（内置应用） | Third-Party 应用（第三方应用） |
|------|-----------------------------|-------------------------------|
| **Consent 触发时机** | 不触发 Consent 页面，直接自动同意 | 触发 Consent 页面，需要用户手动确认 |
| **Scope 验证** | 无需为应用预先分配 Scope，用户拥有的所有 Scope 都可使用 | 必须在管理后台为应用预先分配 User Scopes、Resource Scopes、Organization Scopes |
| **组织选择** | 无组织选择流程 | 当请求 `urn:logto:scope:organizations` Scope 时，显示组织选择界面 |
| **交互路径** | 登录 → 直接授权成功 → 返回应用 | 登录 → Consent 页面（选择组织 + 确认 Scope）→ 授权成功 → 返回应用 |
| **Grant 创建时机** | 登录后自动创建 | 用户提交 Consent 后创建 |
| **持久化记录** | 仅创建 Grant 和 Session Authorization | 完整记录：Grant + Session Authorization + 组织授权 + 首次应用标记 |

#### 2.3.1 First-Party 自动同意流程

```
用户访问 /authorize 端点
      ↓
检测到是 First-Party 应用（isThirdParty = false）
      ↓
跳过 Consent 交互流程
      ↓
自动创建 Grant，包含所有请求的 Scope
      ↓
更新 Session.authorizations，关联 grantId
      ↓
直接发放 Authorization Code
```

#### 2.3.2 Third-Party 手动同意流程

```
用户访问 /authorize 端点
      ↓
检测到是 Third-Party 应用（isThirdParty = true）
      ↓
创建 Consent Interaction（prompt = consent）
      ↓
前端调用 GET /interaction/consent 获取授权信息
      ├─ 显示应用信息（名称、Logo、隐私政策等）
      ├─ 显示请求的 OIDC Scope（profile, email 等）
      ├─ 显示请求的 Resource Scope
      └─ 如果请求了 organizations Scope，显示组织列表供选择
      ↓
用户选择组织（如有），点击"同意"按钮
      ↓
前端调用 POST /interaction/consent 提交
      ├─ 验证用户组织成员身份
      ├─ 持久化组织授权关系
      ├─ 计算需要授予和拒绝的 Scope
      ├─ 创建/更新 Grant
      ├─ 记录首次同意应用ID（如果是第一次）
      ├─ 持久化 Interaction lastSubmission 到 Session Extensions
      └─ 更新 Interaction Result，标记 consent 完成
      ↓
OIDC Provider 检测到 consent 完成
      ↓
更新 Session.authorizations，关联 grantId
      ↓
发放 Authorization Code
```

---

## 3. OIDC Grant（授权）依赖机制

### 3.1 Grant 的核心属性

```typescript
{
  jti: string;           // 唯一标识符
  kind: 'Grant';         // 类型标记
  exp: number;           // 过期时间
  iat: number;           // 签发时间
  accountId: string;     // 用户账户ID
  clientId: string;      // 客户端应用ID
  // 授权的 Scope 信息（OIDC Scope 和 Resource Scope）
}
```

### 3.2 Grant 对 Session 的依赖

**创建依赖**：
- Grant 的创建必须在 Session 存在之后
- 从 `session.accountId` 获取用户身份
- 从交互参数中获取 `clientId`

**关联依赖**：
```typescript
// Session.authorizations 中存储与 Grant 的关联
session.authorizations = {
  [clientId]: {
    sid: string,        // 会话ID
    grantId: string,    // 指向 Grant 的外键
    persistsLogout: boolean
  }
};
```

**生命周期依赖**：
- 当 Session 被撤销时，关联的 Grant 也会被级联撤销
- Grant 可以独立于 Session 存在（非会话-backed 的授权）

### 3.3 Grant 对 Consent 的依赖

Consent 是 Grant 创建的**前置流程**：

1. **Scope 授予**：Consent 过程中用户同意的 Scope 会被添加到 Grant 中
2. **Scope 拒绝**：用户拒绝的 Scope 会被标记在 Grant 中
3. **Grant ID 返回**：Consent 完成后返回 `grantId` 给交互结果

### 3.4 Grant 复用/新建及回写会话授权的完整链路

#### 3.4.1 Grant 复用判定逻辑

当用户再次授权时，OIDC Provider 会优先尝试复用现有 Grant：

```typescript
// 位于 libraries/session/consent.ts 中
const grant =
  conditional(grantId && (await provider.Grant.find(grantId))) ??
  new provider.Grant({ accountId, clientId: String(client_id) });
```

**复用条件**：
1. Interaction Details 中存在 `grantId` 参数（表示之前已有授权记录）
2. 通过 `provider.Grant.find(grantId)` 能够找到该 Grant
3. Grant 尚未过期

**复用场景**：
- 用户对同一应用的第二次及以后授权
- 应用请求增量 Scope（在已有授权基础上请求新的 Scope）

**新建场景**：
- 用户第一次对该应用授权
- 之前的 Grant 已过期或被撤销
- Interaction Details 中没有 `grantId`

#### 3.4.2 Grant 创建/更新的完整流程

```
POST /interaction/consent 被调用
      ↓
1. 验证 Session 存在，获取 accountId
      ↓
2. 处理组织授权（如果有 organizationIds）
   ├─ 验证用户是所有组织的成员
   └─ 持久化到 application_user_consent_organizations 表
      ↓
3. 从 prompt.details 获取 missingOIDCScope 和 missingResourceScopes
      ↓
4. 重新计算需要授予的 Resource Scope（考虑组织权限）
   ├─ 应用级别 Resource Scope
   └─ 组织级别 Resource Scope（基于用户在组织中的角色）
      ↓
5. 计算需要拒绝的 Scope（用户未勾选或无权限的 Scope）
      ↓
6. Grant 复用或新建
   ├─ 如果存在 grantId 且可找到 → 复用现有 Grant
   └─ 否则 → 创建新 Grant
      ↓
7. 更新 Grant 中的 Scope
   ├─ grant.addOIDCScope(missingOIDCScopes)
   ├─ grant.addResourceScope(indicator, scopesToGrant)
   └─ grant.rejectResourceScope(indicator, scopesToReject)
      ↓
8. 保存 Grant（grant.save()）→ 返回 finalGrantId
      ↓
9. 副作用处理（并行）
   ├─ 保存用户首次同意的应用ID（如果是首次）
   └─ 持久化 Interaction lastSubmission 到 Session Extensions
      ↓
10. 更新 Interaction Result
    └─ provider.interactionResult(ctx.req, ctx.res, { consent: { grantId: finalGrantId } })
        ↓
    重定向到 /auth/:user_id/consent?uid=...
```

#### 3.4.3 Session Authorization 回写机制

**关键节点**：在 `authorization.success` 事件触发时完成

```
Interaction Consent 完成
      ↓
OIDC Provider 继续授权流程
      ↓
创建 Authorization Code
      ↓
触发 authorization.success 事件
      ↓
（可选）执行 maxAllowedGrants 限制检查
   ├─ 查询用户对该应用的所有活跃 Grant
   ├─ 如果超过限制，按创建时间排序，撤销最旧的 Grant
   │   ├─ revokeGrantChain（撤销 AccessToken、RefreshToken 等）
   │   └─ 从 Session.authorizations 中移除被撤销的 grantId
   └─ 继续当前授权流程
      ↓
OIDC Provider 自动更新 Session.authorizations
   └─ 写入：
      {
        [clientId]: {
          sid: string,           // Session ID
          grantId: finalGrantId, // 关联刚才创建/更新的 Grant
          persistsLogout: boolean
        }
      }
```

#### 3.4.4 会话授权的数据结构

存储在 `oidc_model_instances` 表的 Session 实例 payload 中：

```typescript
// OidcSessionInstancePayload.authorizations
{
  "client-123": {
    "sid": "session-abc",           // 会话标识符
    "grantId": "grant-xyz",         // 关联的 Grant ID（外键）
    "persistsLogout": false,        // 登出后是否保留授权
    // 其他 OIDC 标准字段
  },
  "client-456": {
    "sid": "session-abc",
    "grantId": "grant-123",
    "persistsLogout": true
  }
}
```

**特点**：
- 一个 Session 可以关联多个 Client 的 Grant（一对多）
- 每个 Client 在 Session 中只有一条授权记录
- `sid` 字段用于标识该客户端在当前会话中的会话 ID
- `persistsLogout` 控制用户登出时是否保留该 Grant

#### 3.4.5 Grant 与 Session 的双向关联查询

**正向查询（Session → Grant）**：
```typescript
// 从 Session.authorizations 中获取所有 grantId
const grantIds = Object.values(session.authorizations)
  .map(auth => auth.grantId)
  .filter(Boolean);
```

**反向查询（Grant → Session）**：
```typescript
// 通过 oidcModelInstances.findUserActiveSessionUidByGrantId 查询
const result = await queries.oidcModelInstances
  .findUserActiveSessionUidByGrantId(userId, grantId);
// 返回 { sessionUid: string }
```

**用途**：
- 撤销 Grant 时，需要找到关联的 Session 并清理 `session.authorizations` 中的对应条目
- Session 注销时，根据 `persistsLogout` 决定是否保留 Grant

---

## 4. 三者协同工作机制

### 4.1 完整的 OIDC 认证授权流程

```
用户访问 /authorization 端点
        ↓
[1] 检查是否存在有效 Session
    ├─ 不存在 → 创建 Login Interaction → 用户登录
    │                       ↓
    │               登录成功 → 创建 Session（含 accountId）
    │                       ↓
    └─ 存在 → 进入 Consent 检查
        ↓
[2] 检查是否需要 Consent
    ├─ 不需要（已有有效 Grant）→ 直接进入令牌发放
    │
    └─ 需要 → 创建 Consent Interaction
        ↓
[3] Consent 流程
    ├─ 获取缺失的 Scope (OIDC Scope + Resource Scope)
    ├─ 用户同意/拒绝 Scope
    ├─ 创建/更新 Grant（保存同意的 Scope）
    ├─ 保存用户首次同意的应用ID
    ├─ 将 Interaction lastSubmission 持久化到 Session 扩展
    └─ 返回 grantId
        ↓
[4] 更新 Session.authorizations
    └─ 在 Session 中记录 clientId 对应的 grantId
        ↓
[5] 发放令牌（Authorization Code）
    └─ Code 中引用 grantId
        ↓
[6] 令牌换取（Token Endpoint）
    └─ 通过 grantId 生成 AccessToken / RefreshToken / IdToken
```

### 4.2 关键交互点详解

#### 4.2.1 Session 与 Grant 的双向关联

```
Session                              Grant
┌─────────────────────────────┐      ┌────────────────────┐
│ authorizations: {           │      │ jti: "grant-123"   │
│   "client-a": {             │◄─────┤ accountId: "user-1"│
│     grantId: "grant-123"    │      │ clientId: "client-a"│
│   }                         │      │ scopes: ...        │
│ }                           │      └────────────────────┘
└─────────────────────────────┘
```

- **Session → Grant**：通过 `session.authorizations[clientId].grantId` 指针
- **Grant → Session**：通过反向查询（`findUserActiveSessionUidByGrantId`）

#### 4.2.2 Consent 作为 Session 和 Grant 的桥梁

```
          Consent 流程
      ┌──────────────────────┐
      │                      │
Session │  1. 提供 accountId   │  →  Grant
      │  2. 提供客户端上下文  │     │  1. 存储授权范围
      │  3. 接收 grantId     │     │  2. 记录授权时间
      │                      │     │  3. 关联用户和客户端
      └──────────────────────┘
```

### 4.3 撤销机制的级联关系

#### 4.3.1 撤销 Session 时的级联操作

```
撤销 Session
    ↓
1. 获取 Session.authorizations 中的所有 grantId
2. 对每个 grantId 执行 revokeGrantChain:
   ├─ 撤销 AccessToken
   ├─ 撤销 RefreshToken
   ├─ 撤销 AuthorizationCode
   ├─ 撤销 DeviceCode
   ├─ 撤销 BackchannelAuthenticationRequest
   └─ 撤销 Grant 本身
3. 清理 Session.authorizations 中已撤销的 grantId
4. 重置 Session 标识符
```

#### 4.3.2 撤销 Grant 时的 Session 清理

```
撤销 Grant (grantId)
    ↓
1. 通过 grantId 反向查找关联的 sessionUid
2. 找到对应的 Session
3. 从 Session.authorizations 中移除该 grantId 的条目
4. 保存 Session 变更
```

### 4.4 数据存储表关系

```
┌───────────────────────┐
│ oidc_model_instances  │  存储 Session、Grant 等所有 OIDC 模型实例
│ ───────────────────── │
│ modelName: 'Session'  │──┐
│ payload: jsonb        │  │
│ expiresAt: timestamp  │  │
└───────────────────────┘  │
                           │
┌───────────────────────┐  │
│ oidc_session_extensio │◄─┘  Session 扩展数据
│ ns                    │
│ ───────────────────── │
│ sessionUid: string    │  (关联 oidc_model_instances.payload.uid)
│ accountId: string     │
│ clientId: string      │
│ lastSubmission: jsonb │
└───────────────────────┘

┌───────────────────────┐
│ oidc_model_instances  │
│ ───────────────────── │
│ modelName: 'Grant'    │
│ payload: jsonb        │  包含 accountId, clientId, scopes 等
│ expiresAt: timestamp  │
└───────────────────────┘

┌───────────────────────┐
│ users                 │
│ ───────────────────── │
│ id: string            │
│ applicationId: string │  用户首次同意的应用ID（Consent 副作用）
└───────────────────────┘
```

---

## 5. 关键设计要点

### 5.1 为什么需要 Session 扩展表？

OIDC Provider 本身的 Session 在交互（Interaction）完成后会销毁原始交互数据，
因此 `oidc_session_extensions` 表用于：
1. 持久化交互提交的 `lastSubmission` 数据
2. 为 JWT 自定义等后续流程提供上下文
3. 快速查询用户的活动会话

### 5.2 Grant 的独立性设计

Grant 可以独立于 Session 存在，原因：
1. 支持非会话-backed 的授权流（如 Client Credentials）
2. Session 过期后，Refresh Token 仍可使用（通过 Grant）
3. 授权撤销可以精确到单个应用，不影响用户其他会话

### 5.3 Consent 的无状态设计

Consent 不独立存储，而是：
1. 作为流程步骤存在于 Interaction 中
2. 结果直接写入 Grant
3. 仅保留必要的副作用（如首次同意应用ID）

这种设计避免了数据冗余，确保授权状态的单一数据源。

---

## 6. 总结：三者关系概览

| 实体 | 核心职责 | 与其他实体的关系 |
|------|---------|-----------------|
| **Session** | 用户身份会话管理 | 1. 通过 `authorizations` 持有多个 Grant 引用<br>2. 为 Consent 提供用户身份上下文 |
| **Consent** | 用户授权同意流程 | 1. 作为 Session → Grant 的桥梁<br>2. 决定 Grant 中包含的 Scope |
| **Grant** | 授权凭证持有者 | 1. 从 Session 继承用户身份<br>2. 作为所有令牌（Access/Refresh/Code）的父实体<br>3. 可反向查询关联的 Session |

**核心原则**：
- Session 代表"用户已登录"
- Grant 代表"用户已授权给某应用"
- Consent 是用户从"登录"到"授权"的确认过程
