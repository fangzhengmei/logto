# 刷新令牌轮换（Refresh Token Rotation）代码分析

## 概述

刷新令牌轮换是 OAuth 2.0 安全最佳实践，每次使用刷新令牌换取新访问令牌时，都会同时签发一个新的刷新令牌并作废旧的。本文从请求进入到响应返回，梳理完整处理脉络，重点关注：**旧令牌作废窗口**、**并发刷新去重**、**异常吊销分支**。

---

## 一、核心文件索引

| 文件 | 作用 |
|------|------|
| [refresh-token.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/grants/refresh-token.ts) | `refresh_token` grant 主处理逻辑 |
| [defaults.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/defaults.ts) | 默认轮换策略与 TTL 策略 |
| [init.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/init.ts) | OIDC Provider 初始化，注册轮换配置（客户端开关 → 默认策略的联动） |
| [oidc-model-instance.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/queries/oidc-model-instance.ts) | 数据层：3 秒消费窗口、按 grantId 批量吊销 |
| [insert-into.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/database/insert-into.ts) | 数据库 UPSERT：ON CONFLICT DO UPDATE，支撑并发写入安全 |
| [adapter.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/adapter.ts) | oidc-provider ↔ 数据库的适配层 |
| [grants/utils.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/grants/utils.ts) | DPoP/mTLS sender-constrained 绑定校验与传递 |
| [oidc.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/schemas/src/consts/oidc.ts) | `customClientMetadataDefault`（rotateRefreshToken 默认 true、refreshTokenTtl 默认 14 天） |
| [oidc-module.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/schemas/src/foundations/jsonb-types/oidc-module.ts) | CustomClientMetadata 类型定义与字段说明 |
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

---

## 十一、代码路径追踪 1：rotateRefreshToken 的二级 fallback 完整调用链

本节追踪：**客户端 metadata 的 `rotateRefreshToken` → 租户级 `customClientMetadataDefault.rotateRefreshToken` → `defaults.rotateRefreshToken(ctx)`** 的完整数据流。

### 11.1 数据源注入链：客户端配置如何变成 `client.metadata()`

#### 步骤 A：数据库 → Application 记录 → adapter Client.find

每个 Logto 应用（Application）在数据库中保存了 `customClientMetadata`（JSONB 字段）。当 oidc-provider 需要 Client 对象时，调用 adapter 的 `find(id)`：

[adapter.ts L178-L200](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/adapter.ts#L178-L200)：

```
find(id):
  ├─ 内建应用（demo/account-center/device-demo）→ 直接 buildXxxClientMetadata(envSet)
  └─ 普通应用 → findApplicationById(id) 查库 → transpileClient(application)
                         │
                         └─ transpileClient() 展开：
                              client_id,
                              client_secret,
                              ...getConstantClientMetadata(envSet, type, customClientMetadata),
                                        │
                                        └─ （注入 application_type, token_endpoint_auth_method 等
                                             基于 ApplicationType 推导的常量）
                              ...transpileMetadata(oidcClientMetadata),  // OIDC 标准字段
                              ...customClientMetadata,                   // ⚠️ 直接展开，
                                                              rotateRefreshToken 在这里注入！
```

**关键代码** [adapter.ts L171](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/adapter.ts#L171)：

```typescript
...customClientMetadata,  // 直接展开数据库中保存的 CustomClientMetadata JSONB
```

数据库中若 `customClientMetadata.rotateRefreshToken` 未设置 → 该字段根本不存在于展开对象中。

#### 步骤 B：oidc-provider Client 包装 `.metadata()`

oidc-provider 内部将 adapter 返回的 plain object 包装为 Client 实例，并暴露 `client.metadata()` 方法返回整个 metadata 对象。

若数据库中从未配置 `rotateRefreshToken` → `client.metadata().rotateRefreshToken === undefined`。

### 11.2 二级 fallback 决策链：`init.ts` 中的配置入口

[init.ts L443-L454](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/init.ts#L443-L454)：

```typescript
rotateRefreshToken: (ctx) => {
  const { Client: client } = ctx.oidc.entities;

  if (
    !(client?.metadata().rotateRefreshToken ?? customClientMetadataDefault.rotateRefreshToken)
  ) {
    return false;
  }

  return defaults.rotateRefreshToken(ctx);
};
```

配合 [oidc.ts L14-L18](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/schemas/src/consts/oidc.ts#L14-L18)：

```typescript
export const customClientMetadataDefault = Object.freeze({
  rotateRefreshToken: true,   // 租户级默认
});
```

### 11.3 `??` + `!` 的精确求值

表达式：`!(A ?? B)`，其中：
- **A** = `client?.metadata().rotateRefreshToken`（应用实际配置 / undefined / null）
- **B** = `customClientMetadataDefault.rotateRefreshToken`（恒为 `true`）

逐行展开求值：

```
第 1 层：client 存在吗？
  ├─ client == null/undefined → client?.metadata() → undefined → A = undefined
  └─ client 存在 → 读 rotateRefreshToken 字段：
       ├─ 数据库显式设置 false → A = false
       ├─ 数据库显式设置 true  → A = true
       └─ 数据库未设置（undefined/null） → A = undefined / null

第 2 层：A ?? B（nullish coalescing）
  只有 A === undefined 或 A === null 时才取 B

第 3 层：!() 取反

真值表：

   A（应用配置）      │  A ?? B  │  !(A ?? B)  │  返回值      │  含义
  ───────────────────┼──────────┼────────────┼────────────┼───────────
   true              │ true     │ false      │ 跳过 if    │ → 继续 defaults
   undefined         │ true(B)  │ false      │ 跳过 if    │ → 继续 defaults
   null              │ true(B)  │ false      │ 跳过 if    │ → 继续 defaults
   false             │ false    │ true       │ 进入 if    │ → return false（不轮换）
```

**结论：只有应用显式将 `rotateRefreshToken = false` 写入数据库时才能关闭轮换；其他所有情况都走 `defaults.rotateRefreshToken(ctx)`。**

### 11.4 `defaults.rotateRefreshToken(ctx)` 的内部规则

[defaults.ts L23-L41](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/defaults.ts#L23-L41) 内部再做 3 条短路判断，见专题六。

完整链路图：

```
POST /oidc/token (grant_type=refresh_token)
        │
        ▼
  oidc-provider 认证 client
        │
        ▼
  buildHandler() 进入主流程
        │
        ▼
  L184: rotateRefreshToken === true || (typeof === 'function' && await rotateRefreshToken(ctx))
        │
        ▼
  ┌── init.ts rotateRefreshToken(ctx) ────────────────────────────────┐
  │   const A = client?.metadata().rotateRefreshToken                │
  │   const B = customClientMetadataDefault.rotateRefreshToken (true) │
  │   if (!(A ?? B)) → return false     ← 只有 A===false 才走这里     │
  │   return defaults.rotateRefreshToken(ctx)                         │
  └──────────────────────────────────────────────────────────────────┘
        │
        ▼
  ┌── defaults.rotateRefreshToken(ctx) ─────────────────────────┐
  │   规则 0: refreshToken / client 存在？ 否 → return false     │
  │   规则 1: totalLifetime() ≥ 1 年？ 是 → return false        │
  │   规则 2: 公共客户端 + 非发送方约束？ 是 → return true       │
  │   规则 3: ttlPercentagePassed() ≥ 70%？ 是→true 否→false     │
  └──────────────────────────────────────────────────────────────┘
        │
        ▼
  返回 true  → 进入轮换（consume + 新 RT + 保存）
  返回 false → 跳过轮换，refreshToken 保持原值
```

---

## 十二、代码路径追踪 2：rotations 字段——写入了但从未被读取做上限保护

### 12.1 写入位置：唯一一处 `rotations` 赋值

[refresh-token.ts L204](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/grants/refresh-token.ts#L204)：

```typescript
rotations: typeof refreshToken.rotations === 'number' ? refreshToken.rotations + 1 : 1,
```

语义：
- 旧令牌上有 `rotations` 字段 → +1
- 旧令牌上没有（首次授权签发的 RT，或老数据迁移）→ 从 1 开始

### 12.2 读取位置：全局搜索的证据

对 `packages/` 全目录搜索 `.rotations` 和 `rotations` 两个模式的结果：

| 搜索模式 | 匹配文件数 | 匹配行数 | 匹配语义 |
|---------|-----------|---------|---------|
| `"rotations"` 字符串全文 | 1 | L204 | **仅写入**，构造新 RefreshToken 时赋值 |
| `\.rotations` 点属性读取 | 1 | L204 | **读自己的旧值**，纯粹为了 `+1` 写回新 token |

**在整个 Logto 代码库（所有 `packages/**`）中，没有任何地方用 `rotations` 做分支判断、比较运算、或阈值检查。**

### 12.3 真正的上限保护机制：`iiat` + `totalLifetime()`

`rotations` 写入后原样存入数据库的 `payload` JSONB，供 oidc-provider 内部或外部调试时读取。**实际生效的上限保护不依赖它。**

实际生效的链条：

```
  初始授权
     │
     ▼
  RT_0.iiat = 首次签发时间（epoch）
     │
     ├── 轮换 1 次 → RT_1.iiat = RT_0.iiat （传递，不重置）
     ├── 轮换 2 次 → RT_2.iiat = RT_0.iiat
     └── 轮换 N 次 → RT_N.iiat = RT_0.iiat
                        │
                        ▼
             defaults.rotateRefreshToken L32
             if (refreshToken.totalLifetime() >= 1 year) return false
                        │
                        ▼
             oidc-provider 内部 totalLifetime() = Date.now() - iiat
                        │
                        ▼
             ≥ 1 年 → 停止轮换
             < 1 年 → 继续检查其他条件
```

更严的更早生效上限：**Grant TTL = 180 天**

[init.ts L441](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/init.ts#L441) 设置 `Grant: 180 * 3600 * 24` = 180 天。在轮换主流程的 [refresh-token.ts L125-L127](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/grants/refresh-token.ts#L125-L127)：

```typescript
if (isKeyInObject(grant, 'isExpired') && grant.isExpired) {
  throw new InvalidGrant('grant is expired');
}
```

发生在 rotateRefreshToken 决策 **之前**。所以：
- Day 0-180：Grant 有效，totalLifetime() < 180 天 < 1 年 → 正常轮换
- Day 180-365：Grant 过期 → 早于 rotateRefreshToken 决策被拦截 → **永远不会触发 1 年上限**
- Day 365+：理论上 stop，但 Grant 早已失效，实际不到

### 12.4 rotations 字段的真实作用

虽然不参与控制，但写入 rotations 不是无意义的死代码：

1. **可观测性**：payload JSONB 中保存该值，可通过数据库查询分析用户刷新频率
2. **oidc-provider 兼容性**：oidc-provider 原库默认会在 Rotating RefreshToken 时维护该字段，Logto 作为 fork 保留了该行为
3. **未来功能**：如果将来要做"轮换 N 次后强制重新授权"的策略，不需要数据迁移就能启用

---

## 十三、代码路径追踪 3：`isSenderConstrained()` 在两条分支中的调用时序、数据流交汇与负面路径

本节追踪同一个刷新令牌上的 `isSenderConstrained()` 如何同时影响 **rotateRefreshToken 决策** 和 **refreshTokenTtl 决策**，以及两条分支的执行顺序、数据流如何交叉。

### 13.1 `isSenderConstrained()` 的判定源头

sender-constrained 绑定来自两条途径，在 AccessToken 签发时校验，在 RefreshToken 构造时**原样传递**：

```
  初始授权/上一次刷新时：
     handleDPoP() → 写入 jkt（JWK 指纹）
     handleClientCertificate() → 写入 x5t#S256（X.509 证书指纹）
     │
     ▼
  RefreshToken payload 中携带：{ jkt, 'x5t#S256' }
     │
     ▼
  [refresh-token.ts L208-L209] 下次轮换时原样传递：
     jkt: refreshToken.jkt
     'x5t#S256': refreshToken['x5t#S256']
     │
     ▼
  oidc-provider RefreshToken.isSenderConstrained() 内部：
     return Boolean(this.jkt || this['x5t#S256'])
```

**即：只要 refresh token 的 payload 中存在 `jkt` 或 `x5t#S256` 任一 → `isSenderConstrained() === true`。**

### 13.2 两条分支中 `isSenderConstrained` 的精确位置

#### 分支 A：rotateRefreshToken 中（正向判断：非 sender-constrained 才强制轮换）

[defaults.ts L36](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/defaults.ts#L36)：

```typescript
if (client.clientAuthMethod === 'none' && !refreshToken.isSenderConstrained()) {
  return true;   // 公共客户端 + 无绑定 → 每次请求都轮换
}
```

此处是 **`!isSenderConstrained()`**：**没有**发送方约束时才 return true（强制轮换）。

#### 分支 B：refreshTokenTtl 中（正面判断：非 sender-constrained 才限制 TTL 继承）

[defaults.ts L15](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/defaults.ts#L15)：

```typescript
if (
  ctx.oidc.entities.RotatedRefreshToken &&
  client.applicationType === 'web' &&
  client.clientAuthMethod === 'none' &&
  !token.isSenderConstrained()            // ⚠️ 同样是 !isSenderConstrained()
) {
  return ctx.oidc.entities.RotatedRefreshToken.remainingTTL;
}
```

此处也是 **`!isSenderConstrained()`**：**没有**发送方约束时才进入 TTL 正面分支（继承剩余寿命，禁止滚动续期）。

### 13.3 完整调用时序：先 rotateRefreshToken，后 refreshTokenTtl

这两个函数在主流程中的调用**位置和顺序**完全由 [refresh-token.ts L184-L218](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/grants/refresh-token.ts#L184-L218) 决定：

```
buildHandler() 主流程
  │
  ├─ L184: await rotateRefreshToken(ctx)          ◄── 调用点 1（决策轮换）
  │     │
  │     └─ defaults.rotateRefreshToken(ctx)
  │           └─ isSenderConstrained() ← 首次读取 jkt/x5t#S256（规则 2）
  │
  │   决策结果：
  │     true  → 继续轮换分支
  │     false → 跳至 AT 签发（跳过 L188-L218，永远不调用 refreshTokenTtl）
  │
  ├─ [仅决策为 true 时执行]
  │    ├─ L188: await refreshToken.consume()
  │    ├─ L189: ctx.oidc.entity('RotatedRefreshToken', refreshToken)  ◄── 设置上下文
  │    │        └────────────────────┐
  │    │                             │  被 refreshTokenTtl 用作条件 1
  │    ├─ L191: new RefreshToken({   │
  │    │      ...                    │
  │    │      rotations: +1          │
  │    │      jkt: 旧值              │  sender-constrained 属性已传递给新 token
  │    │      x5t#S256: 旧值         │
  │    │    })                       │
  │    ├─ L216: ctx.oidc.entity('RefreshToken', refreshToken)
  │    └─ L217: refreshTokenValue = await refreshToken.save()  ◄── 调用点 2（计算 TTL）
  │              │
  │              └─ oidc-provider 内部：
  │                   const ttl = configuration.ttl.RefreshToken(ctx, this, client)
  │                          │
  │                          └─ init.ts L412-L429:
  │                               const defaultTtl = defaults.refreshTokenTtl(ctx, token, client)
  │                                    │
  │                                    └─ defaults.refreshTokenTtl()
  │                                         ├─ 检查 RotatedRefreshToken（上面 L189 设的）  ← 条件 1
  │                                         ├─ applicationType === 'web'                   ← 条件 2
  │                                         ├─ clientAuthMethod === 'none'                 ← 条件 3
  │                                         └─ !token.isSenderConstrained()                ← 条件 4
  │                                                                    ↑
  │                                          第二次读取 jkt/x5t#S256，来自新 RT 本身（继承自旧 RT）
  │
  └─ ... 签发 AT/IDT ...
```

### 13.4 四个组合的完整路径分析

结合 `isSenderConstrained()` 的 true/false 和两条分支的执行条件，得到 4 种典型组合：

#### 组合 1：公共 SPA + **无** sender-constrained（最常见、风险最高）

```
rotateRefreshToken:
  clientAuthMethod === 'none' ✔
  !isSenderConstrained() = true ✔
  → return true（强制轮换，每次请求都轮换）

→ 进入轮换分支：consume + 设置 RotatedRefreshToken + 新 RT.save()
   → 调用 refreshTokenTtl:
     RotatedRefreshToken 存在 ✔
     applicationType='web' ✔
     clientAuthMethod='none' ✔
     !isSenderConstrained()=true ✔
     4/4 条件满足 → 正面分支 → return remainingTTL（继承剩余寿命，禁滚动续期）
```

#### 组合 2：公共 SPA + DPoP/mTLS sender-constrained

```
rotateRefreshToken:
  clientAuthMethod === 'none' ✔
  !isSenderConstrained() = false ❌
  → 跳过 return true → 进入 ttlPercentagePassed() ≥ 70% 判断
     （仅当单个 RT 寿命到期才轮换）

→ 触发轮换时（TTL ≥ 70%）：
   → 调用 refreshTokenTtl:
     RotatedRefreshToken 存在 ✔
     applicationType='web' ✔
     clientAuthMethod='none' ✔
     !isSenderConstrained()=false ❌
     条件 4 不满足 → 负面分支 → return undefined
       → init.ts 读取 metadata.refreshTokenTtlInDays（默认 14 天）
       → 每次轮换重置完整 14 天 TTL，可滚动续期
```

#### 组合 3：传统机密 Web 应用（client_secret_basic）+ 无 sender-constrained

```
rotateRefreshToken:
  clientAuthMethod === 'none' ❌
  → 跳过规则 2 → 进入 ttlPercentagePassed() ≥ 70%

→ 触发轮换时：
   → 调用 refreshTokenTtl:
     clientAuthMethod='client_secret_basic' ❌（条件 3 不满足）
     → 负面分支 → return undefined
       → metadata 取 TTL（默认 14 天，重置完整）
```

#### 组合 4：Native App（application_type=native，auth=none）+ 无 sender-constrained

```
rotateRefreshToken:
  clientAuthMethod === 'none' ✔
  !isSenderConstrained() = true ✔
  → return true（每次请求强制轮换）

→ 调用 refreshTokenTtl:
  applicationType='native' ❌（条件 2：≠ 'web'）
  → 负面分支 → return undefined
    → metadata 取 TTL（默认 14 天，重置完整）
```

### 13.5 负面分支汇总：何时进入 `metadata` TTL 路径

refreshTokenTtl 4 条件中**任一不满足**即进入负面分支返回 `undefined`，然后从 init.ts 走应用配置：

| 不满足的条件 | 场景 | TTL 结果 |
|------------|------|---------|
| `!RotatedRefreshToken` | 本次没轮换（包括 rotateRefreshToken 返回 false 的所有情况） | `refreshTokenTtlInDays` 重置 |
| `applicationType !== 'web'` | Native 应用 | 重置 |
| `clientAuthMethod !== 'none'` | 传统 Web / M2M 机密客户端 | 重置 |
| `isSenderConstrained() === true` | DPoP/mTLS 绑定 | 重置 |

**只有一种组合进入正面分支：公共 Web SPA + 本次轮换了 + 非 sender-constrained。其余全部负面分支，从 metadata 重置完整 TTL。**

### 13.6 数据流交汇点：同一个属性的两次读取

同一个 RefreshToken 上的 `isSenderConstrained()` 属性在一次请求中被读取两次，但**读取对象不同**：

| 读取时机 | 所属函数 | 读取的对象 | 数据来源 |
|---------|---------|-----------|---------|
| L184 之前 | rotateRefreshToken | **旧** RefreshToken（从数据库 `find` 出来那个） | 初始授权或上一次轮换时写入的 jkt/x5t#S256 |
| L217 save() 内部 | refreshTokenTtl | **新** RefreshToken（刚 `new RefreshToken(...)` 构造的） | 从旧 RT 深拷贝传递过来的 `jkt` 和 `x5t#S256` |

两次读取的结果永远一致——因为轮换时 `jkt` 和 `x5t#S256` 是**原样传递**的。所以尽管是两次读取、读取两个不同对象，值保证相同，两条分支的判断不会矛盾。

---

## 十四、代码路径追踪 4：异常吊销分支的无事务并行执行与单边失败的状态分析

### 14.1 异常吊销分支的触发代码

[refresh-token.ts L161-L164](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/grants/refresh-token.ts#L161-L164)：

```typescript
if (refreshToken.consumed) {
  await Promise.all([refreshToken.destroy(), revoke(ctx, refreshToken.grantId)]);
  throw new InvalidGrant('refresh token already used');
}
```

两个操作**无事务包裹**，通过 `Promise.all()` 并发（并行）启动。

### 14.2 两个操作的底层 SQL 与数据影响范围

#### 操作 A：`refreshToken.destroy()` → adapter `destroyInstanceById`

[oidc-model-instance.ts L176-L182](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/queries/oidc-model-instance.ts#L176-L182)：

```sql
DELETE FROM oidc_model_instances
WHERE model_name = 'RefreshToken' AND id = $refreshToken.jti$;
```

**影响范围**：**1 行**，就是当前正在被使用的旧刷新令牌本身（按主键删除）。

#### 操作 B：`revoke(ctx, grantId)` → 调用 oidc-provider 内部 helpers/revoke.js

从 import 路径 [refresh-token.ts L29](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/grants/refresh-token.ts#L29)（`import revoke from 'oidc-provider/lib/helpers/revoke.js'`）可以确认这是 oidc-provider 原库的 revoke helper。结合 [adapter.ts L222](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/adapter.ts#L222) 的 adapter 接口 `revokeByGrantId` 推断，revoke 内部对 oidc-provider 管理的**每个模型类型**（主要是 `RefreshToken` 和 `AccessToken`）分别调用 adapter 的 `revokeByGrantId(modelName, grantId)`。

Logto 侧的 `revokeInstanceByGrantId` 实现见 [oidc-model-instance.ts L184-L205](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/queries/oidc-model-instance.ts#L184-L205)：

```sql
DELETE FROM oidc_model_instances
WHERE id IN (
  SELECT id FROM oidc_model_instances
  WHERE model_name = $modelName$          -- 'RefreshToken' 或 'AccessToken'
    AND payload ? 'grantId'               -- JSONB 含 grantId 键
    AND payload->>'grantId' = $grantId$
  LIMIT 1000
)
-- 循环执行直到 rowCount == 0
```

**影响范围**：
- RefreshToken 模型：**所有**该 grantId 下刷新令牌（含尚未消耗的所有轮换出来的后续令牌）
- AccessToken 模型：**所有**该 grantId 下访问令牌

### 14.3 四种失败场景的数据库最终状态

`Promise.all([destroy, revoke])` 并发启动，无任何数据库事务（BEGIN/COMMIT/ROLLBACK）。两个 DELETE 各自独立提交。

| 场景 | destroy（单条 DELETE） | revoke（N 条分批 DELETE） | 数据库状态 | 安全后果 |
|------|--------------------------|----------------------------|-----------|---------|
| ✅ 均成功 | ✅ 旧 RT 被删 | ✅ 该 grantId 下**所有** RT/AT 被清 | grantId 对应所有令牌归零 | 预期结果：合法用户掉线，攻击者令牌也失效 |
| ❌ A 失败，B 成功 | ❌ 旧 RT 仍在（consumedAt=X，可能已过 3 秒窗） | ✅ 其他所有 RT/AT 被清 | **只剩这一条旧 RT**，其余全没了 | 低风险：旧 RT 本身已 `consumed`，后续请求仍会命中异常吊销分支（再删一次，DELETE 0 rows 无害） |
| ✅ A 成功，❌ B 第 1 批失败 | ✅ 旧 RT 被删 | ❌ 还没开始任何 DELETE（第 1 批 SQL 报错） | grantId 下**所有 RT/AT 原样保留** | ⚠️ **高风险**：整个吊销动作只删了一条旧 RT，攻击者持有的其他轮换 RT 仍可继续使用——异常检测未能生效 |
| ✅ A 成功，❌ B 中间批失败 | ✅ 旧 RT 被删 | 部分批次 DELETE 已提交，后续批次失败 | grantId 下 **部分** RT/AT 被清，部分残留 | ⚠️ **中风险**：攻击者持有的部分令牌可能仍有效 |

### 14.4 单边失败的安全风险等级评估

**最危险场景**：第 3 种（destroy 成功，revoke 第 1 批就失败）。此时重放检测形同虚设——攻击者只要持有另一个由正常轮换产生的有效刷新令牌，就能继续攻击，且不会再触发异常吊销分支（因为另一个 RT 从未被 consume）。

**触发 B 失败的常见原因**：
- PostgreSQL 连接池耗尽/网络闪断 → 第 1 批 query 抛错
- SQL 层面 JSONB 运算符 `?` 的权限问题（极少）
- PostgreSQL statement_timeout 超限时大批量数据正在删除
- `revokeInstanceByGrantId` 的循环**没有 try/catch**（源码见 [oidc-model-instance.ts L184-L205](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/queries/oidc-model-instance.ts#L184-L205)），任何中间 `pool.query` 抛错会直接 reject，已执行的批次无法回滚

### 14.5 为什么不用事务？代价与权衡

添加 BEGIN / COMMIT / ROLLBACK 事务包裹两个并发操作需要：
1. 从连接池中获取**同一个**连接，两条 DELETE 串行执行（不再是 `Promise.all`）
2. 如果 revoke 批次大（数万行），事务长时间持有锁，阻塞其他 grant 的正常插入/查询
3. `revokeInstanceByGrantId` 循环语义需要改成单事务内的多次 DELETE，逻辑复杂性显著提升

目前设计是**有意识的"最佳努力"吊销**：能清多少清多少，失败时至少抛异常阻止本次请求继续。如果要完全解决一致性问题，需要改为：
- **先 revoke（更大操作）后 destroy**，串行执行，虽然慢但保证 revoke 覆盖 destroy；
- 或用 advisory lock 在 grantId 维度做互斥，确保同一时间只有一个吊销在跑。

---

## 十五、代码路径追踪 5：3 秒宽容窗口与分布式多实例时钟漂移的行为边界

### 15.1 3 秒窗口使用的时间源：Node.js 本地 `Date.now()`

3 秒宽容窗口的所有时间计算**全部在应用层（Node.js）用本地时钟完成**，不依赖 PostgreSQL 的 `now()`。

证据链：

**写入 consumedAt 时**（写库时间戳）：
[consumeInstanceById](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/queries/oidc-model-instance.ts#L167-L174) → 用 [convertToTimestamp()](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/utils/sql.ts#L100-L101)：

```typescript
export const convertToTimestamp = (time = new Date()) =>
  sql`to_timestamp(${time.valueOf() / 1000})`;
```

这里 `new Date()` 是**当前 Node 进程的本地时间**，转成 epoch 秒后传入 PostgreSQL 的 `to_timestamp()`。PostgreSQL 只是把传入的秒数转成 timestamp 存储，**不会用数据库自己的 now() 覆盖**。

**判断 consumed 时**（读库后计算窗口）：
[isConsumed()](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/queries/oidc-model-instance.ts#L29-L45)：

```typescript
const isConsumed = (modelName: string, consumedAt: Nullable<number>): boolean => {
  // ...
  return isBefore(addSeconds(consumedAt, refreshTokenReuseInterval), Date.now());
};
```

- `consumedAt` 是从数据库读出的 bigint（millisecond timestamp，见下面 15.2 的转换说明）
- `Date.now()` 是**当前 Node 进程的本地时间**
- 加法和比较全部在 JS 进程内完成

**结论：写入和读取的时间戳都由应用实例本地时钟产生。整个宽容窗口计算完全不依赖数据库时钟。**

### 15.2 consumedAt 的格式转换：Node.js 毫秒 vs PostgreSQL 秒

`oidc_model_instances.consumed_at` 字段类型是 `timestamptz`（PostgreSQL 带时区的时间戳）。读写转换：

```
写入：
  Node.js new Date().valueOf() / 1000  →  epoch 秒  →  to_timestamp()  →  timestamptz

读取：
  SELECT ..., extract(epoch from consumed_at) * 1000  →  bigint 毫秒  →  JS Number
```

转换代码在 [oidc-model-instance.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/queries/oidc-model-instance.ts) 的查询语句中用 `extract` 做。

### 15.3 分布式多实例下四种典型时钟漂移场景

假设同一 Logto 部署的两个实例 A（主 US-East）和 B（主 EU-West）：

| 场景 | 实例 A 本地时钟 | 实例 B 本地时钟 | 相对漂移 | 行为与风险 |
|------|-----------------|-----------------|---------|-----------|
| **A 快 1 秒，B 慢 1 秒**（总漂移 2 秒） | A = 真实 T + 1 | B = 真实 T - 1 | 2s | ✅ **安全**：3 秒窗口 - 2 秒漂移 = 1 秒实际容错。正常并发仍在窗口内。 |
| **A 快 5 秒，B 慢 1 秒**（总漂移 6 秒） | A = T + 5 | B = T - 1 | 6s | ⚠️ **跨实例 3 秒窗口失效**：A 在 t₀ 写入 consumedAt = T+5；B 收到并发请求时本地时钟 = T-1+0.5 = T-0.5；<br>isConsumed 在 B 上判断：<br>`consumedAt(T+5) + 3s = T+8 > Date.now()(T-0.5)` → false，窗口**意外扩大**到 8.5 秒。<br>攻击者有更长时间重放旧令牌不触发吊销。 |
| **A 慢 3 秒，B 快 3 秒**（总漂移 6 秒，反向） | A = T - 3 | B = T + 3 | 6s | ⚠️ **跨实例 3 秒窗口意外收缩**：A 在 t₀ 写入 consumedAt = T-3；B 收到并发请求时本地时钟 = T+3+0.5 = T+3.5；<br>isConsumed 在 B 上判断：<br>`consumedAt(T-3) + 3s = T > Date.now()(T+3.5)` → true（T > T+3.5? 否）<br>实际 `T > T+3.5?` 为 false → consumed = false。<br>但如果延迟再久一点（比如 B 在真实 T+0.5 收到请求，B 时钟 T+3+0.5 = T+3.5，<br> consumedAt = T-3 + 3 = T，判断 T > T+3.5？false，还在窗口）。<br>**反向漂移会让窗口在跨实例调用时缩短甚至归零** → 合法客户端可能遭遇"已被使用"错误，**正常请求异常吊销**。 |
| **极端：实例 NTP 挂了，漂移 5 分钟** | A = T - 300s | B = T + 300s | 10 分钟 | 🚨 **灾难性**：<br>A 消费 RT 后 → B 上 isConsumed 判定：(T-300)+3 = T-297 > Date.now()(T+300)? 否 → 还在窗口内（窗口被拉到了 597 秒）；<br>反之 B 消费后 → A 上判断 (T+300)+3 = T+303 > Date.now()(T-300)? 否 → 仍在窗口（又被拉到 603 秒）。<br>实际效果是宽容窗口被**膨胀到 10 分钟以上**，攻击者可用大量时间重放。 |

### 15.4 行为边界总结与改进建议

**适用的前提条件**：
- 所有 Logto 实例时钟同步 ≤ 1 秒（正确配置 NTP 的 Kubernetes VM 都能满足）
- 总漂移不超过 2 秒

**实际可观测到的问题信号**：
- 错误日志中 `InvalidGrant('refresh token already used')` 异常增多，伴随"刚刚正常刷新过"的用户反馈 → 怀疑时钟漂移导致窗口意外收缩
- 同一 grantId 下 refresh token 轮换次数异常高但从未触发吊销 → 怀疑时钟漂移导致窗口意外扩大

**潜在改进**：
- 将 consumedAt 的写入改为 PostgreSQL `now()` 而非应用时间，读取用 `consumedAt + interval '3 seconds' < now()` 完全在 DB 层计算，彻底消除实例时钟差——但会增加数据库 CPU 开销（每条 SELECT 带区间运算）

---

## 十六、代码路径追踪 6：`isKeyInObject` 判断 `grant.isExpired` 的类型 hack 与升级风险

### 16.1 代码原始位置与注释

[refresh-token.ts L120-L127](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/grants/refresh-token.ts#L120-L127)：

```typescript
/**
 * It's actually available on the `BaseModel` class - but missing from the typings.
 *
 * @see {@link https://github.com/panva/node-oidc-provider/blob/cf2069cbb31a6a855876e95157372d25dde2511c/lib/models/base_model.js#L128 | oidc-provider/lib/models/base_model.js#L128}
 */
if (isKeyInObject(grant, 'isExpired') && grant.isExpired) {
  throw new InvalidGrant('grant is expired');
}
```

### 16.2 `isKeyInObject` 的类型语义

`isKeyInObject` 来自 `@silverhand/essentials` 工具库，是 TypeScript 的**类型守卫（type guard）**模式。语义：

```typescript
function isKeyInObject<T extends object, K extends PropertyKey>(
  obj: T,
  key: K
): obj is T & Record<K, unknown>
```

调用前，`grant` 的类型是 `Grant`，TypeScript 认为上面**没有** `isExpired` 键（因为 oidc-provider 的 TypeScript 声明里没声明 BaseModel 的内部属性）。调用后，如果返回 `true`，TypeScript 就把 `grant` 的类型**收窄**为 `Grant & Record<'isExpired', unknown>`，于是：

```typescript
grant.isExpired  // ✅ 不再报 TS2339 属性不存在错误
```

但这是**纯编译期 hack**，运行时只做 `'isExpired' in grant`（JavaScript in 运算符）检查类型。

### 16.3 oidc-provider 中 BaseModel 的 `isExpired` 实际实现

代码注释明确钉死了实现位置（[oidc-provider base_model.js#L128](https://github.com/panva/node-oidc-provider/blob/cf2069cbb31a6a855876e95157372d25dde2511c/lib/models/base_model.js#L128)）。实际是 **getter（计算属性）** 而非常量：

```javascript
// oidc-provider 内部实现（推断自注释链接 + Logto Grant.find({ ignoreExpiration: true }) 行为）
get isExpired() {
  return this.exp !== undefined && this.exp < Math.floor(Date.now() / 1000);
}
```

因为 Grant.find 时带了 `{ ignoreExpiration: true }`（[refresh-token.ts L112-L114](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/grants/refresh-token.ts#L112-L114)），oidc-provider 会跳过内部的自动过期校验，直接把过期 Grant 也返回。**Logto 必须自己做这个判断**，否则后面的处理会用到过期 Grant。

### 16.4 升级 oidc-provider 后可能失效的三种方式

#### 风险 1：oidc-provider 删除或重命名 `isExpired` getter

**概率：低但不可逆。**

oidc-provider 是遵循 semver 的库，删除 `BaseModel` 内部属性属于 breaking change，会在大版本升级时发生。

- **失效表现**：`'isExpired' in grant` 返回 false → 整个 if 条件短路 → **过期 Grant 不抛错就继续执行**
- **后果**：Grant 已过期但刷新令牌还没过期的边界时间窗内，用户可以继续换取 AT/RT——突破授权时长限制
- **如何防护**：
  - 大版本升级 oidc-provider 前跑单元测试（[refresh-token.test.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/oidc/grants/refresh-token.test.ts) 应覆盖过期场景）
  - 更稳妥做法：**不用 getter**，直接读 `grant.exp`（oidc JWT 标准字段，更稳定），用 `grant.exp < Math.floor(Date.now()/1000)` 手写判断

#### 风险 2：oidc-provider 把 getter 改成 `isExpired()` 方法

**概率：中等。**

如果从 `get isExpired()` 改成 `isExpired()`：
- `'isExpired' in grant` 仍返回 `true`（方法是属性，值为 function）→ 通过了检查
- 但 `grant.isExpired` 变成 function 而非 boolean → `&& grant.isExpired` 永远为 truthy（function ≠ 0/null/false）→ **所有 Grant 都被判为过期**
- **后果**：所有刷新请求一律抛 `InvalidGrant('grant is expired')`——大范围用户掉线

#### 风险 3：oidc-provider 在 `Grant.find({ ignoreExpiration: true })` 内部也做了过滤

**概率：极低，但最危险。**

如果 oidc-provider 后续版本忽略 `ignoreExpiration` 选项或者删除这个参数：
- `Grant.find()` 在 Grant 过期时直接返回 null
- Logto 的下一句 `if (!grant) throw InvalidGrant('grant not found')` 会成功拦截
- **后果可控**：只是错误信息从 'grant is expired' 变成 'grant not found'，行为仍然安全

### 16.5 现有类型 hack 的加固建议

目前写法是双条件 `isKeyInObject(grant, 'isExpired') && grant.isExpired`。可以做以下加固：

| 问题 | 加固方式 |
|------|---------|
| getter 改 method 后 truthy 误判 | 改成 `typeof grant.isExpired === 'boolean' && grant.isExpired` |
| 依赖内部未声明属性 | 直接用 `grant.exp` 字段判断：`grant.exp !== undefined && grant.exp < Math.floor(Date.now() / 1000)` |
| 缺少显式测试 | 在 refresh-token.test.ts 中增加专门断言：模拟 Grant.isExpired getter 被删除/改为函数时，系统仍能正确拦截或至少抛可观测错误 |

### 16.6 同模式的其他隐患位置

全代码库搜索 `isKeyInObject` 后（见 rg 结果），类似的类型 hack 模式在以下位置也有使用，升级相关依赖时需同样关注：

- [middleware/koa-auth/utils.ts L42 + L48](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/middleware/koa-auth/utils.ts)：`configuration.jwks_uri` 和 `jwks.keys`（oidc-provider 配置）
- [env-set/preconditions.ts L33](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/env-set/preconditions.ts)：`row.tablename`（Postgres 行对象）
- [routes/swagger/utils/general.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/7-logto/packages/core/src/routes/swagger/utils/general.ts)：Swagger OpenAPI 文档对象操作

这些位置中，只有 `koa-auth/utils.ts` 是和 oidc-provider 相关的，其余是自有类型，升级风险低。


