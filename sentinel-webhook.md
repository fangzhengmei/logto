# Sentinel Webhook 行为风控完整代码脉络

## 一、系统概述

Sentinel 是 Logto 的行为风控模块，用于防止暴力破解等恶意行为。核心流程分为三个阶段：

```
用户验证请求 → 事件接收(Activity Report) → 风险判断(Risk Decision) → 处置结果(Block/Webhook)
```

整个系统由以下核心模块组成：

| 模块 | 文件 | 职责 |
|------|------|------|
| Sentinel 抽象接口 | [sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/schemas/src/types/sentinel.ts) | 定义风控决策契约 |
| BasicSentinel 实现 | [basic-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/sentinel/basic-sentinel.ts) | 具体风控决策算法 |
| SentinelGuard 包装器 | [sentinel-guard.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/classes/libraries/sentinel-guard.ts) | 将 sentinel 接入验证流程 |
| Hook 上下文管理 | [context-manager.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/libraries/hook/context-manager.ts) | 管理 Webhook 事件上下文 |
| Hook 触发引擎 | [index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/libraries/hook/index.ts) | 发送 Webhook HTTP 请求 |
| Hook 中间件 | [koa-experience-interaction-hooks.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/middleware/koa-experience-interaction-hooks.ts) | 在 Experience 请求生命周期中触发 hook |

---

## 二、核心数据结构

### 2.1 SentinelDecision（决策结果）

数据库枚举类型 `sentinel_decision`，在 [1.9.2-1694854226-init-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/schemas/alterations/1.9.2-1694854226-init-sentinel.ts#L19-L21) 中定义：

```sql
create type sentinel_decision as enum ('Undecided', 'Allowed', 'Blocked', 'Challenge');
```

对应生成的 TypeScript 枚举：

| 值 | 含义 |
|----|------|
| `Undecided` | 未决策 |
| `Allowed` | 放行 |
| `Blocked` | 封禁 |
| `Challenge` | 挑战（如 MFA） |

> 注意：当前 `BasicSentinel` 实际只使用 `Allowed` 和 `Blocked` 两种。

### 2.2 SentinelActionResult（验证结果）

数据库枚举类型 `sentinel_action_result`：

```sql
create type sentinel_action_result as enum ('Success', 'Failed');
```

| 值 | 含义 |
|----|------|
| `Success` | 验证成功（密码正确、验证码正确等） |
| `Failed` | 验证失败（密码错误、验证码错误等） |

### 2.3 SentinelActivityAction（风控行为类型）

在 [sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/schemas/src/foundations/jsonb-types/sentinel.ts#L11-L45) 中定义：

| 类型 | 所属池 | 说明 |
|------|--------|------|
| `Password` | pooled | 密码验证 |
| `VerificationCode` | pooled | 验证码验证（短信/邮箱） |
| `OneTimeToken` | pooled | 一次性令牌（Magic Link） |
| `MfaTotp` | isolated | TOTP 多因素认证 |
| `WebAuthn` | isolated | WebAuthn 认证 |
| `MfaBackupCode` | isolated | 备份码认证 |

- **Pooled Actions**：`Password`、`VerificationCode`、`OneTimeToken` 共享同一个失败计数池，即这三种验证的失败次数会累加。
- **Isolated Actions**：每种 MFA 方式独立计数，避免某一 MFA 失败导致其他 MFA 也被锁。

### 2.4 SentinelPolicy（风控策略配置）

在 [sign-in-experience.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/schemas/src/foundations/jsonb-types/sign-in-experience.ts#L286-L300) 中定义，存储于 `sign_in_experiences` 表的 `sentinel_policy` 列：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `maxAttempts` | 100 | 1 小时内允许的最大失败次数 |
| `lockoutDuration` | 60 | 封禁时长（分钟） |

默认值定义在 [sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/schemas/src/consts/sentinel.ts#L9-L12)。

### 2.5 ActivityReport（活动报告）

在 [sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/schemas/src/types/sentinel.ts#L4-L7) 中定义：

```typescript
type ActivityReport = {
  targetType: SentinelActivityTargetType;  // 'User' | 'App'
  targetHash: string;                       // 标识符的 SHA256 哈希
  action: SentinelActivityAction;           // 验证行为类型
  actionResult: SentinelActionResult;       // 成功/失败
  payload: Record<string, unknown>;         // 附加数据
}
```

> 隐私保护：`targetHash` 使用 SHA256 哈希存储用户标识符（如邮箱、手机号），不直接存储明文。

### 2.6 ExceptionHookEvent（异常 Webhook 事件）

在 [hooks.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/schemas/src/foundations/jsonb-types/hooks.ts#L51) 中定义：

```typescript
type ExceptionHookEvent = 'Identifier.Lockout';
```

当触发封禁时，会产生 `Identifier.Lockout` 事件，通过 Webhook 通知外部系统。

---

## 三、阶段一：事件接收（Activity Report）

### 3.1 Sentinel 实例化

Sentinel 在每个租户上下文中实例化。在 [Tenant.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/tenants/Tenant.ts#L113) 中：

```typescript
public readonly sentinel = new BasicSentinel(envSet.pool, queries)
```

构造函数接收数据库连接池 `pool` 和租户查询对象 `queries`，并挂载到抽象类 [TenantContext](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/tenants/TenantContext.ts#L23)，所有路由均可通过 `TenantContext` 访问。

### 3.2 三套独立的验证 API 入口

Logto 存在**三套独立**的验证 API，它们调用 Sentinel 的方式和 Webhook 能力不同：

| 入口类型 | 路由前缀 | withSentinel 调用方式 | 是否能触发 Identifier.Lockout Webhook |
|----------|----------|----------------------|----------------------------------------|
| **Experience（新版交互）** | `/api/experience/verification/*` | 通过 `withSentinel()` 包装器，调用 `ctx.appendExceptionHookContext()` | ✅ **可以** |
| **Interaction（旧版交互）** | `/api/interaction/*` | 直接调用 `tenant.sentinel.reportActivity()`，硬编码封禁逻辑 | ❌ **不能**（无 hook 上下文） |
| **User Verifications（用户账户中心）** | `/api/verifications/*` | 通过 `withSentinel()` 包装器 | ⚠️ **仅部分可以**（取决于 userRouter 中间件） |

#### 3.2.1 Experience 路由中间件链（推荐，支持完整 Webhook）

在 [index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/index.ts#L52-L60) 中，`experienceRouter` 的中间件顺序：

```typescript
experienceRouter.use(
  koaInteractionDetails(provider),              // 1. 从 OIDC provider 获取 interaction 详情（含 client_id）
  koaExperienceInteractionHooks(libraries),     // 2. 初始化 HookContextManager，绑定 appendExceptionHookContext
  koaExperienceInteraction(tenant),             // 3. 初始化 ExperienceInteraction
  koaExperienceAuditLog()                       // 4. 审计日志
);
```

其中 `koaInteractionDetails` 从 OIDC 会话中读取 `client_id`（即 applicationId），为后续 webhook payload 的应用信息提供来源。

#### 3.2.2 Interaction 路由（已废弃，仅风控无 Webhook）

Interaction 路由在 [identifier-payload-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/interaction/verifications/identifier-payload-verification.ts#L229-L279) 中**不使用 `withSentinel()` 包装器**，而是直接内联了一份 Sentinel 调用逻辑：

```typescript
const verifyIdentifierPayload = async (ctx, tenant, payload, storage) => {
  // ...执行验证...
  const [decision, decisionExpiresAt] = await tenant.sentinel.reportActivity({
    targetType: SentinelActivityTargetType.User,
    targetHash: await sha256(identifier),
    action,
    actionResult,
    payload: { event: interactionStorage.event },
  });

  if (decision === SentinelDecision.Blocked) {
    // ⚠️ 关键区别：这里直接抛错，没有调用 ctx.appendExceptionHookContext()
    // 所以不会触发 Identifier.Lockout Webhook！
    const rtf = new Intl.RelativeTimeFormat([...i18next.languages]);
    throw new RequestError({
      code: 'session.verification_blocked_too_many_attempts',
      relativeTime: rtf.format(...),
    });
  }
};
```

**结论**：旧版 Interaction 入口虽然有 Sentinel 风控，但**不会发送 Webhook 通知**，因为缺少 Hook 上下文。

#### 3.2.3 User Verifications 路由（账户中心验证，支持部分 Webhook）

在 [init.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/init.ts#L124-L130) 中，`userRouter` 挂载了 `koaManagementApiHooks`：

```typescript
const userRouter: UserRouter = new Router();
userRouter.use(koaOidcAuth(tenant));
userRouter.use(koaEmailI18n(tenant.queries));
userRouter.use(koaManagementApiHooks(tenant.libraries.hooks));  // 提供 appendExceptionHookContext
verificationRoutes(userRouter, tenant);
```

- 这里的 `appendExceptionHookContext` 由 [koa-management-api-hooks.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/middleware/koa-management-api-hooks.ts#L22-L64) 中间件提供
- **但**：`koaManagementApiHooks` 的 metadata 中**没有 applicationId、sessionId、interactionEvent**（这些只在 Experience 交互中存在）
- 所以 User Verifications 入口触发的 Lockout Webhook 会缺少应用信息

### 3.3 各验证类型的具体入口（Experience 版本）

以下是 Experience API 下每个验证类型到 Sentinel 的完整入口：

#### 密码验证入口

路由：`POST /api/experience/verification/password`

代码在 [password-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/verification-routes/password-verification.ts#L49-L61)：

```typescript
const verifiedUser = await withSentinel(
  {
    ctx,
    sentinel,
    action: SentinelActivityAction.Password,
    identifier,                      // { type: 'email'|'phone'|'username', value: '...' }
    payload: {
      event: experienceInteraction.interactionEvent,   // 'SignIn' | 'Register' | 'ForgotPassword'
      verificationId: passwordVerification.id,
    },
  },
  passwordVerification.verify(password)
);
```

#### 验证码验证入口

路由：`POST /api/experience/verification/verification-code/verify`

代码在 [verification-code.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/verification-routes/verification-code.ts#L87-L115) 调用 [verification-code-helpers.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/verification-routes/verification-code-helpers.ts#L172-L223) 中的 `verifyCode()`：

```typescript
export const verifyCode = async ({ verificationId, code, identifier, ... }) => {
  await withSentinel(
    {
      ctx,
      sentinel,
      action: SentinelActivityAction.VerificationCode,
      identifier,                  // { type: 'email'|'phone', value: 'xxx@xx.com' }
      payload: {
        event: experienceInteraction.interactionEvent,
        verificationId: codeVerificationRecord.id,
      },
    },
    codeVerificationRecord.verify(identifier, code)
  );
};
```

验证码还支持 MFA 流程入口：`POST /api/experience/verification/mfa-verification-code/verify`，同样使用 `verifyCode()` 辅助函数，`action` 也是 `VerificationCode`（MFA 验证码与普通验证码共享 pooled 计数池）。

#### 一次性令牌（Magic Link）入口

路由：`POST /api/experience/verification/one-time-token/verify`

代码在 [one-time-token.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/verification-routes/one-time-token.ts#L51-L63)：

```typescript
await withSentinel(
  {
    ctx,
    sentinel,
    action: SentinelActivityAction.OneTimeToken,
    identifier,                    // { type: 'email'|'phone', value: '...' }
    payload: {
      event: experienceInteraction.interactionEvent,
      verificationId: oneTimeTokenVerificationRecord.id,
    },
  },
  oneTimeTokenVerificationRecord.verify(token)
);
```

#### TOTP MFA 入口（isolated 池）

路由：`POST /api/experience/verification/totp/verify`

代码在 [totp-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/verification-routes/totp-verification.ts#L140-L154)：

```typescript
await withSentinel(
  {
    ctx,
    sentinel,
    action: SentinelActivityAction.MfaTotp,
    identifier: {
      type: AdditionalIdentifier.UserId,       // 注意：MFA 用 userId 做 targetHash
      value: experienceInteraction.identifiedUserId,
    },
    payload: { verificationId: totpVerificationRecord.id },
  },
  totpVerificationRecord.verifyUserExistingTotp(code)
);
```

#### WebAuthn 认证入口（isolated 池）

路由：`POST /api/experience/verification/web-authn/authentication/verify`

代码在 [web-authn-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/verification-routes/web-authn-verification.ts#L249-L263)：

```typescript
await withSentinel(
  {
    ctx,
    sentinel,
    action: SentinelActivityAction.WebAuthn,
    identifier: {
      type: AdditionalIdentifier.UserId,       // MFA 用 userId
      value: experienceInteraction.identifiedUserId,
    },
    payload: { verificationId: webAuthnVerification.id },
  },
  webAuthnVerification.verifyWebAuthnAuthentication(ctx, payload)
);
```

#### 备份码 MFA 入口（isolated 池）

路由：`POST /api/experience/verification/backup-code/verify`

代码在 [backup-code-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/verification-routes/backup-code-verification.ts#L107-L121)：

```typescript
await withSentinel(
  {
    ctx,
    sentinel,
    action: SentinelActivityAction.MfaBackupCode,
    identifier: {
      type: AdditionalIdentifier.UserId,
      value: experienceInteraction.identifiedUserId,
    },
    payload: { verificationId: backupCodeVerificationRecord.id },
  },
  backupCodeVerificationRecord.verify(code)
);
```

> **重要设计差异**：Pooled 动作（Password/VerificationCode/OneTimeToken）使用**邮箱/手机号/用户名**做 targetHash；Isolated 动作（MfaTotp/WebAuthn/MfaBackupCode）使用**用户 ID**做 targetHash。这意味着 MFA 封禁是针对特定用户的，而登录入口封禁是针对标识符的（可能锁定未注册用户的暴力破解尝试）。

### 3.4 withSentinel 包装器

`withSentinel` 是 Sentinel 接入验证流程的入口。定义在 [sentinel-guard.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/classes/libraries/sentinel-guard.ts#L28-L78)。

函数签名：

```typescript
async function withSentinel<T>(
  {
    ctx,           // Koa 上下文，用于 i18n 和 hook 上下文
    sentinel,      // Sentinel 实例
    action,        // 行为类型（Password/VerificationCode/...）
    identifier,    // 用户标识符 { type, value }
    payload,       // 附加数据
  },
  verificationPromise  // 实际的验证 Promise
): Promise<T>
```

执行流程：

1. **执行验证**：`await verificationPromise`，捕获结果或错误
2. **判定结果**：无错误 = `Success`，有错误 = `Failed`
3. **上报活动**：调用 `sentinel.reportActivity()`
4. **处置决策**：如果被封禁，通过 `ctx.appendExceptionHookContext()` 登记 Webhook 并抛出异常

### 3.5 reportActivity 入口

`BasicSentinel.reportActivity` 方法在 [basic-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/sentinel/basic-sentinel.ts#L108-L121) 中实现：

```typescript
async reportActivity(activity: ActivityReport): Promise<SentinelDecisionTuple> {
  BasicSentinel.assertAction(activity.action);          // 校验 action 是否受支持

  const [decision, decisionExpiresAt] = await this.decide(activity);  // 风险判断

  await this.insertActivity({                            // 写入数据库
    id: generateStandardId(),
    ...activity,
    decision,
    decisionExpiresAt,
  });

  return [decision, decisionExpiresAt];
}
```

无论决策结果如何，活动记录都会被持久化到 `sentinel_activities` 表。

### 3.6 字段边界：风控活动 payload vs 锁定通知 payload

这是最容易混淆的地方：**Sentinel 有两套完全独立的 payload 数据，用途和去向完全不同**。

#### 3.6.1 sentinel_activities.payload（内部风控数据，不发给外部）

存储在数据库表 [sentinel_activities.sql](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/schemas/tables/sentinel_activities.sql#L18) 的 `payload jsonb` 列，类型为 `SentinelActivityPayload = Record<string, unknown>`（[sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/schemas/src/foundations/jsonb-types/sentinel.ts#L48-L51)）。

典型内容（来自 `withSentinel` 调用）：

```typescript
// 仅存数据库，不会出现在 webhook payload 中
payload: {
  event: 'SignIn',              // 交互事件
  verificationId: 'ver_xxx',    // 验证记录 ID
}
```

用途：仅供风控决策和审计追溯使用，**永远不会发送给外部 webhook 接收方**。

#### 3.6.2 Identifier.Lockout 通知 payload（发给外部系统）

在 `buildWebhooks()` 中组装，是真正通过 HTTP POST 发给外部系统的数据。来源分三部分：

| 数据来源 | 包含字段 | 代码位置 |
|----------|----------|----------|
| `HookMetadata`（中间件初始化） | `interactionEvent`, `applicationId`, `sessionId`, `ip`, `userAgent` | [context-manager.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/libraries/hook/context-manager.ts#L23-L26) |
| `HookContext`（业务代码登记） | `type`, `value`（标识符明文） | [context-manager.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/libraries/hook/context-manager.ts#L28-L32) |
| `buildWebhooks` 额外查询 | `application: { id, type, name, description }` | [index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/libraries/hook/index.ts#L265-L270) |
| `buildWebhooks` 通用字段 | `event`, `createdAt` | [index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/libraries/hook/index.ts#L278-L279) |

#### 3.6.3 字段边界对比表

| 字段 | 存在于 sentinel_activities.payload | 存在于 Identifier.Lockout webhook payload | 说明 |
|------|-----------------------------------|--------------------------------------------|------|
| `event` | ✅ 可能有（payload.event） | ✅ 有（根级别 event = 'Identifier.Lockout'） | **注意**：webhook 的 `event` 是 `'Identifier.Lockout'`，不是风控 payload 里的交互事件 |
| `verificationId` | ✅ | ❌ **没有** | 只存数据库，不对外暴露 |
| `interactionEvent` | ❌ | ✅ | 来自 HookMetadata，不是来自风控 payload |
| `applicationId` | ❌ | ✅ | 来自 OIDC 会话 client_id |
| `application` | ❌ | ✅ | buildWebhooks 时额外查询 |
| `sessionId` | ❌ | ✅ | 来自 OIDC 交互 jti |
| `ip` | ❌ | ✅ | 来自请求上下文 |
| `userAgent` | ❌ | ✅ | 来自请求头 |
| `type` / `value` | ❌ | ✅ | 来自 appendExceptionHookContext 时传入的 identifier 明文 |
| `createdAt` | ❌ | ✅ | buildWebhooks 时生成 |
| `targetHash` | ✅（独立列） | ❌ | 仅数据库索引使用 |
| `action` / `actionResult` | ✅（独立列） | ❌ | 仅风控判断使用 |
| `decision` / `decisionExpiresAt` | ✅（独立列） | ❌ | 仅风控判断使用 |

> **关键结论**：`sentinel_activities.payload` 和 `Identifier.Lockout` webhook payload **没有任何重叠字段**，是两套完全独立的数据体系。风控活动的内部细节（如 verificationId）不会泄露给外部系统。

---

## 四、阶段二：风险判断（Risk Decision）

风险判断由 `BasicSentinel.decide()` 方法完成，定义在 [basic-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/sentinel/basic-sentinel.ts#L164-L192)。

### 4.1 判断流程

```
                  收到 Activity
                       │
                       ▼
            ┌─────────────────────┐
            │  是否已被封禁？       │── 是 ──► 返回 Blocked
            └─────────────────────┘
                       │ 否
                       ▼
            ┌─────────────────────┐
            │  统计 1 小时内的      │
            │  未封禁失败次数       │
            └─────────────────────┘
                       │
                       ▼
            ┌─────────────────────────┐
            │  (历史失败次数 + 当前     │
            │   是否失败) >= 阈值?     │── 是 ──► 返回 Blocked
            └─────────────────────────┘
                       │ 否
                       ▼
                返回 Allowed
```

### 4.2 isBlocked（封禁检查）

在 [basic-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/sentinel/basic-sentinel.ts#L134-L149) 中实现：

```typescript
protected async isBlocked(query): Promise<Nullable<SentinelDecisionTuple>> {
  const actionArray = BasicSentinel.getActionArray(query.action);
  const blocked = await this.pool.maybeOne(sql`
    select decision_expires_at from sentinel_activities
    where target_type = ${query.targetType}
      and target_hash = ${query.targetHash}
      and action = any(${actionArray})
      and decision = 'Blocked'
      and decision_expires_at > now()
    limit 1
  `);
  return blocked && [SentinelDecision.Blocked, blocked.decisionExpiresAt];
}
```

关键点：
- 使用 `getActionArray()` 确定行为所属的计数池
- 只检查 `decision_expires_at > now()` 的未过期封禁
- Pooled actions 共享池：`Password`、`VerificationCode`、`OneTimeToken` 任一被封禁，三者都被阻止
- Isolated actions 独立池：`MfaTotp`、`WebAuthn`、`MfaBackupCode` 各自独立

`getActionArray` 的实现在 [basic-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/sentinel/basic-sentinel.ts#L57-L65)：

```typescript
static getActionArray(action: SentinelActivityAction) {
  const isPooledAction = BasicSentinel.pooledActionSet.has(action);
  if (isPooledAction) {
    return BasicSentinel.pooledActionArray;  // [Password, VerificationCode, OneTimeToken]
  }
  // isolated: 每个 action 独立成数组 [MfaTotp] / [WebAuthn] / [MfaBackupCode]
  return BasicSentinel.isolatedActionArrays.get(action) ?? sql.array([action], 'varchar');
}
```

### 4.3 getSentinelPolicy（读取策略）

在 [basic-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/sentinel/basic-sentinel.ts#L151-L162) 中实现：

```typescript
protected async getSentinelPolicy() {
  const { sentinelPolicy } = await this.queries.signInExperiences.findDefaultSignInExperience();
  return {
    ...defaultSentinelPolicy,  // maxAttempts: 100, lockoutDuration: 60
    ...sentinelPolicy,
  };
}
```

从 `sign_in_experiences` 表读取租户自定义策略，与默认值合并。

### 4.4 decide（核心决策算法）

在 [basic-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/sentinel/basic-sentinel.ts#L164-L192) 中实现：

```typescript
protected async decide(query): Promise<SentinelDecisionTuple> {
  const blocked = await this.isBlocked(query);
  if (blocked) return blocked;              // 已封禁直接返回

  const actionArray = BasicSentinel.getActionArray(query.action);
  const failedAttempts = await this.pool.oneFirst<number>(sql`
    select count(*) from sentinel_activities
    where target_type = ${query.targetType}
      and target_hash = ${query.targetHash}
      and action = any(${actionArray})
      and action_result = 'Failed'
      and decision != 'Blocked'            // 排除已封禁的记录
      and created_at > now() - interval '1 hour'
  `);

  const { maxAttempts, lockoutDuration } = await this.getSentinelPolicy();
  const now = new Date();

  return failedAttempts + (query.actionResult === 'Failed' ? 1 : 0) >= maxAttempts
    ? ['Blocked', addMinutes(now, lockoutDuration).valueOf()]
    : ['Allowed', now.valueOf()];
}
```

决策逻辑：
1. 如果已封禁，直接返回封禁状态
2. 统计过去 1 小时内的失败次数（排除已封禁的记录）
3. 如果（历史失败次数 + 当前是否失败）达到阈值，返回 `Blocked`
4. 否则返回 `Allowed`

---

## 五、阶段三：处置结果（Disposal & Webhook）

### 5.1 决策结果的处置

决策返回后，在 [sentinel-guard.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/classes/libraries/sentinel-guard.ts#L62-L77) 中进行处置：

```typescript
if (decision === SentinelDecision.Blocked) {
  ctx.appendExceptionHookContext('Identifier.Lockout', {  // 登记 Webhook 事件
    ...identifier,
  });
  const rtf = new Intl.RelativeTimeFormat([...ctx.i18n.languages]);
  throw new RequestError({
    code: 'session.verification_blocked_too_many_attempts',
    relativeTime: rtf.format(Math.round((decisionExpiresAt - Date.now()) / 1000 / 60), 'minute'),
  });
}

if (error) throw error;   // 验证失败但未封禁，抛出原始验证错误
return result;             // 验证成功，返回结果
```

处置分支：

| 决策 | 验证结果 | 处置 |
|------|----------|------|
| `Blocked` | 任何 | 登记 `Identifier.Lockout` Webhook，抛出 `verification_blocked_too_many_attempts` 错误 |
| `Allowed` | Failed | 抛出原始验证错误（密码错误、验证码错误等） |
| `Allowed` | Success | 正常返回验证结果 |

### 5.2 Hook 上下文登记

`ctx.appendExceptionHookContext` 由 [HookContextManager](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/libraries/hook/context-manager.ts#L114-L120) 提供：

```typescript
appendExceptionHookContext<Event extends ExceptionHookEvent>(event: Event, context: HookContext) {
  this.exceptionHookContextArray.push({
    event,
    ...context,          // identifier 详情（type, value）
  });
}
```

事件上下文被暂存在内存数组中，等待中间件的 `finally` 阶段统一触发。

### 5.3 应用信息与交互元数据的注入链路

锁定通知 payload 中的 `applicationId`、`application`、`sessionId`、`interactionEvent` 等信息，是在 **`koa-experience-interaction-hooks` 中间件初始化阶段**注入的。

在 [koa-experience-interaction-hooks.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/middleware/koa-experience-interaction-hooks.ts#L35-L79) 中：

```typescript
return async (ctx, next) => {
  const {
    interactionDetails,                       // 来自 koaInteractionDetails 中间件
    header: { 'user-agent': userAgent },
    ip,
  } = ctx;

  // 从 interaction 详情中解析交互事件
  const result = interactionEventGuard.safeParse(interactionDetails.result ?? {});
  // ...
  const { interactionEvent } = result.data;

  // 🔑 组装 HookMetadata：这里决定了 webhook payload 的基础元数据
  const interactionApiMetadata = {
    interactionEvent,                                 // SignIn/Register/ForgotPassword
    userAgent,                                        // User-Agent
    applicationId: conditionalString(interactionDetails.params.client_id),  // 🔴 来自 OIDC 会话的 client_id
    sessionId: interactionDetails.jti,                // 🔴 OIDC 交互会话 ID (jti 声明)
  };

  // 创建 HookContextManager，传入 metadata
  const dataHookContext = new HookContextManager({
    ...interactionApiMetadata,
    ip,
  });

  // 绑定到 ctx
  ctx.appendExceptionHookContext =
    dataHookContext.appendExceptionHookContext.bind(dataHookContext);
  // ...
};
```

**链路总结**：

```
用户发起登录请求
    │
    ▼
OIDC Provider 建立交互会话（Grant / Interaction）
    │
    ▼ 包含 client_id, jti
koaInteractionDetails 中间件 → ctx.interactionDetails
    │ params.client_id = applicationId
    │ jti = sessionId
    │ result.interactionEvent = SignIn
    ▼
koaExperienceInteractionHooks 中间件
    │ 提取 metadata：{ applicationId, sessionId, interactionEvent, ip, userAgent }
    │ 实例化 HookContextManager(metadata)
    ▼
路由处理（如密码验证）→ withSentinel()
    │ 验证失败 → 触发 Blocked
    │ 调用 ctx.appendExceptionHookContext('Identifier.Lockout', { type, value })
    │ 数据被 push 到 exceptionHookContextArray
    ▼
中间件 finally 块
    └─ triggerExceptionHooks()
        └─ buildWebhooks() → 将 metadata 和 identifier 合并为 payload
            └─ 额外查询 application 详情（id, type, name, description）
                └─ sendWebhookRequest() → HTTP POST 到配置的 Webhook URL
```

### 5.3.1 交互事件解析失败后的静默封禁路径（noop → 封禁不发通知）

这是一个容易忽略的静默失败路径：当 `interactionEvent` 无法解析时，**封禁仍然发生，但 Lockout Webhook 不会被发送**，且没有任何错误提示。

#### 完整调用链（7 步）

```
步骤 1: 请求进入 koa-experience-interaction-hooks 中间件
  │  代码: [koa-experience-interaction-hooks.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/middleware/koa-experience-interaction-hooks.ts#L42-L51)
  │
  ▼
步骤 2: interactionEventGuard.safeParse(interactionDetails.result ?? {})
  │  Zod schema 校验: { interactionEvent: z.nativeEnum(InteractionEvent) }
  │  失败场景:
  │    - interactionDetails.result 为 null（会话过期）
  │    - result 对象缺少 interactionEvent 字段
  │    - interactionEvent 不是合法枚举值（SignIn/Register/ForgotPassword）
  │
  ▼ 校验失败 result.success = false
步骤 3: 所有 hook 方法被替换为 noop（空函数）
  │  ctx.appendExceptionHookContext = noop   // ← 关键！
  │  ctx.appendDataHookContext = noop
  │  ctx.assignReleaseOnSuccessInteractionHookResult = noop
  │  ctx.assignReleaseAnywayInteractionHookResult = noop
  │  然后 return next() 继续执行后续中间件和路由
  │
  ▼
步骤 4: 路由处理（如密码验证）执行 withSentinel()
  │  代码: [sentinel-guard.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/classes/libraries/sentinel-guard.ts#L28-L78)
  │  用户输入错误密码 → verificationPromise 抛出错误
  │  actionResult = Failed
  │
  ▼
步骤 5: sentinel.reportActivity() → decide() → 达到阈值 → 返回 Blocked
  │  sentinel_activities 表写入 decision='Blocked' 记录
  │  🔴 风控逻辑完全正常执行，封禁是生效的
  │
  ▼ decision === SentinelDecision.Blocked
步骤 6: 调用 ctx.appendExceptionHookContext('Identifier.Lockout', { type, value })
  │  🔴 但此时这个方法是 noop！什么都不做
  │  exceptionHookContextArray 仍然是空数组 []
  │
  ▼
步骤 7: 抛出 RequestError({ code: 'session.verification_blocked_too_many_attempts' })
  │  用户收到 HTTP 400 响应，知道自己被封禁了
  │
  ▼ 中间件 finally 块
步骤 8: if (dataHookContext.exceptionHookContextArray.length > 0)
  │  🔴 数组长度为 0，条件不成立
  │  triggerExceptionHooks() 根本不会被调用
  │
  ▼
最终结果:
  ✅ 封禁生效（sentinel_activities 有 Blocked 记录）
  ✅ 用户收到封禁错误响应
  ❌ **没有任何 Identifier.Lockout Webhook 被发送**
  ❌ 外部系统完全不知道该用户被封禁
```

#### 两种场景代码的精确对比

| 步骤 | interactionEvent 正常 | interactionEvent 缺失（noop） |
|------|----------------------|------------------------------|
| ctx.appendExceptionHookContext 是 | `HookContextManager.appendExceptionHookContext.bind(dataHookContext)` | `noop`（`() => {}`） |
| 调用后 exceptionHookContextArray | `[{ event: 'Identifier.Lockout', type, value }]` | `[]`（无变化） |
| finally 条件判断 | `length > 0` → true | `length > 0` → false |
| triggerExceptionHooks 调用 | ✅ 被调用 | ❌ 不被调用 |
| HTTP 请求发送 | ✅ 发送到 webhook URL | ❌ 完全不发送 |
| 用户封禁体验 | ✅ 正常封禁响应 | ✅ 正常封禁响应（无差异） |

#### noop 函数的来源

`noop` 来自 `@silverhand/essentials` 包，在 [koa-experience-interaction-hooks.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/middleware/koa-experience-interaction-hooks.ts#L2) 导入：

```typescript
import { conditionalString, noop, trySafe } from '@silverhand/essentials';
```

`noop` 的定义就是 `() => {}` — 一个什么都不做的空函数。

> ⚠️ **运维/告警注意**：如果你的外部安全系统依赖 Lockout Webhook 来触发账号冻结或告警，必须额外监控 `sentinel_activities` 表中 `decision = 'Blocked'` 的记录，因为 interaction 会话过期的场景下封禁不会触发 Webhook。

---

### 5.4 Hook 中间件触发流程

Hook 的触发由 [koa-experience-interaction-hooks.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/middleware/koa-experience-interaction-hooks.ts#L81-L117) 中间件控制：

```typescript
try {
  await next();                              // 执行业务逻辑

  // 请求成功后触发 data hooks
  if (dataHookContext.dataHookContextArray.length > 0) {
    void trySafe(triggerDataHooks(...));
  }
} finally {
  // 无论请求成功或失败，finally 中触发 exception hooks
  if (dataHookContext.exceptionHookContextArray.length > 0) {
    void trySafe(triggerExceptionHooks(getConsoleLogFromContext(ctx), dataHookContext));
  }
}
```

关键设计：
- **Data Hooks**：仅在请求成功后触发（`try` 块内）
- **Exception Hooks**：无论请求成功或失败都会触发（`finally` 块内）
- 使用 `void trySafe(...)`：异步非阻塞，hook 失败不影响主流程

### 5.5 triggerExceptionHooks 执行

在 [index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/libraries/hook/index.ts#L204-L216) 中：

```typescript
const triggerExceptionHooks = async (consoleLog, contextManager) => {
  if (contextManager.exceptionHookContextArray.length === 0) return;

  const { exceptionHookContextArray: contextArray, metadata } = contextManager;
  const webhooks = await buildWebhooks({ contextArray, metadata });
  await sendWebhooks(webhooks, consoleLog);
};
```

### 5.6 buildWebhooks 构建（含应用信息合并）

在 [index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/libraries/hook/index.ts#L256-L290) 中：

```typescript
async function buildWebhooks<Event extends HookEvent>({ contextArray, metadata }) {
  const foundHooks = await findAllHooks();  // 🔍 查询数据库中所有启用的 hook

  // 🔑 从 metadata 中取出 applicationId，查询应用详情
  const { applicationId } = metadata;
  const application =
    foundHooks.length > 0 && applicationId
      ? await trySafe(async () => findApplicationById(applicationId))  // 🔍 额外 DB 查询
      : undefined;

  return contextArray.flatMap(({ event, ...rest }) => {
    // 筛选出注册了对应事件且启用的 hook
    const hooks = foundHooks.filter(
      ({ event: hookEvent, events, enabled }) =>
        enabled && (events.length > 0 ? events.includes(event) : event === hookEvent)
    );

    // 🔑 合并 payload：metadata + application + identifier context
    const payload = {
      event,
      createdAt: new Date().toISOString(),
      ...metadata,                    // ip, userAgent, applicationId, sessionId, interactionEvent
      ...conditional(
        application && { application: pick(application, 'id', 'type', 'name', 'description') }
      ),
      ...rest,                        // type, value（来自 appendExceptionHookContext）
    };

    return hooks.map((hook) => ({ hook, payload }));
  });
}
```

应用信息合并的关键点：
1. **applicationId 的来源**：由 `koaExperienceInteractionHooks` 从 `interactionDetails.params.client_id` 提取，写入 metadata
2. **应用详情的查询**：在 `buildWebhooks()` 中，如果 metadata 包含 applicationId 且存在启用的 hook，就调用 `findApplicationById()` 查询 applications 表
3. **合并策略**：使用 spread 运算符按顺序合并，`application` 对象包含 `{ id, type, name, description }` 四个字段
4. **容错设计**：应用查询失败用 `trySafe` 包裹，不影响 webhook 发送（application 字段可能为 undefined）

### 5.6.1 User API clientId 用途边界：只服务验证码邮件，不进入 hook 上下文

**明确的分界设计**：User API（`/api/verifications/*`）的 `ctx.auth.clientId` 只用于**验证码邮件模板**，**完全不会传递给 hook 中间件**，因此 Lockout Webhook 中没有应用信息。

#### 完整证据链

**证据 1：clientId 从 OIDC access token 解析并注入 ctx.auth**

在 [koa-oidc-auth.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/middleware/koa-auth/koa-oidc-auth.ts#L63-L89)：

```typescript
const accessToken = await tenant.provider.AccessToken.find(accessTokenValue);
const { accountId, scopes, clientId, sessionUid } = accessToken;  // ✅ 从 token 解析 clientId

ctx.auth = {
  type: 'user',
  id: accountId,
  scopes,
  clientId,          // ✅ 存入 ctx.auth.clientId
  identityVerified,
  sessionUid,
};
```

`Auth` 类型定义在 [types.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/middleware/koa-auth/types.ts#L3-L16)：

```typescript
type Auth = {
  type: 'user' | 'app';
  id: string;
  scopes: Set<string>;
  identityVerified?: boolean;
  clientId?: string;           // OIDC access token 的 Client ID
  sessionUid?: string;         // OIDC 会话 uid
};
```

**证据 2：clientId 仅在发送验证码邮件时被读取**

在 User API 的 `/verifications/verification-code` 路由中（[index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/verification/index.ts#L95-L119)）：

```typescript
async (ctx, next) => {
  // 🔑 唯一一处读取 ctx.auth.clientId 的地方！
  const { id: userId, clientId: applicationId } = ctx.auth;
  const { identifier, templateType: inputTemplateType } = ctx.guard.body;

  // ... 构建 codeVerification ...

  // 仅用于邮件模板上下文
  const emailContextPayload =
    identifier.type === SignInIdentifier.Email
      ? await libraries.passcodes.buildVerificationCodeContext({ user, applicationId }, ctx)
      //                                                        ^^^^^^^^^^^
      //                                                        只传给邮件模板！
      : undefined;

  await codeVerification.sendVerificationCode({
    ...ctx.emailI18n,
    ...emailContextPayload,
  });
  // ...
}
```

`buildVerificationCodeContext` 中用 `applicationId` 查询**应用名称和品牌信息**（[passcode.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/libraries/passcode.ts#L176-L220)）：

```typescript
const buildVerificationCodeContext = async ({ applicationId, ... }) => {
  const [application, applicationSignInExperience, ...] = await Promise.all([
    applicationId
      ? isBuiltInApplicationId(applicationId)
        ? Promise.resolve(buildBuiltInApplicationDataForTenant('', applicationId))
        : queries.applications.findApplicationById(applicationId)  // 🔴 查询应用详情
      : undefined,
    // ...
  ]);

  return {
    ...conditional(application && {
      application: buildApplicationContextInfo(application, applicationSignInExperience),
      // 用于邮件模板显示 "您正在登录 XXX 应用"
    }),
    // ...
  };
};
```

**证据 3：koaManagementApiHooks 中间件完全不读取 ctx.auth.clientId**

在 [koa-management-api-hooks.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/middleware/koa-management-api-hooks.ts#L25-L31) 中，创建 HookContextManager 时只传了两个字段：

```typescript
const {
  header: { 'user-agent': userAgent },
  ip,
} = ctx;

// ⚠️ 没有读取 ctx.auth.clientId！
// ⚠️ 也没有读取 ctx.auth.sessionUid！
// ⚠️ 也没有读取 interactionEvent！
const hooksContextManager = new HookContextManager({ userAgent, ip });
```

对比 Experience API 的 `koaExperienceInteractionHooks`：

```typescript
const interactionApiMetadata = {
  interactionEvent,                              // ✅
  userAgent,
  applicationId: conditionalString(interactionDetails.params.client_id),  // ✅
  sessionId: interactionDetails.jti,             // ✅
};
const dataHookContext = new HookContextManager({
  ...interactionApiMetadata,
  ip,                                            // ✅
});
```

#### 设计分界对照表

| clientId 的用途 | Experience API | User API / Management API |
|-----------------|----------------|---------------------------|
| 注入 hook metadata（→ 进入 webhook payload） | ✅ `interactionDetails.params.client_id` | ❌ 不注入 |
| 验证码邮件模板显示应用名称 | ✅ | ✅ `ctx.auth.clientId` |
| 验证码短信模板显示应用名称 | ✅ | ✅ `ctx.auth.clientId` |
| 触发 Webhook 时带 application 对象 | ✅ | ❌ |

#### 两个中间件的 metadata 字段对比

| HookMetadata 字段 | Experience API（koaExperienceInteractionHooks） | User/Management API（koaManagementApiHooks） |
|-------------------|--------------------------------------------------|----------------------------------------------|
| `ip` | ✅ | ✅ |
| `userAgent` | ✅ | ✅ |
| `interactionEvent` | ✅ `SignIn` / `Register` / `ForgotPassword` | ❌ 无（管理 API 无交互事件概念） |
| `applicationId` | ✅ 来自 `interactionDetails.params.client_id` | ❌ 无（`ctx.auth.clientId` 存在但不传递） |
| `sessionId` | ✅ 来自 `interactionDetails.jti` | ❌ 无（`ctx.auth.sessionUid` 存在但不传递） |

#### User API 实际代码执行时序

```
请求: POST /api/verifications/verification-code
中间件链:
  1. koaOidcAuth
     ├─ 解析 access token → ctx.auth = { id, scopes, clientId, sessionUid }
     │                                      ^^^^^^^^  ^^^^^^^^^^
     │                                      ✅ 存在    ✅ 存在
     └─ 但后续中间件完全忽略这两个字段
  │
  2. koaEmailI18n
  │
  3. koaManagementApiHooks
     └─ const hooksContextManager = new HookContextManager({ userAgent, ip })
        └─ metadata = { userAgent, ip }
           └─ ❌ 没有 clientId
           └─ ❌ 没有 sessionUid
           └─ ❌ 没有 interactionEvent
  │
  路由处理:
    ├─ const { id: userId, clientId: applicationId } = ctx.auth
    │   🔑 这里是唯一用到 clientId 的地方 → 传给 buildVerificationCodeContext()
    │   用于邮件模板显示应用名称
    │
    └─ 发送验证码 → 后续用户验证验证码时走 withSentinel()
       └─ 触发封禁时调用 ctx.appendExceptionHookContext()
          └─ 存入 exceptionHookContextArray
          └─ 但 metadata 中没有 applicationId
  │
  中间件 finally:
    triggerExceptionHooks()
      └─ buildWebhooks()
         └─ metadata.applicationId = undefined
            └─ 不会查询 applications 表
            └─ payload 中没有 applicationId 和 application
```

> **设计意图解读**：Management API 的设计初衷是面向"管理后台"和"服务端集成"场景，这些场景不对应特定的用户交互事件和应用上下文。但 User API（用户自助账户中心）实际上是用户通过前端应用调用的，理论上应该携带应用信息。当前的实现把 User API 和 Management API 共用了同一个 hook 中间件，这是一个**边界设计上的简化**。

---

### 5.7 sendWebhookRequest 发送 HTTP 请求

在 [utils.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/libraries/hook/utils.ts#L32-L49) 中：

```typescript
export const sendWebhookRequest = async ({ hookConfig, payload, signingKey }) => {
  const { url, headers, retries } = hookConfig;

  return ky.post(url, {
    headers: {
      'user-agent': 'Logto (https://logto.io/)',
      ...headers,
      ...conditional(signingKey && {
        'logto-signature-sha-256': sign(signingKey, payload)  // HMAC-SHA256 签名
      }),
    },
    json: payload,
    retry: { limit: retries ?? 3 },     // 默认重试 3 次
    timeout: 10_000,                     // 10 秒超时
  });
};
```

Webhook 请求特征：
- 方法固定为 `POST`
- User-Agent 为 `Logto (https://logto.io/)`
- 签名头 `logto-signature-sha-256`：使用 `signingKey` 对 payload 做 HMAC-SHA256
- 失败重试最多 3 次
- 10 秒超时

### 5.8 Identifier.Lockout Webhook Payload 完整示例

以下是 Experience 版本密码验证入口触发锁定通知的完整 payload 结构：

```json
{
  "event": "Identifier.Lockout",
  "createdAt": "2026-06-21T10:00:00.000Z",
  "ip": "192.168.1.100",
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "interactionEvent": "SignIn",
  "applicationId": "app_abc123def456",
  "sessionId": "jti_session_789xyz",
  "application": {
    "id": "app_abc123def456",
    "type": "SPA",
    "name": "我的前端应用",
    "description": "用户门户 SPA"
  },
  "type": "email",
  "value": "user@example.com"
}
```

各字段来源溯源与边界说明：

| 字段 | 来源 | 代码位置 | 是否来自 sentinel_activities.payload | Experience API | User API | interactionEvent 缺失 |
|------|------|----------|-----------------------------------|----------------|----------|----------------------|
| `event` | 固定为 `Identifier.Lockout` | appendExceptionHookContext 调用时传入 | ❌ 否 | ✅ `'Identifier.Lockout'` | ✅ `'Identifier.Lockout'` | ❌ **无**（noop） |
| `createdAt` | `new Date().toISOString()` | buildWebhooks 内部生成 | ❌ 否 | ✅ 有 | ✅ 有 | ❌ 无 |
| `ip` | `ctx.ip`（Koa 请求 IP） | HookMetadata | ❌ 否 | ✅ 有 | ✅ 有 | ❌ 无 |
| `userAgent` | `ctx.header['user-agent']` | HookMetadata | ❌ 否 | ✅ 有 | ✅ 有 | ❌ 无 |
| `interactionEvent` | `interactionDetails.result.interactionEvent` | HookMetadata | ❌ **否** | ✅ `SignIn/Register/ForgotPassword` | ❌ 无 | ❌ 无 |
| `applicationId` | `interactionDetails.params.client_id`（OIDC client_id） | HookMetadata | ❌ 否 | ✅ 有 | ❌ **无**（ctx.auth.clientId 存在但未使用） | ❌ 无 |
| `sessionId` | `interactionDetails.jti`（OIDC 交互 JTI） | HookMetadata | ❌ 否 | ✅ 有 | ❌ 无 | ❌ 无 |
| `application` | `findApplicationById(applicationId)` 查询 applications 表 | buildWebhooks | ❌ 否 | ✅ `{id,type,name,description}` | ❌ 无（无 applicationId 所以不查） | ❌ 无 |
| `type` | `identifier.type`（email/phone/username/UserId） | appendExceptionHookContext | ❌ 否 | ✅ 有 | ✅ 有（通常为 `UserId`） | ❌ 无 |
| `value` | `identifier.value`（标识符明文值） | appendExceptionHookContext | ❌ 否 | ✅ 有 | ✅ 有（用户 ID） | ❌ 无 |
| `verificationId` | 验证记录 ID | sentinel_activities.payload | ✅ 是（存数据库） | ❌ 不对外暴露 | ❌ 不对外暴露 | — |
| `targetHash` | SHA256(标识符) | sentinel_activities 独立列 | ✅ 是（数据库索引用） | ❌ 不对外暴露 | ❌ 不对外暴露 | — |
| `action` / `actionResult` | 行为类型/验证结果 | sentinel_activities 独立列 | ✅ 是（风控用） | ❌ 不对外暴露 | ❌ 不对外暴露 | — |

#### 三种典型场景的 Lockout Webhook 对比

| 场景 | payload 完整性 | 缺失字段 |
|------|---------------|----------|
| ✅ Experience 密码验证（推荐） | 完整 10 字段 | — |
| ⚠️ User API 修改密码 | 仅 6 字段 | 无 `interactionEvent`, `applicationId`, `sessionId`, `application` |
| ❌ interactionEvent 解析失败（noop） | **无 webhook 发送** | 完全不触发 |

### 5.9 解除封禁

管理员可通过 Management API 手动解除封禁。路由在 [sentinel-activities.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/sentinel-activities.ts#L17-L40)：

```
POST /api/sentinel-activities/delete
Body: { targetType: 'User', targets: ['user@example.com', ...] }
```

处理逻辑：
1. 对每个 `target` 做 SHA256 哈希
2. 删除该目标过去 1 小时内的所有 `sentinel_activities` 记录
3. 返回 `204 No Content`

数据库查询在 [sentinel-activities.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/queries/sentinel-activities.ts#L17-L27)：

```typescript
const deleteActivities = async (targetType, targetHashes) => {
  return pool.query(sql`
    delete from sentinel_activities
    where target_type = ${targetType}
      and target_hash = any(${sql.array(targetHashes, 'varchar')})
      and created_at > now() - interval '1 hour'
  `);
};
```

> 只删除过去 1 小时的记录：因为封禁判断仅依赖 1 小时内的数据，更早的记录不影响当前状态。

---

## 六、入口与封禁通知关系对照表

| 入口组 | API 路径 | Sentinel Action | targetHash 来源 | 能否触发 Lockout Webhook | 应用信息是否完整 |
|--------|----------|----------------|----------------|--------------------------|------------------|
| **密码**（Experience） | `/api/experience/verification/password` | `Password` | 邮箱/手机号/用户名的 SHA256 | ✅ 是 | ✅ application + sessionId + interactionEvent |
| **验证码**（Experience） | `/api/experience/verification/verification-code/verify` | `VerificationCode` | 邮箱/手机号的 SHA256 | ✅ 是 | ✅ 同上 |
| **MFA 验证码**（Experience） | `/api/experience/verification/mfa-verification-code/verify` | `VerificationCode` | 邮箱/手机号的 SHA256 | ✅ 是 | ✅ 同上 |
| **一次性令牌**（Experience） | `/api/experience/verification/one-time-token/verify` | `OneTimeToken` | 邮箱/手机号的 SHA256 | ✅ 是 | ✅ 同上 |
| **TOTP MFA**（Experience） | `/api/experience/verification/totp/verify` | `MfaTotp` | 用户 ID 的 SHA256 | ✅ 是 | ✅ 同上 |
| **WebAuthn**（Experience） | `/api/experience/verification/web-authn/authentication/verify` | `WebAuthn` | 用户 ID 的 SHA256 | ✅ 是 | ✅ 同上 |
| **备份码**（Experience） | `/api/experience/verification/backup-code/verify` | `MfaBackupCode` | 用户 ID 的 SHA256 | ✅ 是 | ✅ 同上 |
| **密码**（Interaction 旧版） | `/api/interaction/*` | `Password` | 邮箱/用户名的 SHA256 | ❌ **否**（直接抛错） | — |
| **验证码**（Interaction 旧版） | `/api/interaction/*` | `VerificationCode` | 邮箱/手机号的 SHA256 | ❌ **否**（直接抛错） | — |
| **密码**（User API） | `/api/verifications/password` | `Password` | 用户 ID 的 SHA256 | ⚠️ 可以但无应用信息 | ❌ 仅有 ip/userAgent |
| **验证码**（User API） | `/api/verifications/verification-code/verify` | `VerificationCode` | 邮箱/手机号的 SHA256 | ⚠️ 可以但无应用信息 | ❌ 仅有 ip/userAgent |

---

## 七、完整调用链总结（以 Experience 密码验证触发封禁为例）

```
0. 前置：用户已访问登录页
   └─ OIDC Provider 已创建 interaction 会话
      └─ interactionDetails.params.client_id = applicationId
      └─ interactionDetails.jti = sessionId
      └─ interactionDetails.result.interactionEvent = SignIn

1. 用户 POST /api/experience/verification/password
   │  中间件链：
   │  ├─ koaInteractionDetails → 填充 ctx.interactionDetails（含 client_id, jti）
   │  ├─ koaExperienceInteractionHooks
   │  │   ├─ 提取 metadata：{ interactionEvent, applicationId, sessionId, ip, userAgent }
   │  │   ├─ 创建 HookContextManager(metadata)
   │  │   └─ 绑定 ctx.appendExceptionHookContext
   │  ├─ koaExperienceInteraction → 初始化 experienceInteraction
   │  └─ koaExperienceAuditLog
   │
   └─ password-verification.ts 路由处理
      └─ withSentinel({ action: Password, identifier: {type:email, value:..} })
         │
2. 执行验证：passwordVerification.verify(password) → 抛出密码错误
   └─ actionResult = Failed
      │
3. sentinel.reportActivity({ targetHash: sha256("user@example.com"), ... })
   └─ BasicSentinel.reportActivity()
      ├─ decide()
      │   ├─ isBlocked() → 否
      │   ├─ 查询 1 小时内 Failed 次数：99
      │   ├─ 99 + 1 >= 100 (maxAttempts) → 是
      │   └─ 返回 [Blocked, now + 60min]
      └─ insertActivity() → 写入 sentinel_activities 表（decision=Blocked）
         │
4. 决策为 Blocked（sentinel-guard.ts L62-L71）
   ├─ ctx.appendExceptionHookContext('Identifier.Lockout', { type:'email', value:'user@example.com' })
   │   └─ HookContextManager.exceptionHookContextArray.push({ event, type, value })
   └─ throw RequestError({ code: 'session.verification_blocked_too_many_attempts', relativeTime: 'in 60 minutes' })
      │
5. koa-experience-interaction-hooks 中间件 finally 块（L113-L116）
   └─ triggerExceptionHooks(consoleLog, HookContextManager)
      │
      └─ [index.ts] buildWebhooks({ contextArray, metadata })
         │
         ├─ findAllHooks() → 查询 hooks 表，筛选 enabled 且 events 含 Identifier.Lockout 的记录
         │
         ├─ metadata.applicationId 存在 → findApplicationById()
         │   └─ 查出 application = { id, type: 'SPA', name: '我的应用', description: '...' }
         │
         ├─ 组装 payload：
         │   {
         │     event: 'Identifier.Lockout',
         │     createdAt: '2026-06-21T10:00:00.000Z',
         │     ...metadata,                // interactionEvent, applicationId, sessionId, ip, userAgent
         │     application: { id, type, name, description },
         │     type: 'email',
         │     value: 'user@example.com'
         │   }
         │
         └─ 对每个启用的 hook：[{ hook, payload }, ...]
            │
            └─ sendWebhooks()（并发控制 10）
               │
               └─ sendWebhookRequest()
                  ├─ URL: hook.config.url
                  ├─ 方法: POST
                  ├─ Headers: { 'logto-signature-sha-256': sign(signingKey, payload), ... }
                  ├─ Body: JSON payload
                  ├─ 重试：最多 3 次
                  └─ 超时：10 秒
                     │
6. 用户收到 HTTP 400 响应：
   { "code": "session.verification_blocked_too_many_attempts", "relativeTime": "in 60 minutes" }
```
