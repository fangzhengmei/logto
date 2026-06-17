# 刷新令牌轮换（Refresh Token Rotation）代码分析

## 概述

刷新令牌轮换是 OAuth 2.0 安全最佳实践，每次使用刷新令牌换取新访问令牌时，都会同时签发一个新的刷新令牌并作废旧的。本文从请求进入到响应返回，梳理完整处理脉络，重点关注：**旧令牌作废窗口**、**并发刷新去重**、**异常吊销分支**。

---

## 一、核心文件索引

| 文件 | 作用 |
|------|------|
| [refresh-token.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/grants/refresh-token.ts) | `refresh_token` grant 主处理逻辑 |
| [defaults.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/defaults.ts) | 默认轮换策略与 TTL 策略 |
| [init.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/init.ts) | OIDC Provider 初始化，注册轮换配置 |
| [oidc-model-instance.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/queries/oidc-model-instance.ts) | 数据层：消费判定、作废窗口、按 grantId 批量吊销 |
| [adapter.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/adapter.ts) | oidc-provider ↔ 数据库的适配层 |
| [grant.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/event-listeners/grant.ts) | grant 成功/错误/吊销事件审计日志 |

---

## 二、请求进入到响应返回：完整处理顺序

以下步骤对应 [refresh-token.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/grants/refresh-token.ts#L75-L335) 的 `buildHandler` 函数，按执行顺序排列：

### 阶段 1：参数校验与令牌查找（L75–L98）

```
请求进入
  │
  ├─ 校验 params、client 是否存在
  ├─ 校验 refresh_token 参数必传
  └─ RefreshToken.find(refreshTokenValue, { ignoreExpiration: true })
        │
        └─ 不存在 → 抛 InvalidGrant('refresh token not found')
```

数据库查找经由 [adapter.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/adapter.ts#L217) → `findPayloadById` → [oidc-model-instance.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/queries/oidc-model-instance.ts#L74-L81)。

### 阶段 2：基础合法性校验（L100–L164）

依次校验：
1. **clientId 匹配**：刷新令牌的 clientId 必须等于当前认证客户端的 clientId
2. **未过期**：`refreshToken.isExpired` 为 false
3. **grantId 存在**：刷新令牌必须关联一个 Grant
4. **Grant 存在且有效**：通过 `grantId` 查找 Grant，校验未过期且 clientId 匹配
5. **Scope 子集**：请求的 scope 必须是刷新令牌原有 scope 的子集
6. **Account 存在**：刷新令牌关联的用户账户必须存在，且与 Grant 中的 accountId 一致
7. **⚠️ 是否已消费（关键分支）**：见下方"异常吊销分支"

### 阶段 3：业务权限校验（L166–L182）

```
  ├─ assertUserHasApplicationAccessForOidc  —— 用户是否有该应用访问权限
  ├─ checkOrganizationAccess                 —— 组织访问（成员身份、第三方授权、MFA）
  └─ 组织令牌 scope 校验：若传了 organization_id，refresh token 必须含 UserScope.Organizations
```

> 注意：这些校验都发生在 **令牌消费之前**。测试用例 [refresh-token.test.ts L274-L283](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/grants/refresh-token.test.ts#L274-L283) 专门验证了"权限拒绝时 consume 不会被调用"。

### 阶段 4：轮换决策（L184–L218）

是否轮换由 `rotateRefreshToken` 配置决定，执行顺序：

1. [init.ts L443-L454](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/init.ts#L443-L454) 先检查应用级开关 `client.metadata().rotateRefreshToken`，若显式为 false 则不轮换
2. 否则调用 [defaults.ts L23-L41](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/defaults.ts#L23-L41) 的默认策略：
   - 总寿命超过 1 年（365.25天）→ **不再轮换**（上限保护）
   - 公共客户端（`clientAuthMethod === 'none'）且非发送方约束令牌 → **强制轮换**
   - 令牌已过 TTL 的 70% → **轮换**

若判定需要轮换：

```
  ├─ refreshToken.consume()                     —— 标记旧令牌为已消费（写 consumedAt）
  ├─ ctx.oidc.entity('RotatedRefreshToken', ...) —— 存入上下文供 TTL 策略读取
  ├─ new RefreshToken({ ... 旧令牌属性 })        —— 构造新令牌，rotations + 1
  └─ refreshToken.save()                         —— 新令牌入库，返回新 token 值
```

### 阶段 5：签发 Access Token 与 Id Token（L220–L323）

```
  ├─ new AccessToken(...)
  ├─ handleDPoP / handleClientCertificate        —— 发送方约束绑定
  ├─ 分支：
  │    ├─ 有 organization_id 且无 resource → 签发组织令牌（handleOrganizationToken）
  │    └─ 否则 → 普通 OIDC/资源令牌（resolveResource + getResourceServerInfo）
  ├─ AccessToken.save()
  └─ scope 含 openid 时签发 IdToken
```

### 阶段 6：构造响应体（L325–L334）

```
ctx.body = {
  access_token,
  expires_in,
  id_token,       // 可选
  refresh_token,  // 轮换后为新值，未轮换则为原值
  scope,
  token_type,
}
```

---

## 三、旧令牌作废窗口（Reuse Interval / Leeway）

### 代码位置

核心实现在 [oidc-model-instance.ts L25-L54](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/queries/oidc-model-instance.ts#L25-L54)：

```typescript
const refreshTokenReuseInterval = 3; // 硬编码 3 秒

const isConsumed = (modelName: string, consumedAt: Nullable<number>): boolean => {
  if (!consumedAt) return false;
  if (modelName !== 'RefreshToken') return Boolean(consumedAt);
  // 仅对 RefreshToken 应用宽限窗口
  return isBefore(addSeconds(consumedAt, refreshTokenReuseInterval), Date.now());
};
```

### 工作原理

数据库层在 `consumedAt` 字段记录了消费时间戳。但在查询返回给 oidc-provider 之前，`withConsumed` 函数会：

1. 对 **RefreshToken** 模型：只有当 `consumedAt + 3秒 < 当前时间` 时，才在 payload 上附加 `{ consumed: true }`
2. 对其他模型（AccessToken、AuthorizationCode 等）：只要有 consumedAt 就视为已消费

### 设计意图

注释明确说明：
> "This interval helps to avoid concurrency issues when exchanging the rotating refresh token multiple times within a given timeframe; During the leeway window (in seconds), the consumed refresh token will be considered as valid. This is useful for distributed apps and serverless apps like Next.js, in which there is no shared memory."

即应对分布式/Serverless 环境下的并发刷新请求。

---

## 四、并发刷新：3 秒窗口的真去重机制与多令牌签发

### 4.1 问题场景：为什么会有并发？

在 Next.js 等无共享内存的 Serverless 环境中，多个并发请求可能同时携带同一个刷新令牌来换取新令牌。典型场景：
- 前端 SPA 在组件挂载/路由切换时，多个 hook 同时触发 token 刷新
- Serverless 函数水平扩展，两个实例同时收到同一用户的请求
- 移动端网络抖动导致重试，旧请求并未真正丢失

### 4.2 3 秒窗口 + 数据库 UPSERT：真去重的实现原理

**结论先行：3 秒窗口内并不会严格"去重"只签发一个新令牌，而是容忍多个新令牌并行签发，靠数据库的唯一约束和幂等操作保证不出错。**

#### 步骤 1：旧令牌消费的数据库幂等性

旧刷新令牌的 `consume` 操作对应 [oidc-model-instance.ts L167-L174](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/queries/oidc-model-instance.ts#L167-L174)：

```typescript
const consumeInstanceById = async (modelName: string, id: string) => {
  await pool.query(sql`
    update ${table}
    set ${fields.consumedAt}=${convertToTimestamp()}
    where ${fields.modelName}=${modelName}
      and ${fields.id}=${id}
  `);
};
```

这是一个**纯 UPDATE**，不带任何 SELECT-for-UPDATE 锁或事务隔离。N 个并发请求同时执行这条 SQL，结果完全等价于执行一次——所有请求都将 `consumedAt` 设置为"当前时间"，数据库最终只保留最后一次写入的值。**操作天然幂等。**

#### 步骤 2：新刷新令牌的入库：ON CONFLICT DO UPDATE

新刷新令牌的 `save()` 走 adapter 的 `upsert` → [oidc-model-instance.ts L67-L72](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/queries/oidc-model-instance.ts#L67-L72)：

```typescript
const upsertInstance = buildInsertIntoWithPool(pool)(OidcModelInstances, {
  onConflict: {
    fields: [fields.tenantId, fields.modelName, fields.id],
    setExcludedFields: [fields.payload, fields.expiresAt],
  },
});
```

生成的 SQL 形态（见 [insert-into.ts L90-L98](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/database/insert-into.ts#L90-L98)）：

```sql
INSERT INTO oidc_model_instances (tenant_id, model_name, id, payload, expires_at)
VALUES (...)
ON CONFLICT (tenant_id, model_name, id) DO UPDATE
SET payload=excluded.payload, expires_at=excluded.expires_at
```

**关键点：新刷新令牌的主键 `id` 是 oidc-provider 在构造 `new RefreshToken(...)` 时生成的随机 jti（jwt id），全局唯一。** 所以并发请求各自生成的新令牌根本不会在主键上冲突——**它们会以完全独立的两行同时 INSERT 成功**，不存在 ON CONFLICT 的情况。

> 除非发生极低概率的 jti 碰撞，此时 ON CONFLICT DO UPDATE 会用后写入的 payload/expiresAt 覆盖先写入的，保证最终一致性而不抛异常。

#### 步骤 3：最终状态：多个新刷新令牌并存

3 秒窗口内 N 个并发请求 → N 个新刷新令牌写入数据库，全部有效且共享同一个 `grantId`。

```
┌────────────────────────────────────────────────────────────┐
│  并发请求：A、B、C （t=0 至 t=0.3s 内全部到达）                │
│                                                            │
│  A: find RT_old → consumed未设置 → consume → save RT_A     │
│  B: find RT_old → consumed已设但3s内 → 视为未消费           │
│                → consume → save RT_B                       │
│  C: find RT_old → consumed已设但3s内 → 视为未消费           │
│                → consume → save RT_C                       │
│                                                            │
│  数据库最终状态：                                            │
│    RT_old  ── consumedAt=t0                                │
│    RT_A    ── grantId=G1, rotations=N                      │
│    RT_B    ── grantId=G1, rotations=N                      │
│    RT_C    ── grantId=G1, rotations=N   ← 三个都有效         │
└────────────────────────────────────────────────────────────┘
```

### 4.3 这是"去重"吗？为什么这样设计？

严格来说它**不是去重**（不去重，允许多发），而是：

| 方案 | 是否采用 | 原因 |
|------|---------|------|
| SELECT FOR UPDATE + 行锁 | ❌ | 需要额外事务；在连接池/Serverless 下死锁风险高；性能损耗 |
| 3 秒容错 + 允许并发多发 | ✅ | **对客户端最友好**：所有并发请求都能拿到各自的新令牌 |
| 异常吊销分支（3s 外） | ✅ | **对安全最严格**：重放必触发整个 grantId 下所有令牌吊销 |

这是一种**"宽松容错 + 严格安全"**的组合：
- 对合法客户端的偶然并发（预期内的网络波动/Serverless 多实例）→ **完全不报错**，多发几个令牌代价极小
- 对攻击者的故意重放（3 秒外重试同一个旧令牌）→ **最严厉惩罚**，一锅端整个授权链

### 4.4 Access Token 是否也并发多发？

是的。刷新令牌轮换的后续流程还会签发 AT/IDT，它们和 RT 一样：每个并发请求独立构造、独立 jti、独立 INSERT。客户端每个并发请求都收到完整的 token 三元组（AT/RT/IDT）。

---

## 五、异常吊销分支（Reuse Detection）

### 触发条件

[refresh-token.ts L161-L164](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/grants/refresh-token.ts#L161-L164)：

```typescript
if (refreshToken.consumed) {
  await Promise.all([refreshToken.destroy(), revoke(ctx, refreshToken.grantId)]);
  throw new InvalidGrant('refresh token already used');
}
```

只有当 `isConsumed()` 返回 `true`（即 consumedAt + 3 秒 < 当前时间）时，才会进入此分支。

### 执行动作（并行）

| 动作 | 代码 | 效果 |
|------|------|------|
| 销毁旧刷新令牌 | `refreshToken.destroy()` → [adapter.ts L221](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/adapter.ts#L221) → `destroyInstanceById` | 从数据库直接 DELETE 该刷新令牌行 |
| 按 grantId 吊销全部令牌 | `revoke(ctx, grantId)` → oidc-provider 内部 `helpers/revoke.js` → adapter `revokeByGrantId` | 删除该 grantId 下所有 RefreshToken 和 AccessToken |

#### 按 grantId 批量吊销的细节

[oidc-model-instance.ts L184-L205](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/queries/oidc-model-instance.ts#L184-L205)：

```typescript
const revokeInstanceByGrantId = async (modelName: string, grantId: string) => {
  for (;;) {
    const { rowCount } = await pool.query(sql`
      delete from ${table}
      where ${fields.id} in (
        select ${fields.id}
        from ${table}
        where ${fields.modelName}=${modelName}
          and ${fields.payload} ? 'grantId'
          and ${fields.payload}->>'grantId'=${grantId}
        limit 1000   -- 每批 1000 条，防止大事务锁表
      )
    `);
    if (rowCount === 0) return;
  }
};
```

分批删除，每批 1000 条，循环直到删完。

### 安全意义（Refresh Token Reuse Detection）

这是 OAuth 2.0 刷新令牌轮换的安全核心：

```
正常流程：
  合法客户端持有 RT_A → 换取 RT_B → RT_A 被标记 consumed
  3 秒内 RT_A 仍可使用（容错窗口）
  3 秒后 RT_A 彻底作废

攻击场景（令牌泄露 + 重放）：
  攻击者窃取 RT_A → 合法客户端先用 RT_A 换到 RT_B（RT_A consumed）
  3 秒后攻击者再用 RT_A 请求 → 命中 consumed 检查
  → 触发异常吊销：整个 grantId 下所有令牌被清
  → 合法客户端也无法继续使用 RT_B，被迫重新登录
  → 用户感知异常 → 发现泄露
```

这是一种**牺牲可用性换取安全性**的设计：宁可让合法用户掉线，也不让攻击者长期持有有效令牌。

---

## 六、TTL 策略与轮换的联动

### 刷新令牌 TTL 决策

[defaults.ts L8-L20](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/defaults.ts#L8-L20)：

```typescript
const refreshTokenTtl = (ctx, token, client) => {
  if (
    ctx.oidc.entities.RotatedRefreshToken &&          // 本次发生了轮换
    client.applicationType === 'web' &&               // Web 应用（SPA）
    client.clientAuthMethod === 'none' &&             // 公共客户端
    !token.isSenderConstrained()                      // 非发送方约束（无 DPoP/MTLS）
  ) {
    return ctx.oidc.entities.RotatedRefreshToken.remainingTTL;
  }
};
```

### 含义

对于 SPA 的非发送方约束刷新令牌：
- **每次轮换不重新计算完整 TTL**，而是继承旧令牌的 `remainingTTL`（剩余寿命）
- 这防止了通过无限轮换实现"永久有效"
- 但如果配置了 `rotateRefreshToken: false`，或者是机密客户端/有 DPoP 绑定，则 TTL 从应用 metadata 读取，可实现常规滚动续期

---

## 七、事件与审计

轮换成功/失败/吊销都会触发事件监听器 [event-listeners/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/event-listeners/index.ts#L30-L32)：

| 事件 | 触发时机 | 监听器 |
|------|----------|--------|
| `grant.success` | 整个 grant 流程成功 | `grantListener` 记录 ExchangeTokenBy.RefreshToken 审计日志 |
| `grant.error` | 流程中抛错 | `grantListener` 记录错误日志 |
| `grant.revoked` | `revoke()` 被调用时（异常吊销分支） | `grantRevocationListener` 记录 RevokeToken 审计日志 |

---

## 八、完整流程图

```
POST /oidc/token  (grant_type=refresh_token)
  │
  ▼
┌───────────────────────────────┐
│  1. 参数校验 + 查找 RefreshToken  │
│     find → adapter → 数据库       │
│     注入 consumed 标记（含 3s 窗口）│
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐
│  2. 校验：client/过期/grant/scope │
│     /account/权限/组织            │
└──────────────┬────────────────┘
               │
     ┌─────────┴──────────┐
     │ consumed == true ? │  ← 3 秒窗口外重放
     └─────────┬──────────┘
        Yes │        │ No
            ▼        ▼
┌─────────────────┐  ┌──────────────────────────────┐
│ 异常吊销分支     │  │ 3. 轮换决策 rotateRefreshToken │
│ destroy RT      │  │    - 1年上限                   │
│ revoke grantId  │  │    - 公共客户端强制轮换        │
│ 删除所有关联令牌 │  │    - TTL > 70% 轮换            │
│ throw InvalidGrant│ └─────────────┬────────────────┘
└─────────────────┘                │
                           需要轮换 │        │ 不轮换
                                   ▼        ▼
                          ┌────────────────┐
                          │ consume 旧 RT  │  (仅需要轮换时)
                          │ rotations + 1  │
                          │ 新建 RT 并保存 │
                          └───────┬────────┘
                                  │
                                  ▼
                          ┌────────────────┐
                          │ 4. 签发 AT/IDT │
                          │    + 组织令牌   │
                          └───────┬────────┘
                                  │
                                  ▼
                          ┌────────────────┐
                          │ 5. 返回响应体   │
                          │ access_token   │
                          │ refresh_token  │
                          └────────────────┘
```
