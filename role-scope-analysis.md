# 角色与 Scope 映射到应用级权限逻辑分析

## 1. 核心数据模型

### 1.1 主要数据表

| 表名 | 说明 | 关键字段 |
|------|------|----------|
| `roles` | 角色表 | `id`, `name`, `description`, `type` |
| `scopes` | 权限范围表 | `id`, `name`, `description`, `resourceId` |
| `roles_scopes` | 角色-Scope关联表 | `id`, `roleId`, `scopeId` |
| `applications_roles` | 应用-角色关联表 | `id`, `applicationId`, `roleId` |
| `users_roles` | 用户-角色关联表 | `id`, `userId`, `roleId` |

### 1.2 角色类型

```typescript
enum RoleType {
  User = 'User',           // 用户角色
  MachineToMachine = 'MachineToMachine'  // 机器对机器应用角色
}
```

---

## 2. 角色与 Scope 配置流程

### 2.1 角色管理

**文件位置**: `packages/core/src/queries/roles.ts`

核心操作：
- `findRolesByRoleIds(roleIds: string[])` - 根据ID查找角色
- `findDefaultRoles(type: RoleType)` - 查找默认角色
- `insertRole(role: CreateRole)` - 创建角色
- `updateRoleById(id: string, data: Partial<Role>)` - 更新角色

### 2.2 Scope 管理

**文件位置**: `packages/core/src/queries/scopes.ts`

核心操作：
- `findScopesByIds(scopeIds: string[])` - 根据ID查找Scope
- `findScopesByResourceId(resourceId: string)` - 按资源查找Scope
- `findScopesByIdsAndResourceIndicator(scopeIds: string[], resourceIndicator: string)` - 根据资源标识符过滤Scope

### 2.3 角色-Scope 关联

**文件位置**: `packages/core/src/queries/roles-scopes.ts`

核心操作：
- `findRolesScopesByRoleId(roleId: string)` - 查找角色的所有Scope关联
- `findRolesScopesByRoleIds(roleIds: string[])` - 批量查找角色的Scope关联
- `insertRolesScopes(rolesScopes: CreateRolesScope[])` - 为角色分配Scope

**验证逻辑** (`packages/core/src/libraries/role-scope.ts`):
- 确保 Scope 未重复分配给角色
- 确保管理 API Scope 不能分配给用户类型角色

---

## 3. 应用级权限映射流程

### 3.1 应用-角色关联

**文件位置**: `packages/core/src/queries/applications-roles.ts`

核心操作：
- `findApplicationsRolesByApplicationId(applicationId: string)` - 查找应用的所有角色
- `findApplicationsRolesByRoleId(roleId: string)` - 查找角色分配给哪些应用
- `insertApplicationsRoles(applicationsRoles: CreateApplicationsRole[])` - 为应用分配角色

### 3.2 应用权限查找核心逻辑

**文件位置**: `packages/core/src/libraries/application.ts:46-60`

```typescript
const findApplicationScopesForResourceIndicator = async (
  applicationId: string,
  resourceIndicator: string
): Promise<readonly Scope[]> => {
  // 1. 查找应用关联的所有角色
  const applicationsRoles = await findApplicationsRolesByApplicationId(applicationId);
  
  // 2. 根据角色ID查找所有角色-Scope关联
  const rolesScopes = await findRolesScopesByRoleIds(
    applicationsRoles.map(({ roleId }) => roleId)
  );
  
  // 3. 根据资源标识符过滤出对应的Scope
  const scopes = await findScopesByIdsAndResourceIndicator(
    rolesScopes.map(({ scopeId }) => scopeId),
    resourceIndicator
  );

  return scopes;
};
```

### 3.3 流程图示

```
应用 (Application)
     ↓
applications_roles (应用-角色关联表)
     ↓  [通过 applicationId 查找 roleId]
角色 (Role)
     ↓
roles_scopes (角色-Scope关联表)
     ↓  [通过 roleId 查找 scopeId]
Scope (权限范围)
     ↓  [通过 resourceIndicator 过滤]
应用级权限 (Application Scopes for Resource)
```

---

## 4. 用户级权限映射流程

### 4.1 用户-角色关联

**文件位置**: `packages/core/src/queries/users-roles.ts`

核心操作：
- `findUsersRolesByUserId(userId: string)` - 查找用户的所有角色
- `insertUsersRoles(usersRoles: CreateUsersRole[])` - 为用户分配角色

### 4.2 用户权限查找核心逻辑

**文件位置**: `packages/core/src/libraries/user.ts:161-183`

```typescript
const findUserScopesForResourceIndicator = async (
  userId: string,
  resourceIndicator: string,
  findFromOrganizations = false,
  organizationId?: string
): Promise<readonly Scope[]> => {
  // 1. 查找用户关联的所有角色
  const usersRoles = await findUsersRolesByUserId(userId);
  
  // 2. 根据角色ID查找所有角色-Scope关联
  const rolesScopes = await findRolesScopesByRoleIds(usersRoles.map(({ roleId }) => roleId));
  
  // 3. (可选) 查找组织角色中的Scope
  const organizationScopes = findFromOrganizations
    ? await organizations.relations.usersRoles.getUserResourceScopes(
        userId,
        resourceIndicator,
        organizationId
      )
    : [];

  // 4. 根据资源标识符过滤出对应的Scope
  const scopes = await findScopesByIdsAndResourceIndicator(
    [...rolesScopes.map(({ scopeId }) => scopeId), ...organizationScopes.map(({ id }) => id)],
    resourceIndicator
  );

  return scopes;
};
```

---

## 5. Scope 进入访问令牌的完整链路

### 5.1 资源 Scope 查找入口

**文件位置**: `packages/core/src/oidc/resource.ts:34-96`

```typescript
export const findResourceScopes = async ({
  queries,
  libraries,
  userId,
  applicationId,
  indicator,
  organizationId,
  findFromOrganizations,
}: {
  queries: Queries;
  libraries: Libraries;
  indicator: string;
  findFromOrganizations: boolean;
  userId?: string;
  applicationId?: string;
  organizationId?: string;
}): Promise<ReadonlyArray<{ name: string; id: string }>> => {
  if (isReservedResource(indicator)) {
    // 处理保留资源（如 Organization）
  }

  if (userId) {
    // 用户模式：查找用户在该资源下的Scope
    return findUserScopesForResourceIndicator(userId, indicator, findFromOrganizations, organizationId);
  }

  if (applicationId && organizationId) {
    // 应用+组织模式：查找应用在特定组织下的Scope
    return queries.organizations.relations.appsRoles.getApplicationResourceScopes(organizationId, applicationId, indicator);
  }

  if (applicationId) {
    // 应用模式：查找应用在该资源下的Scope
    return findApplicationScopesForResourceIndicator(applicationId, indicator);
  }

  return [];
};
```

### 5.2 OIDC Provider 配置 - 获取资源服务器信息

**文件位置**: `packages/core/src/oidc/init.ts:91-135`

```typescript
const getResourceServerInfoCore = async (
  indicator: string,
  clientId: string | undefined,
  userId: string | undefined,
  organizationId: string | undefined
): Promise<Pick<ResourceServer, 'accessTokenFormat' | 'jwt' | 'accessTokenTTL' | 'scope'>> => {
  const resourceServer = await findResource(queries, indicator);

  if (!resourceServer) {
    throw new errors.InvalidTarget();
  }

  const { accessTokenTtl: accessTokenTTL } = resourceServer;

  // 关键：查找该资源下可用的Scope
  const scopes = await findResourceScopes({
    queries,
    libraries,
    indicator,
    findFromOrganizations: true,
    organizationId,
    applicationId: clientId,
    userId,
  });

  // 第三方应用额外过滤：只允许用户同意的Scope
  if (clientId && (await isThirdPartyApplication(queries, clientId))) {
    const filteredScopes = await filterResourceScopesForTheThirdPartyApplication(
      libraries,
      clientId,
      indicator,
      scopes
    );

    return {
      ...getSharedResourceServerData(envSet),
      accessTokenTTL,
      scope: filteredScopes.map(({ name }) => name).join(' '),
    };
  }

  return {
    ...getSharedResourceServerData(envSet),
    accessTokenTTL,
    scope: scopes.map(({ name }) => name).join(' '),
  };
};
```

---

## 6. 分支一：应用直连（Client Credentials）流程

### 6.1 流程概述

**文件位置**: `packages/core/src/oidc/grants/client-credentials.ts`

Client Credentials 流程用于 M2M（机器到机器）应用直接获取访问令牌，无需用户参与。

### 6.2 完整流程

```
1. 客户端认证
     ↓
2. 验证 organization_id 参数验证（可选）
     ↓
3. 检查资源服务器 (resource 参数)
     ↓
4. 解析请求的 scope
     ↓
5. 验证 scope 是否在客户端允许的范围内
     ↓
6. 创建 ClientCredentials 令牌
     ↓
7. （有资源服务器时：过滤 scope 到资源服务器允许的范围
     ↓
8. （有 organization_id 且无资源服务器时：处理组织令牌
     ↓
9. 颁发访问令牌（含 scope）
```

### 6.3 Scope 判定口径：直接拒绝 vs 交集过滤

#### 6.3.1 直接拒绝的 Scope（硬校验）

**校验位置**: `packages/core/src/oidc/grants/client-credentials.ts:99-107`

```typescript
if (client.scope) {
  const allowList = new Set(client.scope.split(' '));

  for (const scope of scopes.filter(Set.prototype.has.bind(statics))) {
    if (!allowList.has(scope)) {
      throw new InvalidScope('requested scope is not allowed', scope);
    }
  }
}
```

**判定逻辑**:
- 仅针对 **OIDC 静态 scope**（`statics` 集合中的 scope，如 `openid`, `profile`, `email`, `offline_access` 等）
- 请求的静态 scope **必须** 在应用的 `client.scope` 允许列表中
- **不满足直接抛出 `InvalidScope` 错误，终止流程**

---

#### 6.3.2 交集过滤的 Scope（软过滤）

以下场景下，Scope 只做交集过滤，不满足不会直接报错，而是从最终令牌中移除：

| 场景 | 校验位置 | 交集逻辑 |
|------|---------|----------|
| 有 resource 参数（资源服务器模式） | `client-credentials.ts:121-123` | `请求 scope ∩ 资源服务器可用 scope` |
| 有 `organization_id` 且无 `resource`（组织令牌模式） | `grants/utils.ts:176` | `请求 scope ∩ 组织角色可用 scope` |
| 第三方应用授权 | `oidc/resource.ts:139-203` | `可用 scope ∩ 用户已同意的 scope` |

**代码示例（资源服务器模式）**:
```typescript
if (resourceServer) {
  token.scope =
    scopes.filter(Set.prototype.has.bind(new Set(resourceServer.scope.split(' ')))).join(' ') ||
    undefined;
}
```

---

#### 6.3.3 resource 与 organization_id 都缺失时的失败返回

**校验位置**: `packages/core/src/oidc/grants/client-credentials.ts:91-93`

```typescript
if (!organizationId && length === 0) {
  throw new InvalidTarget('both `resource` and `organization_id` are not provided');
}
```

**判定条件**:
- `!organizationId`: 请求中未提供 `organization_id` 参数
- `length === 0`: `ctx.oidc.resourceServers` 为空（未找到有效的 resource）

**失败返回**:
- 错误类型: `InvalidTarget`
- HTTP 状态码: 400
- 错误消息: `both 'resource' and 'organization_id' are not provided`

---

### 6.4 关键判断点与失败返回（完整版）

| 步骤 | 判断条件 | 错误类型 | HTTP状态码 | 校验类型 |
|------|---------|----------|-----------|---------|
| 客户端认证 | 客户端 ID/密钥无效 | `InvalidClient` | 401 | 硬拒绝 |
| 组织关联验证 | 应用未关联到请求的组织 | `AccessDenied` | 403 | 硬拒绝 |
| resource/organization_id 验证 | 两者都未提供 | `InvalidTarget` | 400 | 硬拒绝 |
| 资源验证 | 资源标识符无效 | `InvalidTarget` | 400 | 硬拒绝 |
| 静态 Scope 允许性 | 请求的静态 scope 不在客户端允许范围内 | `InvalidScope` | 400 | 硬拒绝 |
| 多资源 | 同时请求多个资源 | `InvalidTarget` | 400 | 硬拒绝 |
| 资源 Scope 过滤 | 请求的 scope 不在资源可用范围内 | - | - | 交集过滤 |
| 组织 Scope 过滤 | 请求的 scope 不在组织角色可用范围内 | - | - | 交集过滤 |

### 6.4 组织令牌特殊处理

当提供 `organization_id` 且无 `resource` 参数时：

```typescript
// 1. 查找应用在该组织下的所有可用Scope
const availableScopes = await queries.organizations.relations.appsRoles
  .getApplicationScopes(organizationId, client.clientId)
  .then((scope) => scope.map(({ name }) => name));

// 2. 计算请求Scope与可用Scope的交集
const issuedScopes = availableScopes.filter((name) => scope.has(name)).join(' ');

// 3. 设置组织URN作为audience
token.aud = buildOrganizationUrn(organizationId);
token.scope = issuedScopes;
```

---

## 7. 用户授权相关流程：Authorization Code + Refresh Token + Token Exchange

### 7.1 流程边界与调用链说明

**重要修正**：`checkOrganizationAccess`（组织成员、组织MFA、第三方同意检查）**不**在 Authorization Code 主流程中被调用，仅在以下两个 grant type 的 token 颁发阶段执行：

| Grant Type | 调用 `checkOrganizationAccess` 位置 | 调用时机 |
|-----------|------------------------------------|---------|
| **refresh_token** | `packages/core/src/oidc/grants/refresh-token.ts:162` | 用 Refresh Token 换新 Access Token 时 |
| **urn:ietf:params:oauth:grant-type:token-exchange** | `packages/core/src/oidc/grants/token-exchange/index.ts:106` | Token 交换时 |
| **authorization_code** | ❌ 不调用 | Code 换 Token 时不做组织访问检查 |

**Scope 确定的统一入口**：`packages/core/src/oidc/init.ts:202-209`

```typescript
getResourceServerInfo: async (ctx, indicator) => {
  const { client, params, session, entities } = ctx.oidc;
  const userId = session?.accountId ?? entities.Account?.accountId;
  const organizationId =
    typeof params?.organization_id === 'string' ? params.organization_id : undefined;

  // 所有 Grant Type 都通过此入口获取资源 Scope
  return getResourceServerInfoCore(indicator, client?.clientId, userId, organizationId);
};
```

---

### 7.2 流程一：Authorization Code 主流程

**适用场景**：用户通过浏览器授权，用 Code 换 Token

```
1. 用户访问 /authorize 端点
     ↓
2. 重定向到登录页面（未登录时）
     ↓
3. 用户登录认证
     ↓
4. 显示同意页面（需要用户同意时）
     ↓
5. 用户同意授权
     ↓
6. 生成 Authorization Code
     ↓
7. 客户端用 Code 交换 Token
     ↓
8. 验证 Code 有效性
     ↓
9. ⚠️ 注意：此处不调用 checkOrganizationAccess
     ↓
10. 通过 getResourceServerInfoCore 获取资源 Scope
     ↓
11. 颁发访问令牌（含 scope）
```

**关键判断点**：
| 步骤 | 判断条件 | 错误类型 | HTTP状态码 |
|------|---------|----------|-----------|
| Code 验证 | Authorization Code 无效或已使用 | `InvalidGrant` | 400 |
| 会话验证 | 会话不存在或已过期 | `InvalidGrant` | 400 |
| 用户存在 | 用户已被删除 | `InvalidGrant` | 400 |
| 重定向URI | 不匹配注册的 redirect_uri | `InvalidGrant` | 400 |

---

### 7.3 流程二：Refresh Token 流程

**适用场景**：用过期的 Refresh Token 换新的 Access Token

**文件位置**: `packages/core/src/oidc/grants/refresh-token.ts`

```
1. 客户端发送 refresh_token 请求
     ↓
2. 验证 Refresh Token 有效性、未过期、未被使用
     ↓
3. 验证 Grant 有效性
     ↓
4. ✅ 调用 checkOrganizationAccess（组织成员、MFA、第三方同意检查）
     ↓
5. 验证 Refresh Token 有 Organizations scope（请求组织令牌时）
     ↓
6. （可选）旋转 Refresh Token
     ↓
7. 通过 getResourceServerInfoCore 获取资源 Scope
     ↓
8. 颁发新的访问令牌（含 scope）
```

**新增错误类型**：
| 判断条件 | 错误类型 | HTTP状态码 |
|---------|----------|-----------|
| Refresh Token 缺少 Organizations scope | `InsufficientScope` | 400 |
| 用户不是组织成员 | `AccessDenied` | 403 |
| 组织要求MFA但用户未配置 | `AccessDenied` | 403 |
| 用户未同意第三方应用访问组织 | `AccessDenied` | 403 |

---

### 7.4 流程三：Token Exchange 流程

**适用场景**：Token 交换（如用户模拟、服务账号委托等）

**文件位置**: `packages/core/src/oidc/grants/token-exchange/index.ts`

```
1. 客户端发送 token_exchange 请求
     ↓
2. 验证 Subject Token 有效性
     ↓
3. ✅ 调用 checkOrganizationAccess（组织成员、MFA、第三方同意检查）
     ↓
4. （可选）验证 Actor Token
     ↓
5. 通过 getResourceServerInfoCore 获取资源 Scope
     ↓
6. 颁发新的访问令牌（含 scope 和 act 声明）
```

---

### 7.5 组织访问检查（checkOrganizationAccess）

**调用位置**：仅在 Refresh Token 和 Token Exchange 流程中

**文件位置**: `packages/core/src/oidc/grants/utils.ts:97-154`

```typescript
export const checkOrganizationAccess = async (
  ctx: KoaContextWithOIDC,
  queries: Queries,
  account: Account,
  isThirdParty?: boolean
): Promise<{ organizationId?: string }> => {
  const { client, params } = ctx.oidc;
  const organizationId = cond(Boolean(params.organization_id) && String(params.organization_id));

  if (organizationId) {
    // 1. 检查用户是否为组织成员
    if (!(await queries.organizations.relations.users.exists({
      organizationId,
      userId: account.accountId,
    }))) {
      throw new AccessDenied('user is not a member of the organization');
    }

    // 2. 检查第三方应用是否已获得用户对该组织的授权
    if ((isThirdParty ?? (await isThirdPartyApplication(queries, client.clientId))) &&
      !(await isOrganizationConsentedToApplication(queries, client.clientId, account.accountId, organizationId))) {
      throw new AccessDenied('organization access is not granted to the application');
    }

    // 3. 检查组织MFA要求
    const { isMfaRequired, hasMfaConfigured } = await queries.organizations.getMfaStatus(organizationId, account.accountId);
    if (isMfaRequired && !hasMfaConfigured) {
      throw new AccessDenied('organization requires MFA but user has no MFA configured');
    }
  }

  return { organizationId };
};
```

---

### 7.6 按 Grant Type 区分的失败返回对照表

| 失败场景 | authorization_code | refresh_token | token_exchange | client_credentials | 错误类型 | HTTP状态码 |
|---------|-------------------|---------------|---------------|--------------------|---------|-----------|
| Code/Token 无效或已过期 | ✅ | ✅ (Refresh Token) | ✅ (Subject Token) | ❌ | `InvalidGrant` | 400 |
| 会话不存在或已过期 | ✅ | ❌ | ❌ | ❌ | `InvalidGrant` | 400 |
| 用户已被删除 | ✅ | ✅ | ✅ | ❌ | `InvalidGrant` | 400 |
| 重定向URI不匹配 | ✅ | ❌ | ❌ | ❌ | `InvalidGrant` | 400 |
| 客户端认证失败 | ✅ | ✅ | ✅ | ✅ | `InvalidClient` | 401 |
| 应用未关联到组织 | ❌ | ❌ | ❌ | ✅ | `AccessDenied` | 403 |
| **用户不是组织成员** | ❌ | ✅ | ✅ | ❌ | `AccessDenied` | 403 |
| **组织要求MFA但用户未配置** | ❌ | ✅ | ✅ | ❌ | `AccessDenied` | 403 |
| **用户未同意第三方应用访问组织** | ❌ | ✅ | ✅ | ❌ | `AccessDenied` | 403 |
| Refresh Token 缺少 Organizations scope | ❌ | ✅ | ❌ | ❌ | `InsufficientScope` | 400 |
| 请求的静态 scope 不在客户端允许范围内 | ✅ | ✅ | ❌ | ✅ | `InvalidScope` | 400 |
| resource 和 organization_id 都未提供 | ❌ | ❌ | ❌ | ✅ | `InvalidTarget` | 400 |
| 同时请求多个资源 | ❌ | ❌ | ❌ | ✅ | `InvalidTarget` | 400 |
| 资源标识符无效 | ❌ | ❌ | ❌ | ✅ | `InvalidTarget` | 400 |
| DPoP proof 未提供或验证失败 | ❌ | ✅ | ✅ | ✅ | `InvalidGrant` | 400 |
| mTLS 客户端证书未提供 | ❌ | ✅ | ✅ | ✅ | `InvalidGrant` | 400 |

> **图例**：✅ = 该 Grant Type 会触发此错误；❌ = 不触发
>
> **关键发现**：组织相关的三个检查（成员、MFA、第三方同意）**仅**在 `refresh_token` 和 `token_exchange` 中执行，`authorization_code` 主流程**不**做这些检查。

---

## 8. 资源访问时的 Scope 校验

### 8.1 API 请求权限验证中间件

**文件位置**: `packages/core/src/middleware/koa-auth/index.ts`

```typescript
export const verifyBearerTokenFromRequest = async (
  envSet: EnvSet,
  request: Request,
  audience: Optional<string>
): Promise<TokenInfo> => {
  try {
    const [keys, issuer] = await getKeysAndIssuer();
    const {
      payload: { sub, client_id: clientId, scope = '' },
    } = await jwtVerify(
      extractBearerTokenFromHeaders(request.headers),
      createLocalJWKSet({ keys }),
      {
        issuer,
        audience,
      }
    );

    assertThat(sub, new RequestError({ code: 'auth.jwt_sub_missing', status: 401 }));

    return { sub, clientId, scopes: z.string().parse(scope).split(' ') };
  } catch (error: unknown) {
    if (error instanceof RequestError) {
      throw error;
    }
    throw new RequestError({ code: 'auth.unauthorized', status: 401 }, error);
  }
};
```

### 8.2 管理 API Scope 检查

```typescript
const authMiddleware = async (ctx, next) => {
  const { sub, clientId, scopes } = await verifyBearerTokenFromRequest(
    envSet,
    ctx.request,
    audience
  );

  // 关键：验证 token 包含必要的 Scope
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
```

---

### 8.6 资源服务器端 Scope 校验流程

```
1. 从请求头提取 Bearer Token
     ↓
2. 验证 Token 签名（使用 JWKS）
     ↓
3. 验证 issuer (iss)
     ↓
4. 验证 audience (aud)
     ↓
5. 验证 Token 未过期 (exp)
     ↓
6. 从 Token payload 提取 scope 字段
     ↓
7. 检查所需 Scope 是否在 Token 的 scope 列表中
     ↓
8. 通过则允许访问，否则返回 403 Forbidden
```

---

### 8.7 常见校验失败场景

| 失败场景 | 错误代码 | HTTP状态码 | 说明 |
|---------|---------|-----------|------|
| Token 格式错误 | `auth.unauthorized` | 401 | Bearer Token 格式不正确 |
| 签名验证失败 | `auth.unauthorized` | 401 | Token 签名无效或已篡改 |
| issuer 不匹配 | `auth.unauthorized` | 401 | Token 颁发者不被信任 |
| audience 不匹配 | `auth.unauthorized` | 401 | Token 受众不匹配 |
| Token 已过期 | `auth.unauthorized` | 401 | Token 超过有效期 |
| sub 缺失 | `auth.jwt_sub_missing` | 401 | Token 缺少 subject 声明 |
| Scope 不足 | `auth.forbidden` | 403 | Token 缺少必要的 Scope |

---

## 9. 完整链路总览

### 9.1 应用直连（Client Credentials）完整链路

```
应用配置角色
     ↓
[配置角色-Scope关联
     ↓
[配置应用-角色关联
     ↓
客户端请求 /token (grant_type=client_credentials)
     ↓
验证客户端凭据
     ↓
检查应用-角色关联
     ↓
获取角色关联的Scope
     ↓
按资源标识符过滤Scope
     ↓
生成含 scope 的访问令牌
     ↓
客户端携带 Token 访问资源服务器
     ↓
资源服务器验证 Token 签名
     ↓
验证 Token 中的 scope 包含所需权限
     ↓
授权访问
```

### 9.2 用户授权（Authorization Code）完整链路

```
用户配置角色
     ↓
配置角色-Scope关联
     ↓
配置用户-角色关联
     ↓
用户通过浏览器访问 /authorize
     ↓
用户登录认证
     ↓
（第三方应用：显示同意页面
     ↓
用户同意授权
     ↓
生成 Authorization Code
     ↓
客户端用 Code 换 Token
     ↓
查找用户-角色关联
     ↓
获取角色关联的Scope
     ↓
按资源标识符过滤Scope
     ↓
生成含 scope 的访问令牌
     ↓
客户端携带 Token 访问资源服务器
     ↓
资源服务器验证 Token 签名
     ↓
验证 Token 中的 scope 包含所需权限
     ↓
授权访问
```

---

## 10. REST API 端点

### 10.1 角色-Scope 管理

**文件位置**: `packages/core/src/routes/role.scope.ts`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/roles/:id/scopes` | 获取角色的Scope列表 |
| POST | `/roles/:id/scopes` | 为角色分配Scope |
| DELETE | `/roles/:id/scopes/:scopeId` | 移除角色的Scope |

### 10.2 角色-应用管理

**文件位置**: `packages/core/src/routes/role.application.ts`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/roles/:id/applications` | 获取角色关联的应用列表 |
| POST | `/roles/:id/applications` | 为角色分配应用 |
| DELETE | `/roles/:id/applications/:applicationId` | 移除角色的应用关联 |

---

## 11. 关键文件索引

| 文件路径 | 功能说明 |
|----------|----------|
| `packages/core/src/queries/roles.ts` | 角色数据库查询 |
| `packages/core/src/queries/scopes.ts` | Scope数据库查询 |
| `packages/core/src/queries/roles-scopes.ts` | 角色-Scope关联查询 |
| `packages/core/src/queries/applications-roles.ts` | 应用-角色关联查询 |
| `packages/core/src/queries/users-roles.ts` | 用户-角色关联查询 |
| `packages/core/src/libraries/role-scope.ts` | 角色-Scope验证逻辑 |
| `packages/core/src/libraries/application.ts` | 应用权限查找逻辑 |
| `packages/core/src/libraries/user.ts` | 用户权限查找逻辑 |
| `packages/core/src/oidc/grants/client-credentials.ts` | Client Credentials授权流程 |
| `packages/core/src/oidc/grants/utils.ts` | 授权流程工具函数（组织访问检查） |
| `packages/core/src/oidc/resource.ts` | 资源Scope查找核心逻辑 |
| `packages/core/src/oidc/init.ts` | OIDC Provider初始化配置 |
| `packages/core/src/middleware/koa-auth/index.ts` | API权限验证中间件 |
| `packages/core/src/routes/role.scope.ts` | 角色-Scope API路由 |
| `packages/core/src/routes/role.application.ts` | 角色-应用API路由 |

---

## 12. 设计要点总结

1. **多对多关系**: 角色与Scope、应用与角色、用户与角色均为多对多关系
2. **资源隔离**: Scope 通过 `resourceId` 与资源关联，支持按资源过滤权限
3. **类型安全**: 用户角色不能分配管理API Scope，防止权限越界
4. **组织扩展**: 用户权限支持从组织角色中继承Scope
5. **默认角色**: 支持配置默认角色，新用户/应用自动分配
6. **双分支流程**:
   - **应用直连**: Client Credentials 流程，无需用户参与
   - **用户授权**: Authorization Code 流程，需要用户交互
7. **Scope 交集原则**: 令牌中最终的 Scope 是请求的 Scope 与可用 Scope 的交集
8. **第三方应用限制**: 第三方应用只能访问用户已同意的 Scope
9. **组织令牌**: 支持针对特定组织颁发令牌，audience 为组织 URN
10. **分层校验**: 客户端认证 → 组织访问校验 → 资源 Scope 校验 → 访问令牌校验
