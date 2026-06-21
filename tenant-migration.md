# Admin Tenant 创建与数据迁移 — 代码事实对照

## 概述

Logto 的多租户体系 = **PostgreSQL 行级安全 (RLS)** + **数据库角色隔离** + **Alteration 版本管理**。Admin Tenant 的创建不是单一脚本完成的，而是在多个连续的 Alteration 脚本中逐步完善，最后通过 Seed 命令将所有最新状态一次性落地。

两条初始化路径：

| 路径 | 命令 | 适用场景 | 执行方式 |
|------|------|----------|----------|
| **全新初始化** | `pnpm cli db seed` | 空数据库首次部署 | 从 SQL 模板建最新表 + 插入完整种子数据 + 时间戳跳到最新 |
| **增量升级** | `pnpm cli db alteration deploy <version>` | 已有数据库升级 | 逐个执行 Alteration 脚本，每步事务内原子更新 |

---

## 一、多租户架构基础（代码事实）

### 1.1 租户数据模型

[tenants.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/src/models/tenants.ts)

```sql
create table tenants (
  id                  varchar(21)  not null,  -- 租户ID: 'admin' | 'default' | 6位随机
  db_user             varchar(128),           -- 对应的PostgreSQL角色名
  db_user_password    varchar(128),           -- 角色密码
  name                varchar(128) not null default 'My Project',
  tag                 varchar(64)  not null default 'development',
  created_at          timestamptz  not null default(now()),
  is_suspended        boolean      not null default false,
  primary key (id),
  constraint tenants__db_user unique (db_user)
);
```

### 1.2 租户数据库角色体系

[tenant.ts (core-kit)](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/toolkit/core-kit/src/models/tenant.ts)

角色命名规则：
```
基础角色:        logto_tenant_{database}       (noinherit, 授予所有表权限，但对tenants/systems/service_logs有严格限制)
租户角色(继承):  logto_tenant_{database}_{tenantId}  (inherit login, in role 基础角色)
```

**`tenants` 表的 RLS + 列级别权限**（来自 [_after_all.sql](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/tables/_after_all.sql#L9-L29)）：

```sql
revoke all privileges on table tenants from logto_tenant_${database};

grant select (id, db_user, is_suspended, tag)   -- 只能读 4 列
  on table tenants
  to logto_tenant_${database};

alter table tenants enable row level security;

create policy tenants_tenant_id on tenants
  using (db_user = current_user);              -- 只能看到自己那一行
```

**重要**：租户角色对 `tenants` 表只有 `select` 权限（且仅限 4 列），没有 insert/update/delete 权限。`systems` 和 `service_logs` 表则完全禁止租户访问。

### 1.3 `set_tenant_id()` 触发器自动注入 tenant_id

**初始版本** ([add-tenant-id-trigger.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.0.0_rc.0-1674032095.6-add-tenant-id-trigger.ts#L24-L38))：
```sql
create function set_tenant_id() returns trigger as $$ begin
  select tenants.id into new.tenant_id
    from tenants where ('tenant_user_' || tenants.id) = current_user;
  if new.tenant_id is null then new.tenant_id := 'default'; end if;
  return new;
end; $$ language plpgsql;
```

**修正版本**（[add-admin-tenant.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.0.0_rc.1-1676115897-add-admin-tenant.ts#L112-L125)，与 `db_user` 列对齐后）：
```sql
create or replace function set_tenant_id() returns trigger as $$ begin
  if new.tenant_id is not null then return new; end if;      -- 手动指定优先
  select tenants.id into new.tenant_id
    from tenants where tenants.db_user = current_user;      -- 否则按当前DB角色推断
  return new;
end; $$ language plpgsql;
```

### 1.4 业务表的 RLS 策略

[_after_each.sql](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/tables/_after_each.sql#L1-L14) 中每张业务表都会执行：

```sql
create policy ${name}_tenant_id on ${name}
  as restrictive
  using (tenant_id = (select id from tenants where db_user = current_user));
```

即：业务表只能看到 `tenant_id` 等于当前租户 ID 的行。`tenants` 表的 `db_user` 匹配起到了"从 DB 用户名映射到 tenant_id"的桥梁作用。

---

## 二、运行时数据归属（关键！最易混淆的部分）

**核心原则：Admin Tenant 是"控制平面"，存储所有租户的管理元数据；普通租户是"数据平面"，存储用户自己的业务数据。**

### 2.1 Default Tenant (tenant_id = 'default') 内存储的数据

Default 租户是 OSS 版本唯一的**业务租户**（数据平面）。它的数据包括：

| 数据类型 | 具体内容 | 代码位置 |
|----------|---------|----------|
| Management API (OSS 本地用) | resource: `https://default.logto.app/api`, scope: `all`, 内部 admin 角色 | `defaultManagementApi` in [management-api.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/src/seeds/management-api.ts#L39-L75) |
| OIDC 配置 | `oidc.privateKeys`, `oidc.cookieKeys` | `seedOidcConfigs()` |
| Sign-in Experience | 默认 SIE 配置 | `createDefaultSignInExperience()` |
| ID Token 配置 | 默认 ID Token 配置 | `createDefaultIdTokenConfig()` |
| Account Center | 默认 AC 配置 | `createDefaultAccountCenter()` |
| 业务用户 | 普通注册用户（非管理员） | `users` 表 |
| 用户创建的应用/资源/角色/连接器等 | 用户在 Console 中创建的一切 | 各业务表 |
| Logto Configs | `adminConsole` 引导状态、`oidc.*` 等 | `logto_configs` 表 |
| OSS 预配置 M2M 访问角色 | `Logto Management API access` 角色，关联 Management API | `seedPreConfiguredManagementApiAccessRole()` |

### 2.2 Admin Tenant (tenant_id = 'admin') 内存储的数据

Admin Tenant 是**控制平面**，存储的东西远多于普通租户——所有租户的管理元数据都在这里。

#### A. 所有租户的 Management API 定义 + Proxy 角色

这是最容易搞错的：**每个租户的 Management API Resource 定义，都建在 Admin Tenant 里**，而不是在租户自己的表里。

```typescript
// createAdminDataInAdminTenant(tenantId) — 资源在 admin 租户中
{
  resource: { tenantId: 'admin', indicator: `https://${tenantId}.logto.app/api` },
  scopes:   [{ tenantId: 'admin', name: 'all' }],
  role:     { tenantId: 'admin', id: `m-${tenantId}`, name: `machine:mapi:${tenantId}` }
}
```

[management-api.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/src/seeds/management-api.ts#L127-L149)

所以 Admin Tenant 中初始至少有 **两套** Management API 定义：
- `https://default.logto.app/api` + `m-default` 角色（M2M proxy 角色）
- `https://admin.logto.app/api` + `m-admin` 角色（M2M proxy 角色）

每个还有相应的 M2M 应用（`m-{tenantId}`）和应用角色绑定，用于 Cloud 场景通过 mapi-proxy 转发请求。

#### B. Me API（Admin Tenant 自己的 API）

```typescript
{
  resource: { tenantId: 'admin', indicator: 'https://admin.logto.app/me' },
  scopes:   [{ tenantId: 'admin', name: 'all' }],
  role:     { tenantId: 'admin', name: 'user' }   // 登录 Console 的普通用户角色
}
```

[management-api.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/src/seeds/management-api.ts#L151-L178)

#### C. Cloud API

```typescript
resource: 'https://cloud.logto.io/api'  (tenant_id: admin)
scopes:
  - create:tenant                      → 分配给 user 角色
  - manage:tenant:self                 → 分配给 user 角色
  - manage:tenant                      → 分配给 admin:admin 角色
  - send:sms / send:email              → 分配给 tenantApplication 角色
  - fetch:custom:jwt                   → 分配给 tenantApplication 角色
  - report:subscription:updates        → 分配给 tenantApplication 角色
  - manage:affiliate / create:affiliate
  - access:mcp:api
```

[cloud-api.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/src/seeds/cloud-api.ts#L13-L88)

#### D. 管理角色体系（都在 Admin Tenant 中）

| 角色名 | 类型 | 作用 | 创建位置 |
|--------|------|------|----------|
| `{tenantId}:admin` (例: `default:admin`, `admin:admin`) | M2M/User | 租户管理员角色，持有对应该租户 Management API 的 `all` scope | Alteration `seed-for-admin-tenant.ts` |
| `machine:mapi:{tenantId}` (id: `m-{tenantId}`) | M2M | Management API Proxy 用的 M2M 角色，持有对应该租户 API 的 `all` scope | Alteration `sync-tenant-orgs.ts` / Seed `createAdminDataInAdminTenant()` |
| `user` | User | Admin Tenant 普通用户角色，持有 Me API 的 `all` + Cloud API 的 `create:tenant` + `manage:tenant:self` | Alteration `add-admin-tenant.ts` |
| `tenantApplication` (即 AdminTenantRole.TenantApplication) | M2M | 代表业务租户向 Logto Cloud 发送请求的 M2M 角色 | Alteration `m2m-app-for-tenants.ts` |

#### E. 租户组织 (Tenant Organizations)

所有租户的组织也存在 Admin Tenant 中（每个租户对应一个 Organization 记录）：

```
organizations 表 (tenant_id = 'admin'):
  id        name
  t-default 'Tenant default'
  t-admin   'Tenant admin'
```

组织模板同样在 Admin Tenant 中：
```
organization_roles (tenant_id = 'admin'):
  id            name
  admin         admin          → 所有 8 个 scopes
  collaborator  collaborator   → 5 个 scopes (read/write/delete data, read member)

organization_scopes (tenant_id = 'admin'):
  id                    name
  read-data             read:data
  write-data            write:data
  delete-data           delete:data
  read-member           read:member
  invite-member         invite:member
  remove-member         remove:member
  update-member-role    update:member:role
  manage-tenant         manage:tenant
```

[tenant-organization.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/src/types/tenant-organization.ts)

管理员的权限 = 其在某租户组织中的角色（而非 `{tenantId}:admin` 角色）——这是 `sync-tenant-orgs.ts` 引入的新体系。

#### F. Admin Tenant 自身的配置 + 管理员用户

Admin Tenant 作为一个租户，也需要自己的业务配置：
- OIDC 配置（私钥、cookie keys）
- Admin Tenant Sign-in Experience
- Admin Console 配置（`logto_configs` 中 key=`adminConsole`, tenant_id=`admin`）
- ID Token 配置
- Account Center 配置
- 管理员用户（`users` 表，都在 admin 租户中）
- Admin Console SPA 应用

**小结图示**：

```
┌──────────────────────────────────────────────────────────────────┐
│  Admin Tenant (控制平面, tenant_id = 'admin')                    │
│  • 所有租户的 Management API 资源 + Proxy 角色/应用               │
│    - default 租户的 API:  https://default.logto.app/api          │
│    - admin 租户的 API:    https://admin.logto.app/api            │
│  • Me API:                  https://admin.logto.app/me           │
│  • Cloud API:               https://cloud.logto.io/api           │
│  • 管理员用户 (users 表)                                           │
│  • 管理角色体系:  default:admin, admin:admin, user,              │
│                  machine:mapi:*, tenantApplication               │
│  • 所有租户组织 + 组织模板 (roles/scopes/membership)              │
│  • 每个租户的 Mapi Proxy M2M 应用 + Cloud Service M2M 应用       │
│  • Admin Console SPA 应用                                         │
│  • 两个租户的 adminConsole 引导配置                                │
│  • Admin Tenant 自己的 OIDC/SIE/AC/ID Token 配置                 │
└──────────────────────────────────────────────────────────────────┘
                              │
                              │  管理权限关系（组织成员关系表实现）
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Default Tenant (数据平面, tenant_id = 'default')                │
│  • 普通注册用户 (users 表)                                        │
│  • 用户创建的应用/资源/角色/连接器/自定义短语等                   │
│  • Management API (OSS 版本用, 本地直接访问)                      │
│  • OIDC / SIE / ID Token / AC 配置                               │
│  • Logto Configs (adminConsole 引导状态等)                        │
│  • 业务日志 / 会话 / 密码码等                                     │
└──────────────────────────────────────────────────────────────────┘
```

---

## 三、Alteration 迁移系统

### 3.1 脚本类型定义

[alteration.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/src/types/alteration.ts)

```typescript
type AlterationScript = {
  beforeUp?:   (CommonQueryMethods)          => Promise<void>;   // 事务外执行
  beforeDown?: (CommonQueryMethods)          => Promise<void>;   // 事务外执行
  up:         (DatabaseTransactionConnection) => Promise<void>;   // 事务内执行
  down:       (DatabaseTransactionConnection) => Promise<void>;   // 事务内执行
};
```

**事务模型**：每个脚本的 `up/down` + `updateDatabaseTimestamp` 包在一个事务里，原子性有保障。但 `beforeUp/beforeDown` 是事务外的，失败可能留下半成品。

### 3.2 执行引擎

[index.ts (alteration command)](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/cli/src/commands/database/alteration/index.ts#L64-L123)

```
deployAlteration(file, 'up'):
  1. import script → { beforeUp, up }
  2. if beforeUp:  await beforeUp(pool)       // 事务外！
  3. begin transaction:
       a. await up(connection)
       b. await updateDatabaseTimestamp(connection, timestamp)
     commit
```

**脚本文件命名**：`{semver}-{unix_timestamp}[.sub]-{description}.ts`
- `1.0.0_rc.1-1676115897-add-admin-tenant.ts`
- `next-1780906060-add-verification-code-policy.ts` （`next` 表示还未绑定到正式版本）
- 时间戳是**秒级**（10 位），可用 `.1` 创建子版本

### 3.3 数据库版本追踪

[system.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/cli/src/queries/system.ts#L52-L69)

存储在 `systems` 表，key = `AlterationState`，value = `{ timestamp: number, updatedAt: string }`。

### 3.4 启动前置检查

[preconditions.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/env-set/preconditions.ts) 在 Core 启动时强制检查：

1. **无未部署的 Alteration**：比较 `systems` 表的时间戳和文件系统脚本时间戳，有差异直接报错
2. **所有业务表启用 RLS**：`pg_tables` 里除了 `systems` 和 `service_logs` 外，`rowsecurity` 必须为 true

这保证了 Core 不会在 Schema 版本不匹配的情况下运行。

---

## 四、Admin Tenant 相关 Alteration 脚本时间线（按执行顺序）

> **注意**：这 23 个脚本是在多次版本升级中逐步引入的。新部署时用 Seed 跳过全部，直接建最终状态。只有已有数据库升级时才需要逐个执行。

### 阶段 1：多租户底层架构（`1.0.0_rc.0`）

| # | 时间戳 | 脚本 | 核心操作 |
|---|--------|------|----------|
| 1 | `1674032095.3` | [tenant-table.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.0.0_rc.0-1674032095.3-tenant-table.ts) | 创建 `tenants` 表；插入 `id='default'` 行（此时还没有 db_user 列） |
| 2 | `1674032095.5` | [multi-tenancy.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.0.0_rc.0-1674032095.5-multi-tenancy.ts) | 16 张业务表加 `tenant_id` 列 + 外键 + 重建索引/约束（tenant_id 前缀）|
| 3 | `1674032095.6` | [add-tenant-id-trigger.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.0.0_rc.0-1674032095.6-add-tenant-id-trigger.ts) | 创建 `set_tenant_id()` 函数；为 17 张表创建 `BEFORE INSERT` 触发器 |

### 阶段 2：RLS 启用 + Default Tenant 角色（`1.0.0_rc.1`）

| # | 时间戳 | 脚本 | 核心操作 |
|---|--------|------|----------|
| 4 | `1675788753` | [multi-tenancy-rls.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.0.0_rc.1-1675788753-multi-tenancy-rls.ts) | ① tenants 表加 `db_user` 列 ② 创建 `logto_tenant_{db}` 基础角色并授/收权限 ③ `tenants` 表启用 RLS ④ 20 张业务表启用 RLS + 创建 tenant_id policy ⑤ 为 `default` 租户创建 `logto_tenant_{db}_default` 登录角色，写入 `tenants.db_user/db_user_password` |

### 阶段 3：创建 Admin Tenant + 迁移管理员（`1.0.0_rc.1`）

| # | 时间戳 | 脚本 | 核心操作 |
|---|--------|------|----------|
| 5 | `1676115897` | [add-admin-tenant.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.0.0_rc.1-1676115897-add-admin-tenant.ts) | **Admin Tenant 诞生** ① 重写 `set_tenant_id()`（改用 `db_user` 匹配） ② `users` 表唯一约束改为 tenant_id 内唯一 ③ 资源标识 `api.logto.io` → `default.logto.app/api` ④ 插入 tenants 表 `id='admin'` 行 ⑤ 创建 `logto_tenant_{db}_admin` 登录角色 ⑥ **在 admin 租户中**创建 default 租户的 Management API（`default:admin` 角色 + `all` scope） ⑦ **在 admin 租户中**创建 Me API（`user` 角色） |
| 6 | `1676190092` | [migrate-admin-data.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.0.0_rc.1-1676190092-migrate-admin-data.ts) | ① 为 admin 租户生成 OIDC 私钥 + cookie keys ② 找出所有有 `admin` 角色的用户 ③ 验证这些用户没有多余角色（否则要求用户手动处理） ④ 从 `users_roles` 删除角色 ⑤ 将这些用户的 `users/logs/oidc_model_instances` 的 tenant_id 从 `default` → `admin` ⑥ 在 admin 租户中给它们分配 `default:admin` + `user` 两个角色 |

### 阶段 4：Admin Management API + Console 配置（`1.0.0`）

| # | 时间戳 | 脚本 | 核心操作 |
|---|--------|------|----------|
| 7 | `1677208902` | [update-admin-console-config.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.0.0-1677208902-update-admin-console-config.ts) | 数据迁移：更新 `logto_configs` 中 adminConsole 配置字段结构 |
| 8 | `1677765137` | [seed-for-admin-tenant.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.0.0-1677765137-seed-for-admin-tenant.ts) | **完善 Admin Tenant 控制面能力** ① 在 admin 租户中创建 `https://admin.logto.app/api`（Admin Tenant 自己的 Management API） ② 在 admin 租户中创建 `https://cloud.logto.io/api`（Cloud API）+ `create:tenant` scope ③ 创建 `admin:admin` 角色，分配 Admin API 的 `all` scope ④ 给 `user` 角色分配 Cloud API 的 `create:tenant` scope ⑤ 在 admin 租户的 `logto_configs` 中插入 key=`adminConsole` 的初始配置 |
| 9 | `1677907982` | [allow-admin-create-multiple-tenants.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.0.0-1677907982-allow-admin-create-multiple-tenants.ts) | Cloud API 增加 `manage:tenant` scope，分配给 `admin:admin` 角色 |
| 10 | `1678425761` | [m2m-app-for-tenants.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.0.0-1678425761-m2m-app-for-tenants.ts) | ① Cloud API 增加 `send:sms` / `send:email` scopes ② 创建 `tenantApplication` 角色（M2M），分配短信/邮件 scope ③ 给 `admin:admin` 角色也分配这两个 scope ④ **遍历已有租户（除admin外）**，为每个在 admin 租户中创建一个 Cloud Service M2M 应用，并绑定 `tenantApplication` 角色 |

### 阶段 5：后续增强和修复（`1.5.0` 及以后）

| # | 时间戳 | 脚本 | 核心操作 |
|---|--------|------|----------|
| 11 | `1684382842` | `1.5.0-...-add-name-tag-created-at-for-tenants-table.ts` | tenants 表增加 `name`, `tag`, `created_at` 列 |
| 12 | `1684837981` | `1.5.0-...-add-manage-tenant-self-scope-to-user-role.ts` | Cloud API 增加 `manage:tenant:self` scope，分配给 `user` 角色 |
| 13 | `1692088012` | `1.8.0-...-add-is-suspend-column-to-tenants-table.ts` | tenants 表增加 `is_suspended` 列 |
| 14 | `1702544178` | [sync-tenant-orgs.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.13.0-1702544178-sync-tenant-orgs.ts) | **租户组织体系上线**：① 在 admin 租户中创建组织模板 (owner/admin/member 3 角色 + 7 个 scopes) ② 为每个租户创建组织记录（id=`t-{tenantId}`） ③ 查找已有 `%:admin` 角色的用户，建立组织成员关系并分配 `owner` 角色 ④ 为每个租户创建 Mapi Proxy M2M 角色（`m-{tenantId}` = `machine:mapi:{tenantId}`）并绑定对应该租户 Management API 的 `all` scope ⑤ 为每个租户创建 Mapi Proxy M2M 应用（id=`m-{tenantId}`）并绑定角色 |
| 15 | `1703230000` | [update-tenant-roles.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.13.0-1703230000-update-tenant-roles.ts) | 组织角色重构：① 删除 `owner` 角色，把所有 owner 变成 admin ② `admin` 角色增加 `manage:tenant` scope 权限 ③ `member` 角色增加 `delete:data` scope（并在后续版本改名为 Collaborator） |
| 16-23 | 后续 | 若干小脚本 | 包括增加 read:member scope、Cloud API 增加更多 scope、tenants 表权限调整、为 admin 租户启用 MFA/Account Center/组织 MFA 策略、增加索引等 |

### 时间线图示

```
1.0.0_rc.0                          1.0.0_rc.1                         1.0.0                  1.13+
    │                                   │                                  │                      │
    ├ 1674032095.3  tenants 表          ├ 1675788753  RLS + default 角色   ├ 1677208902 Console 配  ├ 租户组织
    ├ 1674032095.5  16表+tenant_id     ├ 1676115897  创建 admin 租户      │   置结构迁移         ├ 组织角色调整
    └ 1674032095.6  触发器             ├ 1676190092  迁移 admin 用户      ├ 1677765137  Admin API └ ...
                                      │                                ├ 1677907982  manage:tenant
                                      │                                └ 1678425761  M2M app per tenant
                                      ▼
                               Admin Tenant 诞生
```

---

## 五、Seed 命令中租户初始化的实际执行路径

> Seed 不执行任何 Alteration 脚本。它直接读取最新的 SQL 模板建表，然后按**最新的 Schema + 最新的数据规范**一次性插入所有数据。

### 5.1 整体流程

[seed/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/cli/src/commands/database/seed/index.ts#L20-L58)

```typescript
seedByPool(pool, options):
  transaction {
    latestTimestamp = getLatestAlterationTimestamp()  // 读文件系统，不读DB
    createTables(connection)                           // 1. 建表
    seedTables(connection, latestTimestamp, cloud)     // 2. 插种子数据（下面展开）
    if cloud: seedCloud(connection)                   // 3. Cloud 专属
    if test:  seedTest(connection)                    // 4. 测试数据
  }
```

### 5.2 createTables — 建表

[seed/tables.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/cli/src/commands/database/seed/tables.ts#L93-L150)

```
1. 从 @logto/schemas/tables/*.sql 读取所有建表 SQL（包括最新列结构，如 name/tag/is_suspended）
2. 按 init_order 注释排序
3. 执行 before_all.sql：创建 logto_tenant_{db} 基础角色等
4. 顺序执行各 CREATE TABLE SQL
5. 对每个表执行 after_each.sql（若表 SQL 未标记 /* no_after_each */）：
   - 启用 RLS
   - 创建 set_tenant_id 触发器
   - 给基础角色授权
   - 创建 RLS policy
6. 执行 after_all.sql
   - 授予/收回特殊表权限（tenants 只许读4列，systems/service_logs完全禁止）
```

**结果**：`tenants` 表、所有业务表、触发器、RLS 策略、基础角色都就位。

### 5.3 seedTables — 插入种子数据（完整展开）

[seed/tables.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/cli/src/commands/database/seed/tables.ts#L152-L231)

按执行顺序，下面是每个步骤的**实际 tenant_id** 归属：

#### Step 1：Default Tenant 基础

```
createTenant(default):
  → tenants 表插入 id='default', db_user='logto_tenant_{db}_default'
  → 创建 PostgreSQL 登录角色

seedOidcConfigs(default):
  → logto_configs (tenant_id='default'): oidc.privateKeys, oidc.cookieKeys

seedAdminData(defaultManagementApi):
  // 注意！defaultManagementApi.tenantId = 'default'
  // 这是 OSS 版本直接使用的 Management API（位于 default 租户）
  → resources        (tenant_id='default'): https://default.logto.app/api
  → scopes           (tenant_id='default'): all
  → roles            (tenant_id='default'): name='admin' (内部角色)
  → roles_scopes     (tenant_id='default'): admin 角色绑定 all scope

seedPreConfiguredManagementApiAccessRole(default):
  // OSS 预配置的 M2M 访问角色
  → roles            (tenant_id='default'): 'Logto Management API access'
```

#### Step 2：Admin Tenant 基础

```
createTenant(admin):
  → tenants 表插入 id='admin', db_user='logto_tenant_{db}_admin'
  → 创建 PostgreSQL 登录角色

seedOidcConfigs(admin):
  → logto_configs (tenant_id='admin'): oidc.privateKeys, oidc.cookieKeys
```

#### Step 3：Admin Tenant 中的控制面数据（核心！）

```
seedAdminData(createAdminDataInAdminTenant(defaultTenantId)):
  // default 租户的 Management API 在 Admin 控制面中的定义（供 mapi-proxy 用）
  → resources        (tenant_id='admin'):   https://default.logto.app/api
  → scopes           (tenant_id='admin'):   all
  → roles            (tenant_id='admin'):   id='m-default', name='machine:mapi:default'
  → roles_scopes     (tenant_id='admin'):   m-default 角色绑定 all scope

seedAdminData(createAdminDataInAdminTenant(adminTenantId)):
  // admin 租户自己的 Management API 在自己控制面中的定义
  → resources        (tenant_id='admin'):   https://admin.logto.app/api
  → scopes           (tenant_id='admin'):   all
  → roles            (tenant_id='admin'):   id='m-admin', name='machine:mapi:admin'
  → roles_scopes     (tenant_id='admin'):   m-admin 角色绑定 all scope

seedAdminData(createMeApiInAdminTenant()):
  → resources        (tenant_id='admin'):   https://admin.logto.app/me
  → scopes           (tenant_id='admin'):   all
  → roles            (tenant_id='admin'):   name='user' (User 类型)
  → roles_scopes     (tenant_id='admin'):   user 角色绑定 all scope

seedAdminData(cloudData, ...cloudAdditionalScopes):
  // cloudData.role = { tenantId='admin', name='user' }（不是创建新角色，而是对已存在的 user 角色加 scope）
  → resources        (tenant_id='admin'):   https://cloud.logto.io/api
  → scopes           (tenant_id='admin'):   create:tenant, manage:tenant:self
                                               send:sms, send:email, fetch:custom:jwt,
                                               report:subscription:updates,
                                               create:affiliate, manage:affiliate
  → roles_scopes     (tenant_id='admin'):   user 角色绑定 create:tenant + manage:tenant:self
```

#### Step 4：Tenant Application 角色

```
createTenantApplicationRole() → 插入 roles 表:
  → roles (tenant_id='admin'): name='tenantApplication' (M2M)

assignScopesToRole(admin, applicationRole.id, send:sms, send:email, fetch:custom:jwt, report:...):
  → roles_scopes (tenant_id='admin'): tenantApplication 角色绑定这 4 个 scopes
```

#### Step 5：并行插入一批配置数据和应用

```
Promise.all [
  seedLegacyManagementApiUserRole:
    // OSS 专用：在 admin 租户中创建 name='default:admin' 的 Legacy 用户角色，
    // 关联到 default 租户 Management API 的 all scope（这里的资源和 scope 在 admin 租户中）
    → roles            (tenant_id='admin'):  name='default:admin'
    → roles_scopes     (tenant_id='admin'):  该角色关联 default API 的 all scope

  seedTenantCloudServiceApplication(default):
    // 为 default 租户创建 Cloud Service M2M 应用，绑定 tenantApplication 角色
    → applications     (tenant_id='admin'):  name='Cloud Service', customClientMetadata={tenantId:'default'}
    → applications_roles (tenant_id='admin'): 应用绑定 tenantApplication 角色

  // 以下项的 tenant_id 都是参数传入：
  createDefaultAdminConsoleConfig(default) → logto_configs (tenant_id='default')
  createDefaultAdminConsoleConfig(admin)   → logto_configs (tenant_id='admin')
  createDefaultIdTokenConfig(default)      → logto_configs (tenant_id='default')
  createDefaultIdTokenConfig(admin)        → logto_configs (tenant_id='admin')
  createDefaultSignInExperience(default)   → sign_in_experiences (tenant_id='default')
  createAdminTenantSignInExperience()      → sign_in_experiences (tenant_id='admin')
  createDefaultAdminConsoleApplication()   → applications (tenant_id='admin'): SPA, id='admin-console'
  createDefaultAccountCenter(default)      → account_centers (tenant_id='default')
  createAdminTenantAccountCenter()         → account_centers (tenant_id='admin')
]
```

#### Step 6：租户组织 + Mapi Proxy 应用

```
Promise.all [
  seedTenantOrganizations:
    // 组织模板
    → organization_roles   (tenant_id='admin'):  admin, collaborator 两个角色
    → organization_scopes  (tenant_id='admin'):  8 个 scopes
    → organization_role_scope_relations (上述关联)
    // 两个租户的组织
    → organizations        (tenant_id='admin'):  id='t-default', 't-admin'

  seedManagementApiProxyApplications:
    // 为 default 和 admin 各创建一套 Mapi Proxy M2M 应用（这些应用在 Alteration 中是 sync-tenant-orgs.ts 才创建的）
    → applications         (tenant_id='admin'):  id='m-default', 'm-admin'
    → applications_roles   (tenant_id='admin'):  两个应用分别绑定 m-default、m-admin 角色
]
```

#### Step 7：版本标记

```
updateDatabaseTimestamp(latestTimestamp)
  → systems 表: key=AlterationState, value={timestamp: 最新脚本的时间戳}
```

Seed 完成后，数据库的时间戳直接等于所有脚本中最新那个，Core 启动检查通过。

### 5.4 对比：Alteration 升级 vs Seed 初始化

| 事项 | Alteration 升级路径 | Seed 初始化路径 |
|------|---------------------|-----------------|
| 建表方式 | 先有旧表，每步 `ALTER TABLE` | 直接执行最新 SQL 模板 |
| Admin Tenant 创建 | `add-admin-tenant.ts` (脚本#5) 中单独建 | `createTenant(admin)` 在 seedTables 中直接插入 |
| Admin 用户迁移 | `migrate-admin-data.ts` (脚本#6) 从 default 迁走用户 | 无（初始数据库没有用户） |
| Management API 定义位置 | 分两批：先 `add-admin-tenant.ts` 建 default 的，后 `seed-for-admin-tenant.ts` 建 admin 自己的 | 一批同时建：`createAdminDataInAdminTenant(default)` + `createAdminDataInAdminTenant(admin)` |
| default 租户中是否也有 Management API | 没有（Alteration 时代只有 admin 租户中有一份） | **有**！`seedAdminData(defaultManagementApi)` 在 default 租户中额外建了一份（OSS 本地用） |
| 租户组织 | `sync-tenant-orgs.ts` (脚本#14) 中遍历已有租户创建 | `seedTenantOrganizations()` 直接为 default 和 admin 建两个组织 |
| Mapi Proxy 应用 | `sync-tenant-orgs.ts` 遍历已有租户创建 | `seedManagementApiProxyApplications()` 为两个初始租户创建 |
| Cloud Service 应用 | `m2m-app-for-tenants.ts` (脚本#10) 遍历非 admin 租户创建 | `seedTenantCloudServiceApplication(default)` 为 default 创建 |
| 执行事务粒度 | 每个脚本一个事务 | 整个 Seed 过程一个事务 |
| 时间戳更新 | 每执行一个脚本更新一次 | 最后一次性更新到最新 |

---

## 六、运行时租户流程（三个职责 + 两种连接池，严格分离）

> **关键更正**：之前的描述有两处错误——
> 1. 误把 `koaTenantGuard` 当成了解析/绑定入口（实际它只做暂停检查）
> 2. 误说 `findTenantMetadataById` 需要用共享池才能查（实际用租户池就能查，因为查的是自己）

### 6.1 两种连接池（必须先搞清楚）

Logto Core 中同时存在**两种身份完全不同的数据库连接池**，各司其职，不能混用：

| 连接池 | 代码位置 | DB 身份 | RLS 限制 | 用途 |
|--------|---------|---------|----------|------|
| **共享池** (sharedPool) | `EnvSet.sharedPool` [env-set/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/env-set/index.ts#L41-L47) | 主 DB 用户（postgres 或 logto） | 不受 RLS 限制，能看到所有租户所有数据 | 系统级查询、不知道租户身份时的查询、跨租户查询 |
| **租户池** (tenant pool) | `envSet.pool` [env-set/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/env-set/index.ts#L58-L64) | `logto_tenant_{db}_{id}` 租户角色 | 受 RLS 严格限制，只能看到本租户数据 | 该租户的所有业务查询 |

**共享池的使用场景（只有 4 种）**：

| 场景 | 函数 | 为什么必须用共享池 |
|------|------|-------------------|
| 拿租户 DB 密码 | `getTenantDatabaseDsn(tenantId)` [tenants/utils.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/tenants/utils.ts#L25-L55) | 此时还没有租户身份，还没建专属 pool |
| 跨租户拿 admin OIDC 私钥 | `getAdminTenantPrivateSigningKeys()` [tenants/utils.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/tenants/utils.ts#L63-L83) | 用户租户不能访问 admin 租户的 `logto_configs` 行 |
| 查自定义域名 | `getTenantIdFromCustomDomain()` [utils/tenant.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/utils/tenant.ts#L60-L79) | 还没确定 tenantId，没有专属 pool |
| 全局健康检查 | `checkPreconditions()` | 不属于任何租户，检查整体 Schema 状态 |

**除此之外，所有业务查询一律走租户专属 pool。**

### 6.2 三个运行时职责总览

| 职责 | 代码位置 | 作用阶段 | 用哪个池 | 实际作用 | 依赖的 Seed 数据 |
|------|---------|---------|---------|---------|----------------|
| **① 租户解析** | `getTenantId()` in [utils/tenant.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/utils/tenant.ts#L87-L129) | 最外层中间件，所有请求第一步 | 共享池（仅自定义域名查询时用） | 从 URL 推断出 `tenantId` 字符串（不确定存在性） | `domains` 表的自定义域名、`tenants` 表的记录存在性（由后续步骤校验） |
| **② 上下文绑定** | `tenantPool.get()` → `Tenant.create()` in [tenants/Tenant.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/tenants/Tenant.ts#L64-L270) | 解析出 tenantId 之后 | 先用共享池拿密码，再建租户池 | **① 用共享池查 `tenants` 表拿 db_user/password ② 以租户身份重新建 DB 连接池（这才是 RLS 真正生效的关键）③ 创建该租户专属的 Koa app + OIDC provider + Queries** | `tenants` 表的 `db_user` + `db_user_password`、各租户的 OIDC config、Management API 定义、SIE config 等 |
| **③ 暂停校验** | `koaTenantGuard()` in [middleware/koa-tenant-guard.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/middleware/koa-tenant-guard.ts#L8-L26) | Management API 路由层（只对 `/api` 生效，且仅 Cloud 模式） | **租户池**（`tenant.queries.tenants`） | **只做一件事：查 `tenants.is_suspended`，为 true 就 403** | `tenants` 表的 `is_suspended` 列（seed 中默认 `false`，1.8.0 alteration 才加了这列） |

**完整调用链（由外到内）**：

```
app/init.ts 最外层中间件
  │
  ├─ ① getTenantId(ctx.URL)                  → 推断 tenantId（共享池仅在查自定义域名时用）
  │       （如果推断失败 → ctx.status = 404，直接返回）
  │
  ├─ ② tenantPool.get(tenantId, customEndpoint)
  │     └─ Tenant.create(id)
  │          ├─ getTenantDatabaseDsn(id)      → 共享池查 tenants 表拿 db_user/password
  │          ├─ new EnvSet(id, dsn)            → 用租户身份建专属 pool（RLS 真正生效）
  │          ├─ envSet.load(customDomain)      → 读该租户的 OIDC/SIE 等配置（租户池，RLS 自动过滤）
  │          ├─ new Queries(pool)              → 所有查询都跑在这个租户池上
  │          └─ initOidc() + 组装专属 Koa app
  │
  └─ ② tenant.run(ctx, next)                  → 把请求交给该租户专属的 Koa app
        │
        └─ routes/init.ts
              ├─ koaAuth(indicator)           → Management API 鉴权（用租户池，读该租户的资源定义）
              │
              └─ ③ koaTenantGuard(tenant.id, tenant.queries)   → 只在这里检查 is_suspended
                        (仅 isCloud = true 时才实际检查，OSS 直接 next())
```

### 6.3 职责①：租户解析（`getTenantId()`）详解

[utils/tenant.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/utils/tenant.ts#L87-L129)

按优先级依次尝试，**只负责"猜 tenantId 字符串"，不校验租户是否真实存在**：

```
HTTP 请求 URL
    │
    ▼
1. adminUrlSet 匹配？（如 http://localhost:3002/ 或 admin.logto.app）
   → 是 → tenantId = 'admin'，isCustomDomain = false
    │
    ▼ 否
2. 非生产 / 集成测试环境 且 DEVELOPMENT_TENANT_ID 已指定？
   → 是 → tenantId = 指定值
    │
    ▼ 否
3. 单租户模式（IS_MULTI_TENANCY = false）？
   → 是 → tenantId = 'default'
    │
    ▼ 否（多租户模式）
4. 路径多租户（IS_PATH_BASED_MULTI_TENANCY = true）？
   → 是 → 从 URL 路径片段中提取
    │
    ▼ 否（域名多租户）
5. 自定义域名？查 `domains` 表（带 Redis 缓存，key=`custom-domain:{hostname}`）
   → 是 → tenantId = 对应租户，isCustomDomain = true
   （这一步用 **共享池**，因为还不知道租户身份）
    │
    ▼ 否
6. 通配符域名匹配？（从 `*.logto.app` 形式的 hostname 前缀提取）
   → 是 → tenantId = 前缀
   → 否 → tenantId = undefined（上层中间件会 404）
```

**返回值**：`[tenantId | undefined, isCustomDomain: boolean]`。
`isCustomDomain = true` 的请求后续会用当前 origin 构造 OIDC issuer，而不是默认的子域名。

### 6.4 职责②：上下文绑定（真正的"归属判定"发生点）

[tenants/Tenant.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/tenants/Tenant.ts#L64-L270)、[tenants/utils.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/tenants/utils.ts#L25-L55)

#### 绑定的具体步骤

```
Tenant.create({ id, customDomain })
  │
  ├─ ① getTenantDatabaseDsn(id)
  │     └─ 用 **共享池** 查询 tenants 表：
  │        select db_user, db_user_password from tenants where id = $1
  │        → 如果查不到 → 抛 TenantNotFoundError（上层转 404/500）
  │        → 否则把主 DB_URL 的用户名/密码替换成该租户的，返回新 DSN
  │
  ├─ ② new EnvSet(id, tenantDsn)
  │     └─ 用租户专属的 DB 用户/密码重新建一个 slonik pool
  │        → 后续所有查询都走这个 pool（即 tenant.queries.pool）
  │        → PostgreSQL 当前用户 = logto_tenant_{db}_{id}
  │        → RLS 策略自动生效：只能看到 tenant_id = 当前租户的行
  │
  ├─ ③ envSet.load(customDomain)
  │     └─ 用上面这个租户池读 logto_configs / sign_in_experiences 等
  │        → 这些表的 tenant_id 由 RLS 过滤，天然只读自己的
  │
  └─ ④ 创建该租户专属的所有组件：
        new Queries(tenantPool)       → 每个 Queries 方法绑定该租户的 pool
        initOidc(id, envSet, ...)    → OIDC provider（用该租户的签名密钥、客户端）
        new Koa() + mount 所有路由   → 该租户的 app 和其他租户完全隔离
```

**LRU 缓存**：`tenantPool.get()` 把 Tenant 实例缓存在 LRU cache 里（大小 = `EnvSet.values.tenantPoolSize`），命中就直接复用，健康检查失败才重建。

#### 和 Seed 数据准备的对应关系

这一步**完全依赖 Seed 时 `createTenant()` 写入的 `tenants.db_user` 和 `tenants.db_user_password`**：
- Seed 时 `createTenant(default)` 写入 db_user=`logto_tenant_{db}_default` + 随机 32 位密码
- Seed 时 `createTenant(admin)` 写入 db_user=`logto_tenant_{db}_admin` + 随机 32 位密码
- `getTenantDatabaseDsn()` 把这两行读出来，替换主 DSN 的用户名密码，重新建连接

#### 专属 Koa app 的挂载行为

[Tenant.ts 第 262-269 行](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/tenants/Tenant.ts#L262-L269)：

- **路径多租户模式** 下：`this.run = mount('/' + this.id, this.app)` — 给每个租户的路由加前缀 `/default`、`/admin`
- **域名多租户模式** 下：`this.run = mount(this.app)` — 直接挂载（不同请求已经被路由到不同 Tenant 实例）

Admin 租户还会额外挂载：
- `/me` API（只有 admin 租户的 `initMeApis()` 生效）
- OSS 非多租户场景下还会挂载 Admin Console SPA（Cloud 场景由 Cloud 服务提供 Console）

### 6.5 职责③：暂停校验（`koaTenantGuard()`）

[middleware/koa-tenant-guard.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/middleware/koa-tenant-guard.ts#L8-L26)

```typescript
function koaTenantGuard(tenantId, { tenants }: Queries) {
  return async (ctx, next) => {
    const { isCloud } = EnvSet.values;

    if (!isCloud) {
      return next();    // ← OSS 版本直接跳过，什么都不做！
    }

    const { isSuspended } = await tenants.findTenantMetadataById(tenantId);
    if (isSuspended) {
      throw new RequestError('subscription.tenant_suspended', 403);
    }

    return next();
  };
}
```

#### 连接池归属（重点！之前讲错了）

`tenants.findTenantMetadataById(tenantId)` 用的是 **租户专属 pool**（`tenant.queries.pool`），不是共享池。

**为什么租户池能查到 `tenants` 表的数据？** 因为：

1. **RLS 策略允许**：`tenants` 表的 RLS 策略是 `db_user = current_user`，租户登录后 `current_user` = 自己的角色名，所以能看到自己那一行
2. **列权限足够**：`grant select (id, db_user, is_suspended, tag) on table tenants`，刚好包含 `findTenantMetadataById` 需要的三列（id, isSuspended, tag）
3. **查的是自己**：调用方传进来的 `tenantId` 就是当前租户的 id（`koaTenantGuard(tenant.id, tenant.queries)`），所以 RLS 过滤后正好能查到一行

**如果传一个别的租户 id 会怎样？** RLS 会过滤掉那行，`pool.one()` 抛出 `NotFoundError`。但业务中不会出现这种情况——暂停校验永远只查当前租户自己。

#### 挂载位置和生效范围

`koaTenantGuard` 只挂在 `managementRouter` 上（即 `/api/*` Management API），见 [routes/init.ts 第 78 行](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/routes/init.ts#L78)。

**不经过暂停校验的端点**：
- OIDC 端点（`/oidc/*`）
- Sign-in Experience
- Account Center
- 公开的 `.well-known`
- Admin Console SPA 静态资源

设计意图：租户被暂停后，用户仍然可以登录 Console 查看账单和恢复方案，只是不能调用管理 API 改数据。

#### 和 Seed / Alteration 的关系

- Seed 时 `tenants.is_suspended` 默认值是 `false`（建表 SQL 里的 `default false`）
- `is_suspended` 列本身是 1.8.0 的 alteration 才加上的
- 列级别权限从最初只有 2 列（id, db_user）扩展到 4 列（增加了 is_suspended, tag）—— 最新模板 `_after_all.sql` 是 4 列授权

---

## 七、易错点和注意事项

### 7.1 不要把 `koaTenantGuard` 当成"租户绑定中间件"

`koaTenantGuard` 是一个纯校验中间件，职责只有 `is_suspended` 检查。它接收的 `tenantId` 和 `queries` 都是上层已经确定好的，它既不解析 tenantId，也不创建任何连接池。**RLS 的真正绑定点是 `Tenant.create()` → `getTenantDatabaseDsn()` → `new EnvSet(id, tenantDsn)` 这一串。**

### 7.2 `findTenantMetadataById` 用的是租户池，不是共享池

之前误以为查 `is_suspended` 需要绕过 RLS 用共享池。实际代码中：
- `tenant.queries.tenants = createTenantQueries(this.pool)` — 用的就是租户池
- 因为 RLS 策略是 `db_user = current_user`，租户能看到自己那行
- 列权限是 `select (id, db_user, is_suspended, tag)`，刚好够用
- 传的参数是自己的 tenantId，所以一定查得到

共享池（`EnvSet.sharedPool`）只用在 4 种场景：拿租户 DB 密码、跨租户拿 admin 私钥、查自定义域名、全局健康检查。其他全走租户池。

### 7.3 暂停校验不是对所有请求生效

只有 Management API (`/api/*`) 请求才检查暂停状态。Sign-in Experience、OIDC、公开的 well-known 端点都不受影响——设计意图是让被暂停的租户仍然可以登录 Console 查看账单、恢复订阅，而不是完全锁死。

### 7.4 Management API 的"双份"问题

Seed 路径下，default 租户的 Management API 实际上有**两份**：
- **一份在 default 租户中**：`defaultManagementApi`（OSS 本地访问用，`tenantId='default'`）
- **一份在 admin 租户中**：`createAdminDataInAdminTenant('default')`（Cloud/Mapi-proxy 场景用，`tenantId='admin'`）

两者 indicator 相同都是 `https://default.logto.app/api`，但分属不同租户。前者是单租户 OSS 模式遗留，后者是多租户 Cloud 模式所需，运行时各自服务不同的访问入口。

### 7.5 Admin 用户归属容易搞错

管理员用户的 `users` 表记录在 **admin 租户**中，而不是 default 或他管理的租户中。他和某个具体租户的权限关系，完全由 `organization_user_relations`（组织成员）和 `organization_role_user_relations`（组织角色）两张表（都在 admin 租户中）决定。登录 Admin Console 时：
- 认证走 admin 租户的 OIDC（因为 URL 匹配 adminUrlSet，`getTenantId()` 返回 `'admin'`）
- 用户查询走 admin 租户自己的连接池（只能查到 admin 租户里的 `users` 行）
- 授权权限查 admin 租户中的组织表（`t-default` / `t-xxx` 的成员关系）

### 7.6 `tenants` 表本身的 RLS

`tenants` 表也启用了 RLS，但策略特殊——租户登录角色只能看到**自己那一行**，且只能读 `id, db_user, is_suspended, tag` 4 列。`systems` 和 `service_logs` 表则完全禁止租户角色访问。`set_tenant_id` 触发器依赖 `tenants` 表的 `id` 和 `db_user` 列可读才能正常工作。

### 7.7 Alteration 的 beforeUp/beforeDown 风险

如果脚本定义了 `beforeUp`，那部分代码在事务外执行。一旦失败，后面的事务回滚了但 `beforeUp` 的副作用（如 `CREATE INDEX CONCURRENTLY`）可能已经生效。Logto 在错误提示中区分了"含 beforeUp" 和"纯事务"两种失败情况，指引开发者手动处理残留对象并重新同步时间戳。

### 7.8 Seed 和 Alteration 绝对不能混用

- 空数据库用 `seed`，不要跑 alteration——Seed 直接跳过所有历史变更，拿到最新 Schema 和数据
- 已有数据库必须用 alteration，不要重新 seed——Seed 会用 `TRUNCATE`/`DELETE` 清空业务表再插入默认值，会破坏用户数据
- `checkPreconditions()` 强制 Core 启动时 `systems.AlterationState.timestamp` 等于最新脚本时间戳，不管走哪条路径最终时间戳必须一致——这也是两条路径唯一必须对齐的"契约点"
