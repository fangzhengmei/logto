# Captcha 验证与 Sign-in 节流代码路径分析

## 一、核心概念

### 1.1 Captcha (验证码)
- **作用**：防止自动化脚本暴力破解，在关键操作前要求人机验证
- **支持类型**：Cloudflare Turnstile、Google Recaptcha Enterprise
- **配置位置**：`sign_in_experiences.captchaPolicy`

### 1.2 Sentinel (登录节流/暴力破解防护)
- **作用**：限制同一标识符在单位时间内的失败尝试次数，防止暴力破解
- **默认策略**：1 小时内失败 **100 次** 则锁定 60 分钟（默认阈值较高，可配置）
- **支持操作**：密码、验证码、一次性令牌、MFA 各因素
- **隐私保护**：标识符使用 SHA256 哈希存储，不直接存储手机号/邮箱明文

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

- `verified`: 是否已通过 captcha 验证（前端在创建交互时主动提交 captchaToken）
- `skipped`: 是否跳过（第三方登录场景，验证成功后由后端自动标记）

### 2.3 Captcha 验证入口

**1. 交互创建时可选验证** ([index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/index.ts#L62-L96))

```
PUT /experience
Body: { interactionEvent, captchaToken? }
```

- 调用链：`index.ts L82-L84` → `ExperienceInteraction.verifyCaptcha()` → `CaptchaValidator.verifyCaptcha()`
- 这是**主动验证**入口，captchaToken 由前端根据策略决定是否提交

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
| 创建用户时 | [experience-interaction.ts L303](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L303) | 注册流程 createUser 前检查 |
| 提交交互时 | [experience-interaction.ts L483](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L483) | 登录/注册最终 submit 前检查 |

### 2.6 Captcha 跳过入口（skipCaptcha 调用点）

`skipCaptcha()` 定义于 [experience-interaction.ts L440-L442](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L440-L442)。

**共有 4 个调用点，全部在「验证成功后」触发**：

| 登录方式 | 代码位置 | 触发条件 |
|----------|----------|----------|
| 一次性令牌 | [one-time-token.ts L66](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/one-time-token.ts#L66) | Magic Link 令牌验证成功后 |
| Passkey 登录 | [web-authn-verification.ts L435](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/web-authn-verification.ts#L435) | Sign-in Passkey 认证验证成功后 |
| 社交登录 | [social-verification.ts L153](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/social-verification.ts#L153) | 第三方社交 OAuth 回调验证成功后 |
| 企业 SSO | [enterprise-sso-verification.ts L125](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/enterprise-sso-verification.ts#L125) | 企业 SSO 回调验证成功后 |

> **设计意图**：这 4 种登录方式本身已经由第三方或强认证机制保护（如邮箱点击链接、Passkey 硬件、社交平台 OAuth、企业 IdP），因此不再强制 captcha。

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
| `defaultSentinelPolicy` | [sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/schemas/src/consts/sentinel.ts) | 默认阈值定义 |

### 3.2 Sentinel 策略配置与默认阈值

**类型定义** ([sign-in-experience.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/schemas/src/foundations/jsonb-types/sign-in-experience.ts#L286-L300))

```typescript
type SentinelPolicy = {
  maxAttempts?: number;      // 时间窗口内最大失败尝试次数
  lockoutDuration?: number;  // 锁定时长（分钟）
};
```

**默认值** 定义于 [sentinel.ts L9-L12](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/schemas/src/consts/sentinel.ts#L9-L12)：

```typescript
export const defaultSentinelPolicy = Object.freeze({
  maxAttempts: 100,    // ⚠️ 默认 100 次，不是 5 次
  lockoutDuration: 60, // 锁定 60 分钟
} satisfies SentinelPolicy);
```

> **修正**：默认是 **100 次/小时**，阈值设得较高，因为 captcha 已经前置拦截了自动化攻击。
> 策略加载逻辑见 [basic-sentinel.ts L151-L162](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/sentinel/basic-sentinel.ts#L151-L162)，会合并 sign-in experience 中的自定义配置。

### 3.3 活动类型与计数池

**`SentinelActivityAction` 枚举** 定义于 [sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/schemas/src/foundations/jsonb-types/sentinel.ts#L11-L45)。

**计数池分组** 定义于 [basic-sentinel.ts L30-L45](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/sentinel/basic-sentinel.ts#L30-L45)：

| 分组 | 操作类型 | 计数方式 |
|------|----------|----------|
| **合并池** (pooledActions) | `Password`、`VerificationCode`、`OneTimeToken` | 三者共享同一个失败计数器 |
| **独立池** (isolatedActions) | `MfaTotp`、`WebAuthn`、`MfaBackupCode` | 每个 Action 独立计数，互不影响 |

#### 计数池规则详解

**合并池**：Password + VerificationCode + OneTimeToken 共享失败次数
- 例如：1 小时内密码错 60 次 + 验证码错 40 次 = 累计 100 次 → 触发锁定
- 注意：**MFA 的邮箱/手机验证码也使用 `VerificationCode`**，同样计入合并池

**独立池**：每个 MFA 因素独立计数
- 例如：1 小时内 TOTP 错 100 次只锁定 TOTP，不影响密码或验证码登录
- 例如：WebAuthn MFA 错 100 次，不影响 TOTP

> **设计意图**：合并池用于防止攻击者在「密码-验证码-一次性令牌」之间切换尝试；独立池避免 MFA 误触（如用户输错 TOTP）连带锁定主登录方式。

### 3.4 withSentinel 包装器

**实现** ([sentinel-guard.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/sentinel-guard.ts#L28-L78))

```typescript
export async function withSentinel<T>(
  { ctx, sentinel, action, identifier, payload },
  verificationPromise: Promise<T>
): Promise<T> {
  // 1. 先执行实际验证操作（无论结果如何）
  const [result, error] = await tryExecute(verificationPromise);

  // 2. 报告活动结果（成功/失败都记录）
  const actionResult = error ? SentinelActionResult.Failed : SentinelActionResult.Success;
  const [decision, decisionExpiresAt] = await sentinel.reportActivity({
    targetType: SentinelActivityTargetType.User,
    targetHash: await sha256(identifier.value),  // SHA256 哈希，保护隐私
    action,
    actionResult,
    payload,
  });

  // 3. 如果被阻止，抛出锁定错误（附带相对时间如 "in 5 minutes"）
  if (decision === SentinelDecision.Blocked) {
    throw new RequestError({
      code: 'session.verification_blocked_too_many_attempts',
      relativeTime: '...',
    });
  }

  // 4. 未被阻止则返回结果或抛出原验证错误
  return error ? throw error : result;
}
```

**关键特性**：
- **先验证后计数**：即使验证失败也会先记录活动，再判断是否锁定
- **隐私保护**：标识符使用 SHA256 哈希存储，数据库中不存明文手机号/邮箱
- **锁定提示**：锁定时返回相对时间给前端友好展示

### 3.5 Sentinel 决策逻辑

**`reportActivity()` 主流程** ([basic-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/sentinel/basic-sentinel.ts#L108-L121))

```typescript
async reportActivity(activity: ActivityReport): Promise<SentinelDecisionTuple> {
  const [decision, decisionExpiresAt] = await this.decide(activity);

  // 记录到数据库（sentinel_activities 表）
  await this.insertActivity({
    id: generateStandardId(),
    ...activity,
    decision,
    decisionExpiresAt,
  });

  return [decision, decisionExpiresAt];
}
```

**`decide()` 决策算法** ([basic-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/sentinel/basic-sentinel.ts#L164-L192))：

```
1. isBlocked() → 是否已在锁定期内？是则直接返回 Blocked
2. 统计最近 1 小时内「同一计数池」的失败次数
3. 加载 SentinelPolicy（默认 100 次 / 60 分钟）
4. 判断：历史失败 + 当前是否失败 >= maxAttempts ?
   → 是：Blocked，过期时间 = now + lockoutDuration 分钟
   → 否：Allowed
```

**`isBlocked()` 检查** ([basic-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/sentinel/basic-sentinel.ts#L134-L149))：
- 查询 `sentinel_activities` 表中是否存在未过期的 `Blocked` 记录
- 通过 `getActionArray()` 确定查询范围（合并池查 3 种 action，独立池查 1 种）

### 3.6 Sentinel 应用位置一览表

| 验证类型 | 代码位置 | Sentinel Action | 计数池 |
|----------|----------|-----------------|--------|
| 密码验证 | [password-verification.ts L49-L61](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/password-verification.ts#L49-L61) | `Password` | 合并池 |
| 邮箱/手机验证码（登录/注册） | [verification-code-helpers.ts L203-L215](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/verification-code-helpers.ts#L203-L215) | `VerificationCode` | 合并池 |
| MFA 邮箱/手机验证码 | [verification-code-helpers.ts L203-L215](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/verification-code-helpers.ts#L203-L215) | `VerificationCode` | 合并池 |
| 一次性令牌 (Magic Link) | [one-time-token.ts L51-L63](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/one-time-token.ts#L51-L63) | `OneTimeToken` | 合并池 |
| WebAuthn MFA 验证 | [web-authn-verification.ts L249-L263](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/web-authn-verification.ts#L249-L263) | `WebAuthn` | 独立池 |
| TOTP MFA 验证 | [totp-verification.ts L140-L154](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/totp-verification.ts#L140-L154) | `MfaTotp` | 独立池 |
| 备份码 MFA 验证 | [backup-code-verification.ts L107-L121](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/backup-code-verification.ts#L107-L121) | `MfaBackupCode` | 独立池 |
| 社交登录 | [social-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/social-verification.ts) | ❌ 不受保护 | - |
| 企业 SSO 登录 | [enterprise-sso-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/enterprise-sso-verification.ts) | ❌ 不受保护 | - |
| Passkey 登录 (SignInPasskey) | [web-authn-verification.ts L373-L447](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/web-authn-verification.ts#L373-L447) | ❌ 不受保护 | - |

> **注意 WebAuthn 的双重身份**：
> - `/verification/web-authn/authentication/verify` → MFA 验证场景 → **有** withSentinel → `WebAuthn` action（独立池）
> - `/verification/sign-in-passkey/authentication/verify` → Passkey 登录场景 → **无** withSentinel，但会 `skipCaptcha()`

---

## 四、各登录方式与 Captcha + Sentinel 的完整配合

| 登录方式 | Captcha 策略 | Sentinel 保护 | Sentinel Action | skipCaptcha 触发点 |
|---------|------------|--------------|-----------------|-------------------|
| **密码登录** | 提交前 `guardCaptcha()` 检查 | ✅ | `Password` | 不触发（需正常验证） |
| **邮箱/手机验证码登录** | 发送验证码前 `guardCaptcha()` + submit 时 `guardCaptcha()` | ✅ | `VerificationCode` | 不触发（需正常验证） |
| **一次性令牌 (Magic Link)** | submit 时 `guardCaptcha()` 检查 | ✅ | `OneTimeToken` | 验证成功后 `skipCaptcha()` |
| **社交登录** | submit 时 `guardCaptcha()` 检查 | ❌ 无 | - | 回调验证成功后 `skipCaptcha()` |
| **企业 SSO** | submit 时 `guardCaptcha()` 检查 | ❌ 无 | - | 回调验证成功后 `skipCaptcha()` |
| **Passkey 登录** | submit 时 `guardCaptcha()` 检查 | ❌ 无 | - | Passkey 验证成功后 `skipCaptcha()` |

---

## 五、完整登录流程详解

### 5.1 密码登录流程

```
用户输入用户名密码
        ↓
[POST /experience/verification/password]
        ↓
1. withSentinel() 包裹密码验证
   ├─ 执行 PasswordVerification.verify()
   │   └─ 密码错误 → 抛 invalid_credentials
   ├─ reportActivity(Password, Failed/Success)
   │   └─ 合并池累计失败达 100 次 → 抛 verification_blocked_too_many_attempts
   └─ 验证通过 → 继续
        ↓
2. 检查密码过期策略
        ↓
3. 保存验证记录到交互会话
        ↓
[POST /experience/identification]
        ↓
4. identifyUser() → 关联用户到交互
        ↓
[POST /experience/submit]
        ↓
5. guardCaptcha() → 如 captchaPolicy.enabled 且未 verified/skipped → 422 captcha_required
6. guardMfaVerificationStatus() → MFA 检查（如需）
7. 提交登录成功
```

### 5.2 验证码登录流程

```
用户输入手机号/邮箱
        ↓
[POST /experience/verification/verification-code]
        ↓
1. guardCaptcha() → 未识别用户且策略启用 → 422 captcha_required
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
   │   ├─ 检查过期（默认 600 秒 / 10 分钟）
   │   ├─ 检查单码重试次数（默认 10 次）
   │   └─ 验证码错误 → 抛 code_mismatch
   └─ reportActivity(VerificationCode, Failed/Success)
        ↓
后续同密码登录流程（identifyUser → submit → guardCaptcha → ...）
```

### 5.3 社交登录流程

```
用户点击社交登录按钮
        ↓
[POST /experience/verification/social/:connectorId/authorization-uri]
        ↓
1. 创建 SocialVerification 记录，获取授权 URL
        ↓
用户在第三方平台完成授权
        ↓
[POST /experience/verification/social/:connectorId/verify]
        ↓
2. socialVerificationRecord.verify() → 验证第三方回调数据
   └─ 无 Sentinel 保护（依靠第三方安全机制）
        ↓
3. skipCaptcha() → 标记为跳过（社交登录自身已认证身份）
4. 保存验证记录
        ↓
[POST /experience/identification]
        ↓
5. identifyUser() → 关联或创建用户
        ↓
[POST /experience/submit]
        ↓
6. guardCaptcha() → 因 captcha.skipped = true，直接通过
7. 提交登录成功
```

### 5.4 Passkey 登录流程

```
[POST /experience/verification/sign-in-passkey/authentication] （可选：带 identifier）
        ↓
1. 生成 WebAuthn 认证选项（challenge）
        ↓
用户通过浏览器完成 Passkey 认证
        ↓
[POST /experience/verification/sign-in-passkey/authentication/verify]
        ↓
2. webAuthnVerification.verifyWebAuthnAuthentication()
   └─ 无 Sentinel 保护（Passkey 本身是强认证因子）
        ↓
3. skipCaptcha() → 标记为跳过
4. 保存验证记录
        ↓
后续同社交登录流程
```

### 5.5 数据流转总览

```
交互创建 (PUT /experience)
  ├─ 可选 captchaToken → verifyCaptcha() → captcha.verified = true
  └─ 保存交互状态
        ↓
凭证验证阶段
  ├─ 密码/验证码/一次性令牌 → withSentinel() → 记录失败次数
  ├─ 社交/企业SSO/Passkey → 验证成功后 → skipCaptcha()
        ↓
用户识别 (POST /identification)
        ↓
交互提交 (POST /submit)
  ├─ guardCaptcha() → verified || skipped 才放行
  ├─ guardMfaVerificationStatus() → MFA 验证需再次过 withSentinel（独立池）
  └─ 完成登录
```

---

## 六、关键配置与默认值

### 6.1 CaptchaPolicy ([sign-in-experience.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/schemas/src/foundations/jsonb-types/sign-in-experience.ts#L280-L284))

```typescript
type CaptchaPolicy = {
  enabled?: boolean;  // 是否启用 captcha，默认 undefined（不启用）
};
```

### 6.2 SentinelPolicy ([sign-in-experience.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/schemas/src/foundations/jsonb-types/sign-in-experience.ts#L286-L300))

```typescript
type SentinelPolicy = {
  maxAttempts?: number;      // 默认 100 次/小时
  lockoutDuration?: number;  // 默认 60 分钟
};
```

### 6.3 VerificationCodePolicy ([sign-in-experience.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/schemas/src/foundations/jsonb-types/sign-in-experience.ts#L308-L324))

```typescript
type VerificationCodePolicy = {
  expirationDuration?: number;  // 验证码有效期，默认 600 秒（10分钟）
  maxRetryAttempts?: number;    // 单码最大重试次数，默认 10 次
};
```

默认值定义于 [verification-code.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/schemas/src/consts/verification-code.ts#L9-L12)。

---

## 七、错误码汇总

| 错误码 | 触发场景 | HTTP 状态 |
|--------|----------|-----------|
| `session.captcha_required` | captcha 策略启用但既未 verified 也未 skipped | 422 |
| `session.captcha_failed` | captchaToken 第三方验证未通过 | 422 |
| `session.verification_blocked_too_many_attempts` | Sentinel 失败次数超过阈值被锁定 | 422 |
| `session.invalid_credentials` | 密码错误 | 422 |
| `verification_code.code_mismatch` | 验证码错误 | 422 |
| `verification_code.expired` | 验证码超过有效期 | 422 |
| `verification_code.exceed_max_try` | 单码重试次数超限（默认 10 次） | 422 |

---

## 八、设计要点总结

1. **分层防护**：Captcha（前置人机验证）→ Sentinel（后置失败计数）→ 单验证码重试限制（微观粒度）
2. **默认阈值修正**：Sentinel 默认 `maxAttempts = 100` 次/小时，不是 5 次；阈值较高是因为 captcha 已前置拦截了大部分自动攻击
3. **计数池双轨制**：
   - 合并池（Password + VerificationCode + OneTimeToken）：防止在主登录方式间切换尝试
   - 独立池（MfaTotp / WebAuthn / MfaBackupCode）：MFA 各自独立，避免误触连带锁定
4. **Captcha 跳过白名单**：一次性令牌、社交登录、企业 SSO、Passkey 共 4 种方式在**验证成功后**自动 `skipCaptcha()`——这些方式本身已是强认证
5. **Sentinel 保护范围**：密码、验证码、一次性令牌、MFA 三因素受保护；社交/企业 SSO/Passkey 登录**不受** Sentinel 保护
6. **隐私保护**：Sentinel 目标标识符始终以 SHA256 哈希存入 `sentinel_activities`，不落明文
7. **状态持久化**：Captcha 状态（verified / skipped）随 OIDC interaction 会话存储，同一会话内只需验证一次
8. **灵活配置**：所有阈值（captcha 开关、Sentinel 次数/时长、验证码过期/重试）均通过 SignInExperience 配置可调整
