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

## 二、各入口 Captcha 与 Sentinel 的执行顺序

> **核心结论**：只有「验证码发送」入口**先做人机校验**（guardCaptcha）；密码验证、验证码校验、一次性令牌入口都**先记录失败次数**（withSentinel），Captcha 校验延迟到最终 submit。

### 2.1 密码验证：先 Sentinel，无前置 Captcha

**路由**：`POST /experience/verification/password`
**代码**：[password-verification.ts L36-L73](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/password-verification.ts#L36-L73)

```
请求进入
  ↓
① PasswordVerification.create(identifier)     ← 构建验证记录
  ↓
② withSentinel(Password, passwordVerification.verify(password))
  ├─ 2a. 执行 verify(password)                ← 实际密码校验
  ├─ 2b. reportActivity(Password, Failed/Success) ← 记录失败/成功
  └─ 2c. 如达阈值 → 抛 verification_blocked   ← Sentinel 阻止
  ↓
③ passwordVerification.verifyPasswordExpiration() ← 密码过期检查
  ↓
④ setVerificationRecord + save()              ← 保存到交互会话
```

**关键点**：
- **无前置 guardCaptcha**：密码验证路由中不调用 `guardCaptcha()`，Captcha 检查延迟到 `submit()` 阶段
- **Sentinel 先于 Captcha 生效**：密码错误先被 Sentinel 记录，Captcha 仅在最终提交时守卫
- **设计原因**：密码验证是「凭证提交」，不存在资源消耗（不发短信/邮件），先记录失败更合理

### 2.2 验证码发送：先 Captcha，无 Sentinel

**路由**：`POST /experience/verification/verification-code`
**代码**：[verification-code.ts L47-L84](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/verification-code.ts#L47-L84)

```
请求进入
  ↓
① if (!identifiedUserId) → guardCaptcha()    ← 先做人机校验
  │  └─ captchaPolicy.enabled 且未 verified → 抛 captcha_required
  ↓
② sendCode()                                  ← 发送验证码
  ├─ 2a. guardEmailBlocklist()                ← 注册邮件黑名单检查
  ├─ 2b. sendVerificationCode()               ← 实际发送（消耗资源）
  └─ 2c. setVerificationRecord + save()
```

**关键点**：
- **先 Captcha 后发送**：`guardCaptcha()` 在发送验证码之前执行，防止自动化脚本消耗短信/邮件配额
- **无 Sentinel**：发送验证码不涉及凭证校验，不记录失败次数
- **条件守卫**：仅当 `!identifiedUserId` 时才检查 Captcha，已识别用户（如 MFA 流程中）无需再次验证
- **设计原因**：发送验证码是「资源消耗」操作，必须先拦截机器人，否则验证码可被无限发送

### 2.3 验证码校验：先 Sentinel，无前置 Captcha

**路由**：`POST /experience/verification/verification-code/verify`
**代码**：[verification-code.ts L101-L114](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/verification-code.ts#L101-L114) → [verification-code-helpers.ts L172-L223](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/verification-code-helpers.ts#L172-L223)

```
请求进入
  ↓
① getVerificationRecordByTypeAndId()           ← 取出验证码记录
  ↓
② withSentinel(VerificationCode, codeVerificationRecord.verify(identifier, code))
  ├─ 2a. 执行 verify()                         ← 校验验证码
  │   ├─ 检查过期（默认 600 秒）
  │   ├─ 检查单码重试次数（默认 10 次）
  │   └─ 验证码错误 → code_mismatch
  ├─ 2b. reportActivity(VerificationCode, Failed/Success) ← 记录失败/成功
  └─ 2c. 如达阈值 → 抛 verification_blocked    ← Sentinel 阻止
  ↓
③ experienceInteraction.save()                 ← 保存到交互会话
```

**关键点**：
- **无前置 guardCaptcha**：验证码校验路由中不调用 `guardCaptcha()`
- **Sentinel 记录失败**：验证码输入错误会被 Sentinel 记录到合并池（与密码失败共享计数器）
- **双重保护**：单验证码有重试次数限制（默认 10 次），Sentinel 则跨验证码累计失败

### 2.4 一次性令牌验证：先 Sentinel，成功后 skipCaptcha

**路由**：`POST /experience/verification/one-time-token/verify`
**代码**：[one-time-token.ts L37-L75](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/one-time-token.ts#L37-L75)

```
请求进入
  ↓
① OneTimeTokenVerification.create()            ← 构建验证记录
  ↓
② setVerificationRecord()                      ← 先设置记录（在 withSentinel 之前）
  ↓
③ withSentinel(OneTimeToken, oneTimeTokenVerificationRecord.verify(token))
  ├─ 3a. 执行 verify(token)                    ← 校验令牌
  ├─ 3b. reportActivity(OneTimeToken, Failed/Success) ← 记录失败/成功
  └─ 3c. 如达阈值 → 抛 verification_blocked    ← Sentinel 阻止
  ↓
④ skipCaptcha()                                ← 验证成功后跳过 Captcha
  ↓
⑤ save()                                       ← 保存到交互会话
```

**关键点**：
- **先 Sentinel 后 Captcha**：withSentinel 在 skipCaptcha 之前
- **skipCaptcha 仅在成功路径**：如果 withSentinel 抛出异常（验证失败或被锁定），`skipCaptcha()` 不会执行
- **Sentinel 失败 → Captcha 不跳过**：攻击者即使拿到令牌也需过 Captcha，因为 skipCaptcha 在 withSentinel 之后
- **设计意图**：一次性令牌（Magic Link）通过邮箱点击获取，本身已是人机验证；但令牌验证失败仍需 Sentinel 计数

### 2.5 最终提交：先 Captcha，再 MFA 守卫

**路由**：`POST /experience/submit`
**代码**：[index.ts L169-L194](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/index.ts#L169-L194) → [experience-interaction.ts L474-L653](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L474-L653)

```
请求进入
  ↓
① guardCaptcha()                               ← 最终 Captcha 守卫
  │  ├─ captcha.verified = true → 直接通过
  │  ├─ captcha.skipped = true → 直接通过
  │  └─ captchaPolicy.enabled → 抛 captcha_required
  ↓
② getIdentifiedUser()                          ← 确认已识别用户
  ↓
③ guardMfaVerificationStatus()                 ← MFA 守卫（SignIn 场景）
  ↓
④ profile.validateAvailability()               ← 用户资料校验
  ↓
⑤ 完成登录（interactionResult）
```

**关键点**：
- **Captcha 是最终守门员**：所有登录方式的 Captcha 检查最终在此统一执行
- **verified / skipped 任一即可**：guardCaptcha 只要求 `verified || skipped`，两种方式等价
- **Captcha 在 MFA 之前**：`guardCaptcha()` 在 `guardMfaVerificationStatus()` 之前

---

## 三、执行顺序总览表

| 入口 | Captcha 守卫 | Sentinel 记录 | 执行顺序 | 原因 |
|------|-------------|--------------|----------|------|
| **密码验证** `/verification/password` | ❌ 无 | ✅ 先执行 | **Sentinel → （submit 时 Captcha）** | 密码验证不消耗外部资源，先记录失败即可 |
| **验证码发送** `/verification/verification-code` | ✅ 先执行 | ❌ 无 | **Captcha → 发送** | 发送验证码消耗短信/邮件配额，必须先拦截机器人 |
| **验证码校验** `/verification/verification-code/verify` | ❌ 无 | ✅ 先执行 | **Sentinel → （submit 时 Captcha）** | 凭证校验场景，记录失败比 Captcha 更重要 |
| **一次性令牌** `/verification/one-time-token/verify` | ❌ 无 | ✅ 先执行 | **Sentinel → 成功后 skipCaptcha** | Sentinel 先判断，通过后 Captcha 自动跳过 |
| **社交登录** `/verification/social/:connectorId/verify` | ❌ 无 | ❌ 无 | **验证 → 成功后 skipCaptcha** | 第三方已验证身份，两者都不需要 |
| **企业 SSO** `/verification/sso/:connectorId/verify` | ❌ 无 | ❌ 无 | **验证 → 成功后 skipCaptcha** | 企业 IdP 已验证身份，两者都不需要 |
| **Passkey** `/verification/sign-in-passkey/.../verify` | ❌ 无 | ❌ 无 | **验证 → 成功后 skipCaptcha** | Passkey 是强认证因子，两者都不需要 |
| **最终提交** `/submit` | ✅ 先执行 | ❌ 无 | **Captcha → MFA → 完成** | Captcha 是最终守门员 |

### 执行顺序分类

**A 类：先 Captcha（人机校验优先）**
- 验证码发送：防止机器人消耗资源
- 最终提交：防止未通过人机校验的请求完成登录

**B 类：先 Sentinel（失败计数优先）**
- 密码验证：记录失败次数，延迟 Captcha 到提交
- 验证码校验：记录失败次数，延迟 Captcha 到提交
- 一次性令牌：先记录失败次数，成功后自动跳过 Captcha

**C 类：两者都不需要**
- 社交登录、企业 SSO、Passkey：第三方/强认证已完成验证

---

## 四、Captcha 验证代码路径

### 4.1 核心类与文件

| 类/文件 | 位置 | 职责 |
|--------|------|------|
| `CaptchaValidator` | [captcha-validator.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/captcha-validator.ts) | 调用第三方 API 验证验证码令牌 |
| `ExperienceInteraction` | [experience-interaction.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts) | 管理交互会话中的 captcha 状态 |
| `SignInExperienceValidator` | [sign-in-experience-validator.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/sign-in-experience-validator.ts) | 检查 captcha 策略是否要求验证 |

### 4.2 Captcha 状态管理

在 `ExperienceInteraction` 中维护 captcha 状态（[L74-L77](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L74-L77)）：

```typescript
private readonly captcha = {
  verified: false,
  skipped: false,
};
```

- `verified`: 前端在创建交互时主动提交 captchaToken 并验证通过
- `skipped`: 后端在第三方验证成功后自动标记（skipCaptcha）

### 4.3 Captcha 验证入口

**交互创建时可选验证** ([index.ts L62-L96](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/index.ts#L62-L96))

```
PUT /experience
Body: { interactionEvent, captchaToken? }
```

- 调用链：`index.ts L82-L84` → `ExperienceInteraction.verifyCaptcha()` → `CaptchaValidator.verifyCaptcha()`
- 这是**主动验证**入口，captchaToken 由前端根据策略决定是否提交
- 验证通过后 `captcha.verified = true`

### 4.4 Captcha 校验守卫

**`guardCaptcha()`** ([experience-interaction.ts L655-L661](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L655-L661))

```typescript
async guardCaptcha() {
  if (this.captcha.verified || this.captcha.skipped) {
    return;
  }
  await this.signInExperienceValidator.guardCaptcha();
}
```

**`SignInExperienceValidator.guardCaptcha()`**（[sign-in-experience-validator.ts L352-L360](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/sign-in-experience-validator.ts#L352-L360)）

- 仅当 `captchaPolicy.enabled = true` 且 `!verified && !skipped` 时抛 `captcha_required`

### 4.5 guardCaptcha 调用点

| 调用位置 | 代码路径 | 触发条件 |
|---------|----------|----------|
| 验证码发送前 | [verification-code.ts L50-L52](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/verification-code.ts#L50-L52) | `!identifiedUserId` 时检查 |
| 创建用户时 | [experience-interaction.ts L303](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L303) | 注册流程 createUser 前检查 |
| 提交交互时 | [experience-interaction.ts L483](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L483) | 登录/注册最终 submit 前检查 |

### 4.6 skipCaptcha 调用点

`skipCaptcha()` 定义于 [experience-interaction.ts L440-L442](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L440-L442)。

| 登录方式 | 代码位置 | 触发条件 |
|----------|----------|----------|
| 一次性令牌 | [one-time-token.ts L66](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/one-time-token.ts#L66) | withSentinel 通过后 |
| Passkey 登录 | [web-authn-verification.ts L435](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/web-authn-verification.ts#L435) | Passkey 验证成功后 |
| 社交登录 | [social-verification.ts L153](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/social-verification.ts#L153) | OAuth 回调验证成功后 |
| 企业 SSO | [enterprise-sso-verification.ts L125](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/enterprise-sso-verification.ts#L125) | SSO 回调验证成功后 |

> **关键时序**：skipCaptcha 全部在「验证成功后」触发。一次性令牌场景中，如果 withSentinel 因验证失败或被锁定而抛出异常，skipCaptcha 不会执行——这意味着失败路径仍需在 submit 时过 Captcha。

### 4.7 Captcha 第三方验证实现

**Turnstile** ([captcha-validator.ts L43-L76](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/captcha-validator.ts#L43-L76))
- Cloudflare API，检查 `success` 字段

**Recaptcha Enterprise** ([captcha-validator.ts L78-L133](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/captcha-validator.ts#L78-L133))
- Google API，Checkbox 模式仅验证 token，Invisible 模式还需风险分数 ≥ 0.5

---

## 五、Sign-in 节流 (Sentinel) 代码路径

### 5.1 核心类与文件

| 类/文件 | 位置 | 职责 |
|--------|------|------|
| `BasicSentinel` | [basic-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/sentinel/basic-sentinel.ts) | 核心节流逻辑：记录活动、决策是否阻止 |
| `withSentinel()` | [sentinel-guard.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/sentinel-guard.ts) | 验证操作包装器，自动报告活动结果 |
| `defaultSentinelPolicy` | [sentinel.ts L9-L12](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/schemas/src/consts/sentinel.ts#L9-L12) | 默认阈值定义 |

### 5.2 Sentinel 策略配置与默认阈值

```typescript
type SentinelPolicy = {
  maxAttempts?: number;      // 默认 100 次/小时
  lockoutDuration?: number;  // 默认 60 分钟
};
```

```typescript
export const defaultSentinelPolicy = Object.freeze({
  maxAttempts: 100,
  lockoutDuration: 60,
} satisfies SentinelPolicy);
```

### 5.3 活动类型与计数池

**计数池分组** 定义于 [basic-sentinel.ts L30-L45](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/sentinel/basic-sentinel.ts#L30-L45)：

| 分组 | 操作类型 | 计数方式 |
|------|----------|----------|
| **合并池** (pooledActions) | `Password`、`VerificationCode`、`OneTimeToken` | 三者共享同一个失败计数器 |
| **独立池** (isolatedActions) | `MfaTotp`、`WebAuthn`、`MfaBackupCode` | 每个 Action 独立计数，互不影响 |

- 合并池：1 小时内密码错 60 次 + 验证码错 40 次 = 累计 100 次 → 触发锁定
- 独立池：TOTP 错 100 次只锁定 TOTP，不影响密码登录
- 注意：MFA 的邮箱/手机验证码也使用 `VerificationCode`，同样计入合并池

### 5.4 withSentinel 内部执行顺序

**代码**：[sentinel-guard.ts L28-L78](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/sentinel-guard.ts#L28-L78)

```
withSentinel(action, identifier, verificationPromise)
  ↓
① await verificationPromise                    ← 先执行实际验证
  │  ├─ 成功 → result, error=undefined
  │  └─ 失败 → result=undefined, error=Error（捕获异常，不抛出）
  ↓
② sentinel.reportActivity(action, Failed/Success)
  │  ├─ isBlocked() → 已锁定？直接返回 Blocked
  │  ├─ countFailedInLastHour() → 统计失败次数
  │  ├─ decide() → 历史+当前 >= maxAttempts ? Blocked : Allowed
  │  └─ insertActivity() → 写入 sentinel_activities 表
  ↓
③ decision === Blocked ?
  │  └─ 是 → 抛 verification_blocked_too_many_attempts（附带剩余锁定时间）
  ↓
④ error ?
  │  └─ 是 → 抛原验证错误（如 invalid_credentials、code_mismatch）
  ↓
⑤ return result                                ← 验证成功，返回结果
```

**关键时序特性**：
- **验证先于计数**：无论验证成功还是失败，都先执行验证操作，再报告活动
- **失败不短路**：验证失败时异常被捕获，仍然会报告活动到 Sentinel
- **阻止优先于原错误**：如果 Sentinel 决定阻止，抛出的是 `verification_blocked` 而非原验证错误
- **成功时无感**：验证成功时 reportActivity 记录成功，不抛异常

### 5.5 Sentinel 应用位置一览表

| 验证类型 | 代码位置 | Sentinel Action | 计数池 |
|----------|----------|-----------------|--------|
| 密码验证 | [password-verification.ts L49-L61](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/password-verification.ts#L49-L61) | `Password` | 合并池 |
| 邮箱/手机验证码（登录/注册/MFA） | [verification-code-helpers.ts L203-L215](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/verification-code-helpers.ts#L203-L215) | `VerificationCode` | 合并池 |
| 一次性令牌 (Magic Link) | [one-time-token.ts L51-L63](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/one-time-token.ts#L51-L63) | `OneTimeToken` | 合并池 |
| WebAuthn MFA 验证 | [web-authn-verification.ts L249-L263](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/web-authn-verification.ts#L249-L263) | `WebAuthn` | 独立池 |
| TOTP MFA 验证 | [totp-verification.ts L140-L154](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/totp-verification.ts#L140-L154) | `MfaTotp` | 独立池 |
| 备份码 MFA 验证 | [backup-code-verification.ts L107-L121](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/backup-code-verification.ts#L107-L121) | `MfaBackupCode` | 独立池 |
| 社交登录 | — | ❌ | — |
| 企业 SSO | — | ❌ | — |
| Passkey 登录 | — | ❌ | — |

---

## 六、完整登录流程详解

### 6.1 密码登录流程

```
用户输入用户名密码
        ↓
[PUT /experience] （可选：前端提前提交 captchaToken → captcha.verified = true）
        ↓
[POST /experience/verification/password]
  ├─ ① withSentinel(Password, verify(password))
  │     ├─ 密码错误 → reportActivity(Failed) → 合并池 +1 → 可能触发锁定
  │     └─ 密码正确 → reportActivity(Success) → 继续
  ├─ ② verifyPasswordExpiration()
  └─ ③ save()
        ↓
[POST /experience/identification]
  └─ ④ identifyUser() → 关联用户
        ↓
[POST /experience/submit]
  ├─ ⑤ guardCaptcha() → 如 captchaPolicy.enabled 且 !verified && !skipped → 422
  ├─ ⑥ guardMfaVerificationStatus()
  └─ ⑦ 完成登录
```

**执行顺序**：Sentinel（步骤①）→ Captcha（步骤⑤）

### 6.2 验证码登录流程

```
用户输入手机号/邮箱
        ↓
[PUT /experience] （可选：提前 captchaToken → captcha.verified = true）
        ↓
[POST /experience/verification/verification-code]
  ├─ ① guardCaptcha() → 未识别用户且策略启用 → 422 captcha_required  ← 先 Captcha
  └─ ② sendCode() → 发送验证码
        ↓
用户输入验证码
        ↓
[POST /experience/verification/verification-code/verify]
  ├─ ③ withSentinel(VerificationCode, verify(code))               ← 后 Sentinel
  │     ├─ 验证码错误 → reportActivity(Failed) → 合并池 +1
  │     └─ 验证码正确 → reportActivity(Success) → 继续
  └─ ④ save()
        ↓
[POST /experience/identification]
  └─ ⑤ identifyUser()
        ↓
[POST /experience/submit]
  ├─ ⑥ guardCaptcha() → 已 verified 或 skipped → 通过
  └─ ⑦ 完成登录
```

**执行顺序**：Captcha（步骤①）→ Sentinel（步骤③）→ Captcha 再次确认（步骤⑥）

### 6.3 一次性令牌 (Magic Link) 流程

```
[POST /experience/verification/one-time-token/verify]
  ├─ ① withSentinel(OneTimeToken, verify(token))                  ← 先 Sentinel
  │     ├─ 令牌错误 → reportActivity(Failed) → 合并池 +1 → 抛异常
  │     └─ 令牌正确 → reportActivity(Success) → 继续
  ├─ ② skipCaptcha()                                               ← 成功后跳过 Captcha
  └─ ③ save()
        ↓
[POST /experience/identification]
  └─ ④ identifyUser()
        ↓
[POST /experience/submit]
  ├─ ⑤ guardCaptcha() → captcha.skipped = true → 通过
  └─ ⑥ 完成登录
```

**执行顺序**：Sentinel（步骤①）→ skipCaptcha（步骤②）→ Captcha 确认（步骤⑤自动通过）

### 6.4 社交登录流程

```
[POST /experience/verification/social/:connectorId/verify]
  ├─ ① socialVerificationRecord.verify() → 验证第三方回调
  ├─ ② skipCaptcha() → 验证成功后跳过
  └─ ③ save()
        ↓
[POST /experience/identification]
  └─ ④ identifyUser()
        ↓
[POST /experience/submit]
  ├─ ⑤ guardCaptcha() → captcha.skipped = true → 通过
  └─ ⑥ 完成登录
```

**执行顺序**：无 Sentinel → 验证成功后 skipCaptcha → Captcha 确认自动通过

---

## 七、关键配置与默认值

### 7.1 CaptchaPolicy
```typescript
type CaptchaPolicy = {
  enabled?: boolean;  // 默认 undefined（不启用）
};
```

### 7.2 SentinelPolicy
```typescript
type SentinelPolicy = {
  maxAttempts?: number;      // 默认 100 次/小时
  lockoutDuration?: number;  // 默认 60 分钟
};
```

### 7.3 VerificationCodePolicy
```typescript
type VerificationCodePolicy = {
  expirationDuration?: number;  // 默认 600 秒（10分钟）
  maxRetryAttempts?: number;    // 默认 10 次
};
```

---

## 八、错误码汇总

| 错误码 | 触发场景 | HTTP 状态 |
|--------|----------|-----------|
| `session.captcha_required` | Captcha 启用且未 verified/skipped | 422 |
| `session.captcha_failed` | captchaToken 第三方验证未通过 | 422 |
| `session.verification_blocked_too_many_attempts` | Sentinel 失败次数超阈值 | 422 |
| `session.invalid_credentials` | 密码错误 | 422 |
| `verification_code.code_mismatch` | 验证码错误 | 422 |
| `verification_code.expired` | 验证码超过有效期 | 422 |
| `verification_code.exceed_max_try` | 单码重试次数超限 | 422 |

---

## 九、设计要点总结

1. **执行顺序分两类**：
   - **资源消耗型操作**（验证码发送）→ 先 Captcha 后执行，防止机器人消耗配额
   - **凭证校验型操作**（密码/验证码/令牌校验）→ 先 Sentinel 后 Captcha，失败次数优先记录
2. **Captcha 延迟到 submit**：密码验证和验证码校验不在自身路由检查 Captcha，而是在 `submit()` 统一守卫
3. **skipCaptcha 时序保证**：一次性令牌场景中 skipCaptcha 在 withSentinel 之后，验证失败时不会跳过 Captcha
4. **Sentinel 默认阈值 100 次/小时**：较高阈值与 Captcha 前置拦截互补
5. **计数池双轨制**：合并池（Password+VerificationCode+OneTimeToken）vs 独立池（MFA 各因素）
6. **隐私保护**：Sentinel 目标标识符以 SHA256 哈希存入数据库，不落明文
7. **Captcha 状态持久化**：verified/skipped 随 OIDC interaction 会话存储，同一会话只需验证一次
8. **灵活配置**：所有阈值均可通过 SignInExperience 配置调整
