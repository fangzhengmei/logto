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

各字段来源溯源：

| 字段 | 来源 | 代码位置 |
|------|------|----------|
| `event` | 固定为 `Identifier.Lockout` | appendExceptionHookContext 调用时传入 |
| `createdAt` | `new Date().toISOString()` | buildWebhooks 内部生成 |
| `ip` | `ctx.ip`（Koa 请求 IP） | koa-experience-interaction-hooks metadata |
| `userAgent` | `ctx.header['user-agent']` | koa-experience-interaction-hooks metadata |
| `interactionEvent` | `interactionDetails.result.interactionEvent` | koa-experience-interaction-hooks metadata |
| `applicationId` | `interactionDetails.params.client_id`（OIDC client_id） | koa-experience-interaction-hooks metadata |
| `sessionId` | `interactionDetails.jti`（OIDC 交互 JTI） | koa-experience-interaction-hooks metadata |
| `application` | `findApplicationById(applicationId)` 查询 applications 表 | buildWebhooks |
| `type` | `identifier.type`（email/phone/username/UserId） | appendExceptionHookContext |
| `value` | `identifier.value`（标识符明文值） | appendExceptionHookContext |

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
