# Admin Tenant 创建与数据迁移代码理解

## 概述

Logto 的多租户架构通过 **PostgreSQL 行级安全 (RLS)** + **数据库角色隔离** + **Alteration 版本管理** 三层机制实现。Admin Tenant 的创建和数据迁移涉及三个核心阶段：**数据库 Schema 初始化** → **Alteration 脚本执行** → **默认数据 Seed**。

---

## 一、多租户架构基础

### 1.1 租户数据模型

[tenants.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/src/models/tenants.ts) 定义了租户表结构：

```sql
create table tenants (
  id varchar(21) not null,              -- 租户ID (如 'admin', 'default')
  db_user varchar(128),                 -- 数据库角色名
  db_user_password varchar(128),        -- 数据库角色密码
  name varchar(128) not null default 'My Project',
  tag varchar(64) not null default 'Development',
  created_at timestamptz not null default(now()),
  is_suspended boolean not null default false,
  primary key (id),
  constraint tenants__db_user unique (db_user)
);
```

每个租户对应一个独立的 PostgreSQL 数据库角色，通过 RLS 实现数据隔离。

### 1.2 租户数据库元数据

[tenant.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/toolkit/core-kit/src/models/tenant.ts) 中 `createTenantDatabaseMetadata()` 负责生成租户数据库角色信息：

```typescript
export const createTenantDatabaseMetadata = (
  databaseName: string,
  tenantId = generateTenantId()
): TenantDatabaseMetadata => {
  const parentRole = `logto_tenant_${databaseName}`;
  const role = `logto_tenant_${databaseName}_${tenantId}`;
  const password = generateStandardId(32);

  return { id: tenantId, parentRole, role, password };
};
```

**命名规则**：
- 基础角色：`logto_tenant_{database}`
- 租户角色：`logto_tenant_{database}_{tenantId}`

### 1.3 行级安全 (RLS) 触发机制

在 [add-admin-tenant.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.0.0_rc.1-1676115897-add-admin-tenant.ts#L112-L125) 中定义了 `set_tenant_id()` 触发器函数：

```sql
create or replace function set_tenant_id() returns trigger as
$$ begin
  if new.tenant_id is not null then
    return new;
  end if;

  select tenants.id into new.tenant_id
    from tenants
    where tenants.db_user = current_user;

  return new;
end; $$ language plpgsql;
```

该触发器会在插入数据时自动根据当前数据库角色设置 `tenant_id`，确保数据归属正确。

### 1.4 多租户表结构改造

[multi-tenancy.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.0.0_rc.0-1674032095.5-multi-tenancy.ts) 是多租户改造的核心脚本，为所有业务表添加 `tenant_id` 列：

- 为 20+ 张业务表添加 `tenant_id` 列并关联外键
- 重建所有索引，添加 `tenant_id` 作为前缀
- 重建所有唯一约束，包含 `tenant_id` 确保租户内唯一性

---

## 二、Alteration 迁移系统

### 2.1 Alteration 脚本类型定义

[alteration.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/src/types/alteration.ts) 定义了迁移脚本接口：

```typescript
export type AlterationScript = {
  beforeUp?: (connection: CommonQueryMethods) => Promise<void>;    // 非事务性前置操作
  beforeDown?: (connection: CommonQueryMethods) => Promise<void>;  // 非事务性回滚前置操作
  up: (connection: DatabaseTransactionConnection) => Promise<void>;    // 事务性升级
  down: (connection: DatabaseTransactionConnection) => Promise<void>;  // 事务性回滚
};
```

**重要说明**：
- `up/down` 在事务中执行，失败可自动回滚
- `beforeUp/beforeDown` 在事务外执行，用于无法包装在事务中的操作（如 `CREATE INDEX CONCURRENTLY`）

### 2.2 迁移执行流程

[index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/cli/src/commands/database/alteration/index.ts) 是迁移命令的核心实现：

#### 部署流程 (`deployAlteration()`)

```typescript
const deployAlteration = async (
  pool: DatabasePool,
  { path: filePath, filename }: AlterationFile,
  action: 'up' | 'down' = 'up'
) => {
  const { up, down, beforeUp, beforeDown } = await importAlterationScript(filePath);
  const timestamp = getTimestampFromFilename(filename);

  if (action === 'up') {
    if (beforeUp) {
      await beforeUp(pool);  // 非事务性步骤
    }

    await pool.transaction(async (connection) => {
      await up(connection);  // 事务性升级
      await updateDatabaseTimestamp(connection, timestamp);  // 更新版本号
    });
  }
  // ... down 逻辑类似
};
```

**关键特性**：
1. 每个 `up` 操作在独立事务中执行
2. 事务内同时更新数据库时间戳，确保原子性
3. 失败时根据是否有 `beforeUp` 提示不同的恢复策略

#### 命令入口

CLI 支持三种操作：
- `list` - 列出所有可用的迁移脚本
- `deploy [version]` - 部署迁移到指定版本
- `rollback [version]` - 回滚到指定版本

### 2.3 迁移版本管理

[utils.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/cli/src/commands/database/alteration/utils.ts) 处理脚本文件解析：

**文件命名规则**：
```
{version}-{timestamp}-{description}.ts
```

示例：
- `1.0.0_rc.1-1676115897-add-admin-tenant.ts`
- `next-1780906060-add-verification-code-policy.ts`

**时间戳提取**：
- 支持 `1676115897` (10位秒级时间戳)
- 支持 `1676115897.1` (带小数的子版本)

### 2.4 数据库版本追踪

[system.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/cli/src/queries/system.ts) 中 `updateDatabaseTimestamp()` 将版本信息存储在 `systems` 表：

```typescript
const value: AlterationState = {
  timestamp,
  updatedAt: new Date().toISOString(),
};

await connection.query(
  sql`
    insert into ${table} (key, value) 
      values (${AlterationStateKey.AlterationState}, ${sql.jsonb(value)})
      on conflict (key) do update set value=excluded.value
  `
);
```

### 2.5 运行时前置检查

[preconditions.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/env-set/preconditions.ts) 在 Core 启动时检查：

1. **检查未部署的迁移**：`checkAlterationState()` 比较文件系统和数据库的时间戳
2. **检查 RLS 启用状态**：`checkRowLevelSecurity()` 确保所有业务表都启用了行级安全

---

## 三、Admin Tenant 创建流程

Admin Tenant 的创建涉及 **两个连续的 Alteration 脚本**，分别在 `1.0.0-rc.1` 版本中引入。

### 3.1 阶段一：创建 Admin Tenant 基础结构

脚本：[1.0.0_rc.1-1676115897-add-admin-tenant.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.0.0_rc.1-1676115897-add-admin-tenant.ts)

**执行步骤**：

1. **更新触发器函数** - 修改 `set_tenant_id()` 使用新的角色匹配规则
2. **更新用户表约束** - 将用户名、邮箱、电话的唯一约束改为租户内唯一
3. **更新资源标识** - 将 `https://api.logto.io` 改为 `https://default.logto.app/api`
4. **创建 Admin Tenant**：
   ```sql
   insert into tenants (id, db_user, db_user_password)
     values ('admin', 'logto_tenant_{db}_admin', {password});
   
   create role logto_tenant_{db}_admin with inherit login
     password '{password}'
     in role logto_tenant_{db};
   ```
5. **初始化默认租户的 Management API 数据**：
   - 创建 `https://default.logto.app/api` 资源
   - 创建 `all` scope
   - 创建 `default:admin` 角色并关联 scope
6. **初始化 Admin Tenant 的 Me API 数据**：
   - 创建 `https://admin.logto.app/me` 资源
   - 创建 `all` scope
   - 创建 `user` 角色并关联 scope

### 3.2 阶段二：Seed Admin Tenant 数据

脚本：[1.0.0-1677765137-seed-for-admin-tenant.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.0.0-1677765137-seed-for-admin-tenant.ts)

**执行步骤**：

1. **创建 Admin Management API**：
   - 资源：`https://admin.logto.app/api` (管理 Admin Tenant 自身)
   - 资源：`https://cloud.logto.io/api` (Cloud 相关操作)
   - 创建 `admin:admin` 角色，分配 Admin API 的 `all` scope
   - 给 `user` 角色分配 Cloud API 的 `create:tenant` scope

2. **初始化 Admin Console 配置**：
   ```sql
   insert into logto_configs (tenant_id, key, value)
   values ('admin', 'adminConsole', {
     language: 'en',
     appearanceMode: 'system',
     livePreviewChecked: false,
     applicationCreated: false,
     signInExperienceCustomized: false,
     passwordlessConfigured: false,
     selfHostingChecked: false,
     communityChecked: false,
     m2mApplicationCreated: false,
   });
   ```

### 3.3 阶段三：迁移现有 Admin 用户

脚本：[1.0.0_rc.1-1676190092-migrate-admin-data.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/schemas/alterations/1.0.0_rc.1-1676190092-migrate-admin-data.ts)

**执行步骤**：

1. **为 Admin Tenant 初始化 OIDC 配置** - 生成私钥和 Cookie 密钥
2. **查找 Admin 用户** - 查询具有 `admin` 角色的用户
3. **验证用户角色** - 确保 Admin 用户没有其他角色（否则需要用户手动处理）
4. **数据迁移**：
   - 从 `users_roles` 中删除这些用户的角色关联
   - 将这些用户的 `tenant_id` 从 `default` 改为 `admin`
   - 迁移相关的 `logs` 和 `oidc_model_instances` 数据
5. **重新分配角色** - 在 Admin Tenant 中为这些用户分配 `default:admin` 和 `user` 角色

---

## 四、Seed 命令中的租户初始化

### 4.1 Seed 总流程

[index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/cli/src/commands/database/seed/index.ts) 中 `seedByPool()` 是入口：

```typescript
export const seedByPool = async (pool: DatabasePool, options: SeedByPoolOptions) => {
  await pool.transaction(async (connection) => {
    const latestTimestamp = await getLatestAlterationTimestamp();
    
    // 1. 创建所有表
    const tableInfo = await createTables(connection, encryptBaseRole);
    
    // 2. 插入种子数据
    await seedTables(connection, latestTimestamp, cloud, options);
    
    // 3. Cloud 专属数据
    if (cloud) {
      await seedCloud(connection);
    }
    
    // 4. 测试数据
    if (test) {
      await seedTest(connection);
    }
  });
};
```

**关键设计**：
- 获取最新的 alteration 时间戳，seed 完成后直接设置到该版本
- 整个过程在单个事务中执行，失败全部回滚
- Seed 数据后数据库时间戳直接跳到最新，无需逐个执行 alteration

### 4.2 创建表结构

[tables.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/cli/src/commands/database/seed/tables.ts#L93-L150) 中 `createTables()`：

1. 从 `@logto/schemas/tables` 目录读取所有 `.sql` 文件
2. 根据 `init_order` 注释确定执行顺序
3. 支持三个生命周期钩子：
   - `before_all` - 创建表前执行（如创建基础角色）
   - `after_each` - 每张表创建后执行（如启用 RLS、设置权限）
   - `after_all` - 所有表创建后执行

### 4.3 种子数据准备

[tables.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/cli/src/commands/database/seed/tables.ts#L152-L231) 中 `seedTables()` 是核心：

#### Default Tenant 初始化
```typescript
await createTenant(connection, defaultTenantId);           // 创建 default 租户
await seedOidcConfigs(connection, defaultTenantId);        // 初始化 OIDC 配置
await seedAdminData(connection, defaultManagementApi);     // 初始化 Management API
await seedPreConfiguredManagementApiAccessRole(...);       // 创建预配置的访问角色
```

#### Admin Tenant 初始化
```typescript
await createTenant(connection, adminTenantId);             // 创建 admin 租户
await seedOidcConfigs(connection, adminTenantId);          // 初始化 OIDC 配置
await seedAdminData(connection, createAdminDataInAdminTenant(defaultTenantId));  // default 租户的管理 API
await seedAdminData(connection, createAdminDataInAdminTenant(adminTenantId));    // admin 租户的管理 API
await seedAdminData(connection, createMeApiInAdminTenant());                    // Me API
await seedAdminData(connection, cloudData, ...cloudAdditionalScopes);            // Cloud API
```

#### 通用配置
- 创建 `tenant-application` 角色（用于 M2M 应用访问 Cloud API）
- 创建 Admin Console 配置（default 和 admin 两个租户）
- 创建 ID Token 配置
- 创建 Sign-in Experience 配置
- 创建 Admin Console 应用
- 创建 Account Center 配置

#### 租户组织初始化
[tenant-organizations.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/cli/src/commands/database/seed/tenant-organizations.ts) 中 `seedTenantOrganizations()`：

1. **初始化组织模板**：
   - 创建 TenantRole (Admin, Member, Collaborator) 对应的组织角色
   - 创建 TenantScope 对应的组织 scope
   - 建立角色与 scope 的关联关系

2. **创建租户组织**：
   - 为 `default` 和 `admin` 两个租户各创建一个组织
   - 组织 ID 与租户 ID 有固定映射关系

#### Management API Proxy 应用

[tenant.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/cli/src/commands/database/seed/tenant.ts#L125-L152) 中 `seedManagementApiProxyApplications()`：

为 `default` 和 `admin` 租户各创建一个 M2M 应用，作为 Management API 的代理，并分配对应的 proxy 角色。

### 4.4 租户创建函数

[tenant.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/cli/src/commands/database/seed/tenant.ts#L27-L42) 中 `createTenant()`：

```typescript
export const createTenant = async (pool: CommonQueryMethods, tenantId: string) => {
  const database = await getDatabaseName(pool, true);
  const { parentRole, role, password } = createTenantDatabaseMetadata(database, tenantId);
  
  // 插入 tenants 表记录
  await pool.query(insertInto({ id: tenantId, dbUser: role, dbUserPassword: password }, 'tenants'));
  
  // 创建 PostgreSQL 角色
  await pool.query(sql`
    create role ${sql.identifier([role])} with inherit login
      password '${sql.raw(password)}'
      in role ${sql.identifier([parentRole])};
  `);
};
```

---

## 五、运行时租户解析

[tenant.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/utils/tenant.ts) 中 `getTenantId()` 负责从请求 URL 解析租户 ID：

```
请求 URL → 匹配规则 → 租户ID
    │
    ├─ 匹配 Admin URL → adminTenantId ('admin')
    ├─ 开发模式指定 → developmentTenantId
    ├─ 单租户模式 → defaultTenantId ('default')
    ├─ 路径模式 → 从 URL 路径提取
    └─ 域名模式 → 从自定义域名或通配符域名匹配
```

解析结果会通过 [koa-tenant-guard.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/65-logto/packages/core/src/middleware/koa-tenant-guard.ts) 中间件设置到请求上下文。

---

## 六、整体流程关系图

```
┌─────────────────────────────────────────────────────────────────┐
│                     数据库初始化 (首次部署)                      │
├─────────────────────────────────────────────────────────────────┤
│  pnpm cli db seed                                               │
│    │                                                            │
│    ├─ createTables()          → 创建所有表 + RLS 策略           │
│    ├─ seedTables()            → 插入 default/admin 租户数据     │
│    │   ├─ createTenant(default)                                │
│    │   ├─ createTenant(admin)                                  │
│    │   ├─ seedAdminData()    → API 资源、角色、scope            │
│    │   ├─ seedTenantOrganizations()                           │
│    │   └─ seedManagementApiProxyApplications()                │
│    └─ updateDatabaseTimestamp() → 直接跳到最新版本              │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        版本升级 (已有数据库)                      │
├─────────────────────────────────────────────────────────────────┤
│  pnpm alteration deploy <version>                                │
│    │                                                            │
│    ├─ getAvailableAlterations() → 比较文件与数据库时间戳        │
│    ├─ chooseAlterationsByVersion() → 筛选要执行的脚本           │
│    └─ 逐个执行 deployAlteration()                                │
│         ├─ beforeUp()        → 非事务性前置操作 (可选)          │
│         └─ transaction {                                         │
│              up()             → 事务性升级                       │
│              updateDatabaseTimestamp() → 更新版本号              │
│            }                                                    │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                        Admin Tenant 创建时间线                                        │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  1.0.0_rc.0 系列                                                                                       │
│    ├─ 1674032095.3  →  创建 tenants 表                                                                │
│    ├─ 1674032095.5  →  为所有表添加 tenant_id 列 + RLS                                                │
│    └─ 1674032095.6  →  添加 set_tenant_id 触发器                                                      │
│                                                                                                        │
│  1.0.0_rc.1 系列                                                                                       │
│    ├─ 1676115897  →  add-admin-tenant.ts                                                              │
│    │                  • 更新触发器函数                                                                 │
│    │                  • 创建 admin 租户 + 数据库角色                                                  │
│    │                  • 初始化 default 租户 Management API                                            │
│    │                  • 初始化 admin 租户 Me API                                                      │
│    ├─ 1676190092  →  migrate-admin-data.ts                                                            │
│    │                  • 为 admin 租户生成 OIDC 配置                                                   │
│    │                  • 将 admin 用户从 default 迁移到 admin 租户                                     │
│    └─ ... (其他变更)                                                                                  │
│                                                                                                        │
│  1.0.0 系列                                                                                           │
│    └─ 1677765137  →  seed-for-admin-tenant.ts                                                         │
│                       • 创建 Admin Management API                                                     │
│                       • 创建 Cloud API                                                                 │
│                       • 初始化 Admin Console 配置                                                     │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 七、关键注意事项

### 7.1 Seed vs Alteration 的区别

| 维度 | Seed (`pnpm cli db seed`) | Alteration (`pnpm alteration deploy`) |
|------|--------------------------|--------------------------------------|
| 适用场景 | 全新数据库初始化 | 已有数据库版本升级 |
| 执行方式 | 单个事务，直接创建最新 Schema | 逐个脚本执行，每个脚本独立事务 |
| 版本处理 | 直接跳到最新时间戳 | 逐步更新，每个脚本更新一次 |
| 数据准备 | 完整的种子数据 | 增量数据迁移/转换 |
| 回滚能力 | 无（事务整体回滚） | 支持 `down()` 回滚 |

### 7.2 Admin Tenant 的特殊性

1. **固定 ID**：`admin`（其他租户是自动生成的 6 位字符）
2. **数据归属**：所有租户的管理数据（如用户角色、组织关系）都存储在 Admin Tenant 中
3. **双角色体系**：Admin Tenant 中同时存在管理其他租户的角色和管理自身的角色
4. **预配置角色**：
   - `{tenantId}:admin` - 租户管理员角色
   - `tenant-application` - M2M 应用访问 Cloud API 的角色
   - `user` - Admin Tenant 普通用户角色

### 7.3 时间戳版本控制

- Alteration 脚本使用 **Unix 秒级时间戳** 作为版本号（10位数字）
- 同一时间戳可通过 `.1`, `.2` 后缀创建子版本
- `next-` 前缀表示开发中的变更，还未绑定到具体版本
- 数据库中只存储一个整数时间戳，表示当前已部署的最新版本

### 7.4 非事务性操作风险

如果 alteration 包含 `beforeUp` 步骤，失败时这部分操作可能已经生效，需要：
1. 检查数据库状态
2. 手动修复问题
3. 重新运行部署命令来同步状态和时间戳
