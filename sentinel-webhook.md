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
| Hook 中间件 | [koa-experience-interaction-hooks.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/middleware/koa-experience-interaction-hooks.ts) | 在请求生命周期中触发 hook |

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

### 3.2 withSentinel 包装器

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
4. **处置决策**：如果被封禁，触发 Webhook 并抛出异常

### 3.3 调用场景

`withSentinel` 在以下验证路由中被调用：

| 验证方式 | 路由文件 |
|----------|----------|
| 密码登录 | [password-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/verification-routes/password-verification.ts#L49-L61) |
| 验证码登录 | （对应验证码路由） |
| Magic Link | （对应一次性令牌路由） |
| TOTP MFA | （对应 TOTP 路由） |
| WebAuthn | （对应 WebAuthn 路由） |
| 备份码 | （对应备份码路由） |

以密码验证为例，在 [password-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/routes/experience/verification-routes/password-verification.ts#L49-L61) 中：

```typescript
const verifiedUser = await withSentinel(
  {
    ctx,
    sentinel,
    action: SentinelActivityAction.Password,
    identifier,
    payload: {
      event: experienceInteraction.interactionEvent,
      verificationId: passwordVerification.id,
    },
  },
  passwordVerification.verify(password)
);
```

### 3.4 reportActivity 入口

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
    ...context,
  });
}
```

事件上下文被暂存在内存数组中，等待中间件的 `finally` 阶段统一触发。

### 5.3 Hook 中间件触发流程

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

### 5.4 triggerExceptionHooks 执行

在 [index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/libraries/hook/index.ts#L204-L216) 中：

```typescript
const triggerExceptionHooks = async (consoleLog, contextManager) => {
  if (contextManager.exceptionHookContextArray.length === 0) return;

  const { exceptionHookContextArray: contextArray, metadata } = contextManager;
  const webhooks = await buildWebhooks({ contextArray, metadata });
  await sendWebhooks(webhooks, consoleLog);
};
```

### 5.5 buildWebhooks 构建

在 [index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/67-logto/packages/core/src/libraries/hook/index.ts#L256-L290) 中：

```typescript
async function buildWebhooks({ contextArray, metadata }) {
  const foundHooks = await findAllHooks();  // 查询数据库中所有启用的 hook

  return contextArray.flatMap(({ event, ...rest }) => {
    // 筛选出注册了对应事件且启用的 hook
    const hooks = foundHooks.filter(
      ({ event: hookEvent, events, enabled }) =>
        enabled && (events.length > 0 ? events.includes(event) : event === hookEvent)
    );

    const payload = {
      event,
      createdAt: new Date().toISOString(),
      ...metadata,     // ip, userAgent, applicationId, sessionId, interactionEvent
      ...rest,         // identifier 详情
    };

    return hooks.map((hook) => ({ hook, payload }));
  });
}
```

### 5.6 sendWebhookRequest 发送 HTTP 请求

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

### 5.7 Identifier.Lockout Webhook Payload 示例

```json
{
  "event": "Identifier.Lockout",
  "createdAt": "2024-06-21T10:00:00.000Z",
  "ip": "192.168.1.100",
  "userAgent": "Mozilla/5.0 ...",
  "interactionEvent": "SignIn",
  "applicationId": "app_xxx",
  "sessionId": "session_xxx",
  "type": "email",
  "value": "user@example.com"
}
```

### 5.8 解除封禁

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

## 六、完整调用链总结

以用户密码错误过多被封禁为例：

```
1. 用户 POST /experience/verification/password
   └─ password-verification.ts 路由接收
      └─ withSentinel({ action: Password, identifier })
         │
2. 执行验证：passwordVerification.verify(password) → 抛出密码错误
   └─ actionResult = Failed
      │
3. sentinel.reportActivity({ targetHash: sha256("user@example.com"), ... })
   └─ BasicSentinel.reportActivity()
      ├─ decide() → 查询 1 小时内失败次数 → 达到阈值 → 返回 Blocked
      └─ insertActivity() → 写入 sentinel_activities 表
         │
4. 决策为 Blocked
   └─ ctx.appendExceptionHookContext('Identifier.Lockout', { type: 'email', value: 'user@example.com' })
   └─ throw RequestError('session.verification_blocked_too_many_attempts')
      │
5. koa-experience-interaction-hooks 中间件 finally 块
   └─ triggerExceptionHooks()
      ├─ findAllHooks() → 筛选注册了 Identifier.Lockout 事件的 webhook
      ├─ buildWebhooks() → 组装 payload
      └─ sendWebhookRequest() → POST { event: "Identifier.Lockout", ... } 到配置的 URL
         │
6. 用户收到 HTTP 400 响应：
   { "code": "session.verification_blocked_too_many_attempts", "relativeTime": "in 60 minutes" }
```
