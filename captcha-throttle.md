# Captcha 验证与 Sign-in 节流代码路径分析

## 一、核心概念

### 1.1 Captcha (验证码)
- **作用**：防止自动化脚本暴力破解，在关键操作前要求人机验证
- **支持类型**：Cloudflare Turnstile、Google Recaptcha Enterprise
- **配置位置**：`sign_in_experiences.captchaPolicy`

### 1.2 Sentinel (登录节流/暴力破解防护)
- **作用**：限制同一标识符在单位时间内的失败尝试次数，防止暴力破解
- **默认策略**：1小时内失败5次则锁定，锁定时长可配置
- **支持操作**：密码、验证码、一次性令牌、MFA 各因素

---

## 二、Captcha 验证代码路径

### 2.1 核心类与文件

| 类/文件 | 位置 | 职责 |
|--------|------|------|
| `CaptchaValidator` | [captcha-validator.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/captcha-validator.ts) | 调用第三方 API 验证验证码令牌 |
| `ExperienceInteraction` | [experience-interaction.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts) | 管理交互会话中的 captcha 状态 |
| `SignInExperienceValidator` | [sign-in-experience-validator.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/sign-in-experience-validator.ts) | 检查 captcha 策略是否要求验证 |

### 2.2 Captcha 状态管理

在 `ExperienceInteraction` 中维护 captcha 状态：

```typescript
// experience-interaction.ts L73-L77
private readonly captcha = {
  verified: false,
  skipped: false,
};
```

- `verified`: 是否已通过 captcha 验证
- `skipped`: 是否跳过（如社交登录、SSO 登录场景）

### 2.3 Captcha 验证入口

**1. 交互创建时可选验证** ([index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/index.ts#L62-L96))

```
PUT /experience
Body: { interactionEvent, captchaToken? }
```

- 调用链：`index.ts L82-L84` → `ExperienceInteraction.verifyCaptcha()` → `CaptchaValidator.verifyCaptcha()`

**2. `verifyCaptcha()` 实现** ([experience-interaction.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L422-L434))

```typescript
public async verifyCaptcha(token: string) {
  const captchaProvider = await this.tenant.queries.captchaProviders.findCaptchaProvider();
  const captchaValidator = new CaptchaValidator(captchaProvider, log);
  const isVerified = await captchaValidator.verifyCaptcha(token);
  assertThat(isVerified, new RequestError({ code: 'session.captcha_failed', status: 422 }));
  this.captcha.verified = true;
}
```

### 2.4 Captcha 校验守卫

**`guardCaptcha()` 检查点** ([experience-interaction.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L655-L661))

```typescript
async guardCaptcha() {
  if (this.captcha.verified || this.captcha.skipped) {
    return;
  }
  await this.signInExperienceValidator.guardCaptcha();
}
```

**`SignInExperienceValidator.guardCaptcha()`** ([sign-in-experience-validator.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/sign-in-experience-validator.ts#L352-L360))

```typescript
public async guardCaptcha() {
  const { captchaPolicy } = await this.getSignInExperienceData();
  if (!captchaPolicy.enabled) {
    return;
  }
  throw new RequestError({ code: 'session.captcha_required', status: 422 });
}
```

### 2.5 Captcha 守卫调用时机

| 位置 | 代码路径 | 触发时机 |
|------|----------|----------|
| 发送验证码前 | [verification-code.ts L50-L52](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/verification-code.ts#L50-L52) | 未识别用户时发送验证码需先过 captcha |
| 创建用户时 | [experience-interaction.ts L303](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L303) | 注册流程提交前检查 |
| 提交交互时 | [experience-interaction.ts L483](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L483) | 登录/注册最终提交前检查 |

### 2.6 Captcha 跳过场景

`skipCaptcha()` ([experience-interaction.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L440-L442)) 用于以下场景无需 captcha：
- 社交登录
- 企业 SSO 登录

### 2.7 Captcha 第三方验证实现

**Turnstile 验证** ([captcha-validator.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/captcha-validator.ts#L43-L76))
- 调用 Cloudflare API: `https://challenges.cloudflare.com/turnstile/v0/siteverify`
- 检查 `success` 字段

**Recaptcha Enterprise 验证** ([captcha-validator.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/captcha-validator.ts#L78-L133))
- 调用 Google API: `https://recaptchaenterprise.googleapis.com/v1/projects/{projectId}/assessments`
- Checkbox 模式：仅验证 token 有效性
- Invisible 模式：验证 token + 风险分数 >= 0.5

---

## 三、Sign-in 节流 (Sentinel) 代码路径

### 3.1 核心类与文件

| 类/文件 | 位置 | 职责 |
|--------|------|------|
| `BasicSentinel` | [basic-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/sentinel/basic-sentinel.ts) | 核心节流逻辑：记录活动、决策是否阻止 |
| `withSentinel()` | [sentinel-guard.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/sentinel-guard.ts) | 验证操作包装器，自动报告活动结果 |

### 3.2 Sentinel 策略配置

**类型定义** ([sign-in-experience.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/schemas/src/foundations/jsonb-types/sign-in-experience.ts#L286-L300))

```typescript
type SentinelPolicy = {
  maxAttempts?: number;      // 最大失败尝试次数，默认 5
  lockoutDuration?: number;  // 锁定时长（分钟），默认 60
};
```

**默认策略**：1小时内失败 5 次 → 锁定 60 分钟

### 3.3 活动类型与计数池

**`SentinelActivityAction` 类型** ([sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/schemas/src/foundations/jsonb-types/sentinel.ts#L11-L45))

| 操作类型 | 计数池 | 说明 |
|----------|--------|------|
| `Password` | 合并池 | 密码验证失败 |
| `VerificationCode` | 合并池 | 验证码验证失败 |
| `OneTimeToken` | 合并池 | 一次性令牌验证失败 |
| `MfaTotp` | 独立池 | TOTP MFA 验证失败 |
| `WebAuthn` | 独立池 | WebAuthn 验证失败 |
| `MfaBackupCode` | 独立池 | 备份码验证失败 |

**计数池规则** ([basic-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/sentinel/basic-sentinel.ts#L30-L45))：
- **合并池**：Password + VerificationCode + OneTimeToken 共享失败次数计数
  - 例如：密码错 3 次 + 验证码错 2 次 = 触发锁定
- **独立池**：每个 MFA 因素独立计数
  - 例如：TOTP 错 5 次只锁定 TOTP，不影响密码登录

### 3.4 withSentinel 包装器

**实现** ([sentinel-guard.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/sentinel-guard.ts#L28-L78))

```typescript
export async function withSentinel<T>(
  { ctx, sentinel, action, identifier, payload },
  verificationPromise: Promise<T>
): Promise<T> {
  // 1. 执行实际验证操作
  const [result, error] = await tryExecute(verificationPromise);
  
  // 2. 报告活动结果（无论成功失败都记录）
  const actionResult = error ? SentinelActionResult.Failed : SentinelActionResult.Success;
  const [decision, decisionExpiresAt] = await sentinel.reportActivity({
    targetType: SentinelActivityTargetType.User,
    targetHash: await sha256(identifier.value),  // 标识符哈希，保护隐私
    action,
    actionResult,
    payload,
  });
  
  // 3. 如被阻止，抛出锁定错误
  if (decision === SentinelDecision.Blocked) {
    throw new RequestError({
      code: 'session.verification_blocked_too_many_attempts',
      relativeTime: 'X minutes',
    });
  }
  
  // 4. 返回结果或抛出原错误
  return error ? throw error : result;
}
```

**关键特性**：
- 即使验证失败也会先记录活动，再决定是否锁定
- 标识符使用 SHA256 哈希存储，保护用户隐私
- 锁定时返回相对时间（如 "5 minutes"）给前端展示

### 3.5 Sentinel 决策逻辑

**`reportActivity()`** ([basic-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/sentinel/basic-sentinel.ts#L108-L121))

```typescript
async reportActivity(activity: ActivityReport): Promise<SentinelDecisionTuple> {
  const [decision, decisionExpiresAt] = await this.decide(activity);
  
  // 记录活动到数据库
  await this.insertActivity({
    id: generateStandardId(),
    ...activity,
    decision,
    decisionExpiresAt,
  });
  
  return [decision, decisionExpiresAt];
}
```

**`decide()` 决策算法** ([basic-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/sentinel/basic-sentinel.ts#L164-L192))

```typescript
protected async decide(query): Promise<SentinelDecisionTuple> {
  // 1. 检查是否已被阻止
  const blocked = await this.isBlocked(query);
  if (blocked) return blocked;
  
  // 2. 统计最近 1 小时内的失败次数
  const failedAttempts = await countFailedActivitiesInLastHour(query);
  
  // 3. 加载策略配置
  const { maxAttempts, lockoutDuration } = await this.getSentinelPolicy();
  
  // 4. 判断：当前失败 + 历史失败 >= 阈值 ? 阻止 : 允许
  return (failedAttempts + (isFailed ? 1 : 0) >= maxAttempts)
    ? [Blocked, now + lockoutDuration]
    : [Allowed, now];
}
```

**`isBlocked()` 检查** ([basic-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/sentinel/basic-sentinel.ts#L134-L149))
- 查询是否存在未过期的 `Blocked` 决策记录
- 使用 `actionArray` 确定查询范围（合并池 or 独立池）

### 3.6 Sentinel 应用位置

| 验证类型 | 代码位置 | 关联 Action |
|----------|----------|-------------|
| 密码验证 | [password-verification.ts L49-L61](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/password-verification.ts#L49-L61) | `SentinelActivityAction.Password` |
| 验证码验证 | [verification-code-helpers.ts] | `SentinelActivityAction.VerificationCode` |
| 一次性令牌 | [one-time-token.ts] | `SentinelActivityAction.OneTimeToken` |
| TOTP MFA | [totp-verification.ts] | `SentinelActivityAction.MfaTotp` |
| WebAuthn | [web-authn-verification.ts] | `SentinelActivityAction.WebAuthn` |
| 备份码 | [backup-code-verification.ts] | `SentinelActivityAction.MfaBackupCode` |

---

## 四、完整登录流程：Captcha + Sentinel 配合

### 4.1 密码登录流程

```
用户输入用户名密码
        ↓
[POST /experience/verification/password]
        ↓
1. 检查是否已识别用户 → 未识别则 guardCaptcha()
   如 captchaPolicy.enabled 且未验证 → 抛 422 captcha_required
        ↓
2. withSentinel() 包裹密码验证
   ├─ 执行 PasswordVerification.verify()
   │   └─ 密码错误 → 抛 invalid_credentials
   ├─ reportActivity(Password, Failed/Success)
   │   └─ 失败次数达阈值 → 抛 verification_blocked_too_many_attempts
   └─ 验证通过 → 继续
        ↓
3. 检查密码过期策略
        ↓
4. 保存验证记录到交互会话
        ↓
[POST /experience/identification]
        ↓
5. identifyUser() → 关联用户到交互
        ↓
[POST /experience/submit]
        ↓
6. guardCaptcha() → 最终检查
7. guardMfaVerificationStatus() → MFA 检查（如需）
8. 提交登录成功
```

### 4.2 验证码登录流程

```
用户输入手机号/邮箱
        ↓
[POST /experience/verification/verification-code]
        ↓
1. guardCaptcha() → 未识别用户必须先过 captcha
        ↓
2. createPasscode() → 生成验证码
3. sendPasscode() → 发送验证码
        ↓
用户输入验证码
        ↓
[POST /experience/verification/verification-code/verify]
        ↓
4. withSentinel() 包裹验证码验证
   ├─ verifyPasscode()
   │   ├─ 检查过期（默认 10 分钟）
   │   ├─ 检查重试次数（默认 10 次）
   │   └─ 验证码错误 → 抛 code_mismatch
   └─ reportActivity(VerificationCode, Failed/Success)
        ↓
后续同密码登录流程...
```

### 4.3 数据流转图

```
交互创建 (PUT /experience)
  ├─ 可选 captchaToken → verifyCaptcha() → captcha.verified = true
  └─ 保存交互状态
        ↓
验证码发送 (POST /verification/verification-code)
  └─ guardCaptcha() → 未验证且策略启用 → 422 captcha_required
        ↓
验证码提交 (POST /verification/verification-code/verify)
  └─ withSentinel()
      ├─ verifyPasscode() → 成功/失败
      └─ reportActivity() → 记录失败次数 → 超阈值则 Blocked
        ↓
用户识别 (POST /identification)
        ↓
交互提交 (POST /submit)
  ├─ guardCaptcha() → 最终检查
  ├─ guardMfaVerificationStatus()
  └─ 完成登录
```

---

## 五、关键配置与默认值

### 5.1 CaptchaPolicy ([sign-in-experience.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/schemas/src/foundations/jsonb-types/sign-in-experience.ts#L280-L284))

```typescript
type CaptchaPolicy = {
  enabled?: boolean;  // 是否启用 captcha
};
```

### 5.2 SentinelPolicy ([sign-in-experience.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/schemas/src/foundations/jsonb-types/sign-in-experience.ts#L286-L300))

```typescript
type SentinelPolicy = {
  maxAttempts?: number;      // 默认 5 次
  lockoutDuration?: number;  // 默认 60 分钟
};
```

### 5.3 VerificationCodePolicy ([sign-in-experience.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/schemas/src/foundations/jsonb-types/sign-in-experience.ts#L308-L324))

```typescript
type VerificationCodePolicy = {
  expirationDuration?: number;  // 验证码有效期，默认 600 秒（10分钟）
  maxRetryAttempts?: number;    // 最大重试次数，默认 10 次
};
```

---

## 六、错误码汇总

| 错误码 | 触发场景 | HTTP 状态 |
|--------|----------|-----------|
| `session.captcha_required` | captcha 策略启用但未验证 | 422 |
| `session.captcha_failed` | captcha 令牌验证失败 | 422 |
| `session.verification_blocked_too_many_attempts` | 失败次数超过阈值被锁定 | 422 |
| `session.invalid_credentials` | 密码错误 | 422 |
| `verification_code.code_mismatch` | 验证码错误 | 422 |
| `verification_code.expired` | 验证码过期 | 422 |
| `verification_code.exceed_max_try` | 验证码重试次数超限 | 422 |

---

## 七、设计要点总结

1. **分层防护**：Captcha（前置）+ Sentinel（后置）+ 验证码重试限制（单 code）
2. **隐私保护**：Sentinel 使用标识符哈希存储，不直接存储手机号/邮箱
3. **计数池隔离**：MFA 与主登录分离，避免跨阶段锁定
4. **状态持久化**：Captcha 状态随交互会话存储，无需重复验证
5. **灵活配置**：所有阈值均可通过 sign-in experience 配置调整
