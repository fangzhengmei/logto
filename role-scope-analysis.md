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

## 5. 权限检查与验证

### 5.1 API 请求权限验证

**文件位置**: `packages/core/src/middleware/koa-auth/index.ts`

核心流程：
1. 从请求头提取 Bearer Token
2. 验证 Token 签名和有效性
3. 从 Token 中提取 `scope` 字段
4. 验证 Scope 是否包含必要的权限（如 `all`）

```typescript
const authMiddleware = async (ctx, next) => {
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
    type: sub === clientId ? 'app' : 'user',
    id: sub,
    scopes: new Set(scopes),
  };

  return next();
};
```

### 5.2 Token 中的 Scope 来源

在 OAuth 2.0 流程中，Token 的 Scope 来源于：
- 用户授权时请求的 Scope
- 应用角色中配置的 Scope
- 资源服务器定义的 Scope

---

## 6. REST API 端点

### 6.1 角色-Scope 管理

**文件位置**: `packages/core/src/routes/role.scope.ts`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/roles/:id/scopes` | 获取角色的Scope列表 |
| POST | `/roles/:id/scopes` | 为角色分配Scope |
| DELETE | `/roles/:id/scopes/:scopeId` | 移除角色的Scope |

### 6.2 角色-应用管理

**文件位置**: `packages/core/src/routes/role.application.ts`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/roles/:id/applications` | 获取角色关联的应用列表 |
| POST | `/roles/:id/applications` | 为角色分配应用 |
| DELETE | `/roles/:id/applications/:applicationId` | 移除角色的应用关联 |

---

## 7. 关键文件索引

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
| `packages/core/src/middleware/koa-auth/index.ts` | API权限验证中间件 |
| `packages/core/src/routes/role.scope.ts` | 角色-Scope API路由 |
| `packages/core/src/routes/role.application.ts` | 角色-应用API路由 |

---

## 8. 设计要点总结

1. **多对多关系**: 角色与Scope、应用与角色、用户与角色均为多对多关系
2. **资源隔离**: Scope 通过 `resourceId` 与资源关联，支持按资源过滤权限
3. **类型安全**: 用户角色不能分配管理API Scope，防止权限越界
4. **组织扩展**: 用户权限支持从组织角色中继承Scope
5. **默认角色**: 支持配置默认角色，新用户/应用自动分配
