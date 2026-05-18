# 组织邀请完整生命周期分析

## 概述

组织邀请是 Logto 中用于邀请用户加入组织的核心功能。其完整生命周期跨越三个主要阶段：
1. **邀请生成与链接签发** - 创建邀请记录、关联角色、发送邀请邮件
2. **被邀请人接受时的身份校验** - 验证邀请有效性、确认用户身份匹配
3. **加入后的角色与权限赋予** - 建立组织成员关系、分配角色权限

## 一、数据模型与表结构

### 1.1 主表：`organization_invitations`

**文件位置**: `packages/schemas/tables/organization_invitations.sql`

| 字段 | 类型 | 说明 |
|------|------|------|
| `tenant_id` | varchar(21) | 租户ID，多租户隔离 |
| `id` | varchar(21) | 邀请唯一标识 |
| `inviter_id` | varchar(21) | 邀请人用户ID（可空） |
| `invitee` | varchar(256) | 被邀请人邮箱 |
| `accepted_user_id` | varchar(21) | 接受邀请的用户ID |
| `organization_id` | varchar(21) | 目标组织ID |
| `status` | enum | 邀请状态：Pending/Accepted/Expired/Revoked |
| `created_at` | timestamptz | 创建时间 |
| `updated_at` | timestamptz | 最后更新时间 |
| `expires_at` | timestamptz | 过期时间 |

**关键约束**:
- 唯一索引：`(tenant_id, invitee, organization_id)` 仅对 `Pending` 状态生效，确保同一邮箱在同一组织只有一个待处理邀请

### 1.2 角色关系表：`organization_invitation_role_relations`

**文件位置**: `packages/schemas/tables/organization_invitation_role_relations.sql`

| 字段 | 类型 | 说明 |
|------|------|------|
| `tenant_id` | varchar(21) | 租户ID |
| `organization_invitation_id` | varchar(21) | 邀请ID |
| `organization_role_id` | varchar(21) | 组织角色ID |

### 1.3 状态枚举

```typescript
enum OrganizationInvitationStatus {
  Pending = 'Pending',    // 待接受
  Accepted = 'Accepted',  // 已接受
  Expired = 'Expired',    // 已过期
  Revoked = 'Revoked',    // 已撤销
}
```

**终态**: `Accepted`、`Expired`、`Revoked` 为终态，不可再变更。

## 二、邀请生成与链接签发

### 2.1 入口 API

**文件位置**: `packages/core/src/routes/organization-invitation/index.ts:53-87`

```typescript
router.post('/', koaGuard({...}), async (ctx) => {
  ctx.body = await organizationInvitations.insert(body, messagePayload, ctx.request.ip);
});
```

**请求参数**:
- `inviterId`: 邀请人ID（可选）
- `invitee`: 被邀请人邮箱
- `organizationId`: 组织ID
- `expiresAt`: 过期时间（必须大于当前时间）
- `organizationRoleIds`: 角色ID数组（可选）
- `messagePayload`: 邮件内容，包含 `link` 字段（可选，传 `false` 则不发邮件）

### 2.2 核心创建逻辑

**文件位置**: `packages/core/src/libraries/organization-invitation.ts:56-117`

#### 前置校验
1. **成员身份检查**: 检查被邀请人是否已是组织成员
   ```typescript
   if (await this.queries.organizations.relations.users.isMember(organizationId, invitee)) {
     throw new RequestError({...});
   }
   ```

2. **过期邀请清理**: 更新该用户在该组织下已过期的邀请状态
   ```typescript
   await organizationQueries.invitations.updateExpiredEntities({ invitee, organizationId });
   ```

#### 数据落库（事务内）
```typescript
return this.queries.pool.transaction(async (connection) => {
  const organizationQueries = new OrganizationQueries(connection);
  
  // 1. 清理过期邀请
  await organizationQueries.invitations.updateExpiredEntities({ invitee, organizationId });
  
  // 2. 插入邀请主记录
  const invitation = await organizationQueries.invitations.insert({
    id: generateStandardId(),
    inviterId,
    invitee,
    organizationId,
    status: OrganizationInvitationStatus.Pending,
    expiresAt,
  });

  // 3. 插入邀请-角色关系
  if (organizationRoleIds?.length) {
    await organizationQueries.relations.invitationsRoles.insert(
      ...organizationRoleIds.map((roleId) => ({
        organizationInvitationId: invitation.id,
        organizationRoleId: roleId,
      }))
    );
  }

  // 4. 发送邀请邮件（可选）
  if (messagePayload) {
    const templateContext = await this.getOrganizationInvitationTemplateContext(...);
    await this.sendEmail(invitee, { ...templateContext, ...messagePayload }, ip);
  }

  return organizationQueries.invitations.findById(invitation.id);
});
```

### 2.3 链接签发机制

邀请链接由调用方（前端/管理控制台）生成，通过 `messagePayload.link` 传入。系统本身不生成链接，仅负责：
- 验证链接有效性由前端体验层负责
- 邮件模板使用 `{{link}}` 占位符渲染链接
- 链接通常包含邀请ID，用于后续接受邀请时识别

**邮件模板示例** (`organization-invitation.test.ts:17`):
```html
Click {{link}} to join the organization.
```

### 2.4 邮件内容增强

系统自动注入以下上下文信息到邮件模板：
- `organization`: 组织信息（ID、名称、品牌信息等）
- `inviter`: 邀请人信息（ID、名称、头像等）

## 三、被邀请人接受时的身份校验

### 3.1 入口 API

**文件位置**: `packages/core/src/routes/organization-invitation/index.ts:123-171`

```typescript
router.put('/:id/status', koaGuard({...}), async (ctx) => {
  const { id } = ctx.guard.params;
  const { status, acceptedUserId } = ctx.guard.body;
  
  if (status === OrganizationInvitationStatus.Accepted) {
    const result = await organizationInvitations.updateStatus(id, status, acceptedUserId);
    ctx.appendDataHookContext('Organization.Membership.Updated', { organizationId });
    ctx.body = result;
  } else {
    ctx.body = await organizationInvitations.updateStatus(id, status);
  }
});
```

### 3.2 接受邀请的校验流程

**文件位置**: `packages/core/src/libraries/organization-invitation.ts:148-223`

#### 前置校验
1. **终态检查**: 邀请不能处于终态
   ```typescript
   if (endingStatuses.includes(entity.status)) {
     throw new RequestError({ code: 'request.invalid_input', ... });
   }
   ```

2. **动态过期检查**: 查询时动态计算过期状态
   - **文件位置**: `packages/core/src/queries/organization/index.ts:209-215`
   ```sql
   case
     when status = 'Pending' and expires_at < now()
     then 'Expired'
     else status
   end as "status"
   ```

3. **用户邮箱匹配校验**: 接受邀请的用户邮箱必须与邀请邮箱一致
   ```typescript
   const user = await userQueries.findUserById(acceptedUserId);
   if (user.primaryEmail?.toLowerCase() !== entity.invitee.toLowerCase()) {
     throw new RequestError({ code: 'request.invalid_input', ... });
   }
   ```

### 3.3 事务保障

所有校验和后续操作都在同一个数据库事务中执行，确保原子性：
- 校验失败 → 事务回滚，邀请状态不变
- 校验通过 → 执行成员关系创建和角色分配

## 四、加入后的角色与权限赋予

### 4.1 组织成员关系创建

**文件位置**: `packages/core/src/libraries/organization-invitation.ts:190-193`

```typescript
await organizationQueries.relations.users.insert({
  organizationId: entity.organizationId,
  userId: acceptedUserId,
});
```

**表**: `organization_user_relations`
- 建立用户与组织的基本成员关系
- 无角色的用户仅拥有最基本的组织访问权限

### 4.2 角色权限分配

**文件位置**: `packages/core/src/libraries/organization-invitation.ts:195-203`

```typescript
if (entity.organizationRoles.length > 0) {
  await organizationQueries.relations.usersRoles.insert(
    ...entity.organizationRoles.map((role) => ({
      organizationId: entity.organizationId,
      organizationRoleId: role.id,
      userId: acceptedUserId,
    }))
  );
}
```

**表**: `organization_role_user_relations`
- 从邀请的角色关系中复制角色
- 每个角色创建一条用户-角色关联记录

### 4.3 邀请状态更新

**文件位置**: `packages/core/src/libraries/organization-invitation.ts:214-219`

```typescript
const updated = {
  status,
  acceptedUserId,
  updatedAt: Date.now(),
};
await organizationQueries.invitations.updateById(id, updated);
```

### 4.4 数据 Hook 触发

接受成功后触发 `Organization.Membership.Updated` 数据钩子，用于通知外部系统成员关系变更。

## 五、状态流转详解

### 5.1 状态流转图

```
Pending (待接受)
    │
    ├─→ 过期时间到 → Expired (已过期) [终态]
    │
    ├─→ 撤销操作 → Revoked (已撤销) [终态]
    │
    └─→ 接受邀请且校验通过 → Accepted (已接受) [终态]
           │
           ├─ 创建 organization_user_relations 记录
           └─ 创建 organization_role_user_relations 记录
```

### 5.2 状态查询的特殊处理

**文件位置**: `packages/core/src/queries/organization/index.ts:209-215`

查询时动态计算状态：
- 数据库中存储的状态可能仍是 `Pending`
- 如果 `expires_at < now()`，返回时自动标记为 `Expired`
- 这种设计避免了后台定时任务轮询更新过期状态

### 5.3 过期状态的实际更新

虽然查询时动态计算过期，但在以下场景会实际更新数据库中的状态：
- 创建新邀请时，清理该用户在该组织下的过期邀请
  **文件位置**: `packages/core/src/libraries/organization-invitation.ts:79`
  ```typescript
  await organizationQueries.invitations.updateExpiredEntities({ invitee, organizationId });
  ```

## 六、核心数据落库点汇总

| 阶段 | 操作 | 表 | 关键代码位置 |
|------|------|-----|------------|
| **邀请创建** | 插入邀请主记录 | `organization_invitations` | `organization-invitation.ts:81-88` |
| **邀请创建** | 插入邀请-角色关系 | `organization_invitation_role_relations` | `organization-invitation.ts:90-97` |
| **过期清理** | 更新过期邀请状态 | `organization_invitations` | `organization-invitation.ts:79` |
| **接受邀请** | 创建组织-用户关系 | `organization_user_relations` | `organization-invitation.ts:190-193` |
| **接受邀请** | 创建用户-角色关系 | `organization_role_user_relations` | `organization-invitation.ts:195-203` |
| **接受邀请** | 更新邀请状态为Accepted | `organization_invitations` | `organization-invitation.ts:214-219` |
| **撤销邀请** | 更新邀请状态为Revoked | `organization_invitations` | `organization-invitation.ts:206-208` |

## 七、关键设计特点

### 7.1 事务一致性
所有状态变更和数据写入都在数据库事务中执行，确保：
- 邮件发送失败时，邀请记录回滚
- 接受邀请时，校验、成员创建、角色分配原子完成

### 7.2 动态过期计算
通过查询时动态计算过期状态，避免了：
- 后台定时任务的复杂性
- 数据库状态与实际状态的不一致窗口

### 7.3 角色关系解耦
邀请的角色信息独立存储在关系表中：
- 支持多角色分配
- 接受邀请时从关系表复制到用户角色表
- 邀请记录保留完整的角色快照

### 7.4 邮箱身份校验
通过邮箱匹配确保：
- 只有被邀请的邮箱对应的用户才能接受邀请
- 防止恶意用户使用非邀请账号接受邀请

## 八、代码引用速查

| 模块 | 文件路径 |
|------|---------|
| 邀请核心逻辑 | `packages/core/src/libraries/organization-invitation.ts` |
| 邀请API路由 | `packages/core/src/routes/organization-invitation/index.ts` |
| 邀请查询逻辑 | `packages/core/src/queries/organization/index.ts` |
| 用户关系查询 | `packages/core/src/queries/organization/user-relations.ts` |
| 用户角色关系 | `packages/core/src/queries/organization/user-role-relations.ts` |
| 表结构定义 | `packages/schemas/tables/organization_invitations.sql` |
| 角色关系表 | `packages/schemas/tables/organization_invitation_role_relations.sql` |
| 类型定义 | `packages/schemas/src/types/organization.ts` |
| 集成测试 | `packages/integration-tests/src/tests/api/organization/organization-invitation.*.test.ts` |
