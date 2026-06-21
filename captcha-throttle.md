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

### 1.3 Passcode (短信/邮件验证码)
- **作用**：一次性随机码，通过短信或邮件发送给用户完成身份验证
- **存储表**：`passcodes`（包含 `interactionJti`、`type`、`code`、`email`/`phone`、`consumed`、`tryCount`、`createdAt`）
- **与 Captcha/Sentinel 的关系**：发送前受 Captcha 守卫，校验时受 Sentinel + 单码 tryCount 双重保护

---

## 二、Passcode 控制层详解

### 2.1 旧码失效（创建新码时物理删除旧码）

**代码**：[passcode.ts L65-L88](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/libraries/passcode.ts#L65-L88)

```typescript
const createPasscode = async (jti, type, payload) => {
  // 1. 查找未消费的旧码
  const passcodes = jti
    ? await findUnconsumedPasscodesByJtiAndType(jti, type)       // 会话级：按 jti + type
    : await findUnconsumedPasscodesByIdentifierAndType({ type, ...payload }); // 全局级：按 identifier + type

  // 2. 物理删除旧码（不是置 consumed，是 DELETE）
  if (passcodes.length > 0) {
    await deletePasscodesByIds(passcodes.map(({ id }) => id));
  }

  // 3. 插入新码
  return insertPasscode({
    id: nanoid(),
    interactionJti: jti,
    type,
    code: randomCode(),  // 6 位纯数字
    ...payload,
  });
};
```

**关键点**：
- **失效方式**：物理删除（`DELETE`），不是置 `consumed = true`
- **两种查找维度**：
  - 会话级（有 `jti`）：按 `interaction_jti + template_type` 查，覆盖 SignIn/Register/MFA 等场景
  - 全局级（无 `jti`）：按 `email/phone + template_type` 查，覆盖管理 API 触发的场景
- **防重复**：每次发送新码都会删除同一会话/同一标识的未消费旧码，确保永远只有一条有效验证码
- **数据库查询**：[queries/passcode.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/queries/passcode.ts) 中 `findUnconsumedPasscodesByJtiAndType` 通过 `consumed = false` 过滤

### 2.2 单码过期（时间窗口）

**代码**：[passcode.ts L147-L157](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/libraries/passcode.ts#L147-L157)

```typescript
const { verificationCodePolicy } = await queries.signInExperiences.findDefaultSignInExperience();
const expirationMs =
  (verificationCodePolicy.expirationDuration ?? defaultVerificationCodePolicy.expirationDuration) * 1000;
// 默认 600 秒 = 10 分钟

if (passcode.createdAt + expirationMs < Date.now()) {
  throw new RequestError('verification_code.expired');
}
```

**关键点**：
- 过期阈值来自 `sign_in_experiences.verificationCodePolicy.expirationDuration`，默认 600 秒
- **过期后**：passcode 记录仍在数据库中，但校验时抛 `verification_code.expired`
- 过期的 passcode 不会被自动清理，而是在下次创建新码时被 `createPasscode` 的删除逻辑清理

### 2.3 单码重试次数（tryCount）

**代码**：[passcode.ts L159-L168](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/libraries/passcode.ts#L159-L168)

```typescript
const maxTryCount =
  verificationCodePolicy.maxRetryAttempts ?? defaultVerificationCodePolicy.maxRetryAttempts;
// 默认 10 次

// 先检查是否超限
if (passcode.tryCount >= maxTryCount) {
  throw new RequestError('verification_code.exceed_max_try');
}

// 验证码错误 → tryCount + 1
if (code !== passcode.code) {
  await increasePasscodeTryCount(passcode.id);  // UPDATE passcodes SET tryCount = tryCount + 1
  throw new RequestError('verification_code.code_mismatch');
}

// 验证码正确 → consumed = true
await consumePasscode(passcode.id);  // UPDATE passcodes SET consumed = true
```

**关键点**：
- 重试次数阈值来自 `sign_in_experiences.verificationCodePolicy.maxRetryAttempts`，默认 10 次
- **tryCount 是单码级计数器**：每条 passcode 记录独立计数，重置通过重发新码实现（旧码被删，新码 tryCount 从 0 开始）
- **校验顺序**：先查过期 → 再查 tryCount 超限 → 最后比对 code
- **code 错误**：`tryCount++` 并抛 `code_mismatch`
- **code 正确**：`consumed = true`，该码永久失效

### 2.4 忘记密码跳过投递（skipDelivery）

**代码**：[verification-code-helpers.ts L76-L144](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/verification-code-helpers.ts#L76-L144)

```typescript
// 判断用户是否存在
const hasUserWithIdentifier = async (queries, identifier): Promise<boolean> => {
  const { type, value } = identifier;
  if (type === SignInIdentifier.Email) {
    return queries.users.hasUserWithEmail(value);
  }
  return queries.users.hasUserWithNormalizedPhone(value);
};

// sendCode 主逻辑
const skipDelivery =
  interactionEvent === InteractionEvent.ForgotPassword &&
  !(await hasUserWithIdentifier(queries, identifier));

const payload = skipDelivery
  ? undefined
  : {
      ...ctx.emailI18n,
      ...(await buildVerificationCodeTemplateContext(...)),
      ...(ctx.request.ip && { ip: ctx.request.ip }),
    };

await codeVerification.sendVerificationCode(payload, { skipDelivery });
```

**`sendVerificationCode()` 内部分支** ([code-verification.ts L102-L119](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/verifications/code-verification.ts#L102-L119))：

```typescript
async sendVerificationCode(payload?, options?: { skipDelivery?: boolean }) {
  const { createPasscode, sendPasscode } = this.libraries.passcodes;

  // ① 无论 skipDelivery 是否为 true，都创建 passcode 记录（旧码失效）
  const verificationCode = await createPasscode(
    this.id,
    this.templateType,
    getPasscodeIdentifierPayload(this.identifier)
  );

  // ② skipDelivery = true 时，不调用 sendPasscode（不发短信/邮件）
  if (options?.skipDelivery) {
    return;
  }

  // ③ 正常调用连接器发送
  await sendPasscode(verificationCode, payload);
}
```

**关键点**：
- **触发条件**：`ForgotPassword` 事件 + 用户不存在
- **数据库仍写记录**：即使不投递，`createPasscode` 也会执行——删除旧码、插入新码、tryCount=0
- **目的 1 — 防止账号枚举**：攻击者输入不存在的邮箱，接口返回与正常一致（都是 200，`verificationId` 相同），无法通过响应差异判断账号是否存在
- **目的 2 — 防止配置泄露**：`payload = undefined` 跳过 connector 和 template 校验，避免因模板/连接器配置错误泄露信息
- **用户体验**：真实用户（账号存在）会收到邮件；攻击者（账号不存在）不会收到任何邮件，但接口表现完全一样
- **与 Captcha 的关系**：`guardCaptcha()` 在 `sendCode()` 之前执行，所以即使用户不存在、不实际投递，仍需先过 Captcha

---

## 三、各类型验证码发送的 guardCaptcha 条件区分

### 3.0 关键结论：guardCaptcha 条件只有一个判断维度

所有验证码发送共用同一个路由处理函数，guardCaptcha 的触发条件**只看 `!identifiedUserId`，不看 `interactionEvent`，也不看验证码类型。

```typescript
// verification-code.ts L49-L52
// Require captcha if the user is not identified.
if (!ctx.experienceInteraction.identifiedUserId) {
  await ctx.experienceInteraction.guardCaptcha();
}
```

> **`identifiedUserId` 为 undefined**

| 类型 | 路由 | 是否有 identifiedUserId? | guardCaptcha 触发? |
|------|------|-------------------|-----------------|
| 普通验证码（登录/注册/忘记密码） | `POST /experience/verification/verification-code` | 无，此时交互初始化时，用户还未 identify → **触发 |
| MFA 绑定验证码（已识别用户绑定新邮箱/手机号） | 同上 | 有（已通过密码/验证码识别了用户 → **不触发** |
| MFA 登录校验验证码 | `POST /experience/verification/mfa-verification-code` | 有（必须先识别用户，才能发 MFA 验证） → **不触发** |

### 3.1 验证码发送（sendCode）完整执行顺序

```
POST /experience/verification/verification-code
Body: { identifier, interactionEvent }
        ↓
① if (!identifiedUserId) → guardCaptcha()                      ← 【Captcha 检查】
  │  └─ identifiedUserId=undefined && captchaPolicy.enabled → captcha_required
  │     覆盖场景：
  │     ✅ SignIn 登录验证码
  │     ✅ Register 注册验证码
  │     ✅ ForgotPassword 忘记密码验证码
  │     ❌ 已识别用户的 MFA 绑定验证码（identifiedUserId ≠ undefined → 跳过
        ↓
② 判断验证码用途（L59-L65）
  │   identifiedUserId 存在，且 email/phone 不在 signUp identifiers
  │   → 则是 MFA 绑定验证码，TemplateType = BindMfa
  │   → createNewCodeVerificationRecord(..., BindMfa)
  │ 否则 → TemplateType = getTemplateTypeByEvent(interactionEvent)
  │   → SignIn / Register / ForgotPassword 对应各自模板
        ↓
③ sendCode()
  ├─ 3a. createVerificationRecord()                       ← 构建 CodeVerification 对象
  ├─ 3b. Register + Email → guardEmailBlocklist()      ← 注册邮件黑名单
  ├─ 3c. 计算 skipDelivery:
  │     ForgotPassword && !hasUserWithIdentifier(queries, identifier)
  ├─ 3d. codeVerification.sendVerificationCode(payload, { skipDelivery })
  │     ├─ createPasscode(id, templateType, payload)      ← 【旧码失效：物理删除旧码，插入新码
  │     ├─ if (skipDelivery) return;                  ← 【跳过投递】
  │     └─ sendPasscode() → 调用短信/邮件连接器发送
  └─ 3e. setVerificationRecord() + save()             ← 保存到交互会话
        ↓
返回 { verificationId }
```

**配合关系**：
| 检查 | 位置 | 触发时机 |
|------|------|----------|
| Captcha | ① | 仅当 `!identifiedUserId` 时执行，覆盖登录/注册/忘记密码的验证码；MFA 场景自动跳过 |
| 旧码失效 | 3d createPasscode | 创建新码时物理删除旧码，即使 skipDelivery 也执行 |
| 邮件黑名单 | 3b | 仅 Register + Email |
| skipDelivery | 3c-3d | 仅 ForgotPassword + 用户不存在 |
| BindMfa 模板 | ② | 已识别用户且标识不在 signUp identifiers 时，模板使用 BindMfa |

### 3.2 MFA 登录校验验证码（无 guardCaptcha

```
POST /experience/verification/mfa-verification-code
Body: { identifierType: Email | Phone }
        ↓
① 无 guardCaptcha 调用（整个路由处理函数L128-L148 直接调用 sendCode 前没有任何 Captcha 检查
  │ 原因：
  │   - MFA 路由要求必须先有 identifiedUserId 才能从用户 profile 拿邮箱/手机号
  │   - 所以 identifiedUserId 一定存在，Captcha 已在识别用户的路径被 Captcha 守卫
        ↓
② getMfaIdentifier()
  │   identifiedUserId=undefined → 抛 identifier_not_found 400
  │   从 users 表查询用户 primaryEmail / primaryPhone 作为 identifier
        ↓
③ sendCode()
  └─ createNewMfaCodeVerificationRecord(..., verified=false)
  └─ TemplateType = MfaVerification
        ↓
返回 { verificationId }
```

**关键点**：
- MFA 校验验证码的发送路由**完全没有 guardCaptcha 调用**
- 因为 getMfaIdentifier() 中 identifiedUserId 检查，保证了用户必须已识别用户才能进入 MFA 路径
- 识别用户的路径（密码/验证码登录）已经过了 Captcha 守卫（在 submit 时检查）或 skipCaptcha（社交/SSO/Passkey）
- 所以 MFA 校验验证码不需要重复做 Captcha


### 3.2 验证码校验（verifyCode）完整执行顺序

```
POST /experience/verification/verification-code/verify
Body: { verificationId, identifier, code }
        ↓
① getVerificationRecordByTypeAndId()                          ← 从交互会话取 CodeVerification
        ↓
② withSentinel(SentinelActivityAction.VerificationCode,       ← 【Sentinel 包裹】
     codeVerificationRecord.verify(identifier, code))
  │
  ├─ 2a. verifyPasscode(jti, templateType, code, payload)     ← 【Passcode 校验】
  │     ├─ 查找 passcode（按 interactionJti + type）
  │     │   └─ 不存在 → verification_code.not_found
  │     ├─ 校验 identifier（email/phone 匹配）
  │     ├─ 加载 verificationCodePolicy（expirationDuration, maxRetryAttempts）
  │     ├─ 【过期检查】 createdAt + expirationMs < now
  │     │   └─ expired → verification_code.expired
  │     ├─ 【tryCount 检查】 passcode.tryCount >= maxRetryAttempts
  │     │   └─ 超限 → verification_code.exceed_max_try
  │     ├─ 【code 比对】
  │     │   ├─ 错误 → increasePasscodeTryCount() → code_mismatch
  │     │   └─ 正确 → consumePasscode() → consumed = true
  │     └─ 通过 → verified = true
  │
  ├─ 2b. reportActivity(VerificationCode, Failed/Success)     ← 【Sentinel 计数】
  │     ├─ 合并池（与 Password、OneTimeToken 共享）
  │     ├─ 失败次数累计达 100 次/小时 → 抛 verification_blocked
  │     └─ 目标标识符 SHA256 哈希存储
  │
  └─ 2c. withSentinel 结果：
        ├─ Sentinel 锁定 → 抛 verification_blocked（优先级最高）
        ├─ 验证失败 → 抛原错误（code_mismatch / expired / exceed_max_try）
        └─ 成功 → 返回
        ↓
③ experienceInteraction.save()
        ↓
返回 { verificationId }
```

**配合关系**（双重保护）：
| 检查 | 计数器范围 | 默认阈值 | 错误码 |
|------|-----------|---------|--------|
| **单码 tryCount** | 单条 passcode 记录 | 10 次 | `verification_code.exceed_max_try` |
| **Sentinel 合并池** | 同标识符 1 小时内所有验证码失败 | 100 次 | `session.verification_blocked_too_many_attempts` |
| **过期时间** | 单条 passcode 记录 | 600 秒 | `verification_code.expired` |

> **三层防护**：
> 1. 过期时间（时间窗口）
> 2. 单码 tryCount（微观粒度，防一个码被猜 10 次以上）
> 3. Sentinel 合并池（宏观粒度，防重发新码绕过 tryCount，累计达 100 次后锁定）

### 3.3 ForgotPassword 场景下的完整链路

```
ForgotPassword: 用户输入不存在的邮箱
        ↓
[POST /experience/verification/verification-code]
  ├─ ① guardCaptcha() → 必须通过 Captcha
  ├─ ② sendCode()
  │     ├─ interactionEvent = ForgotPassword
  │     ├─ hasUserWithIdentifier(email) → false
  │     ├─ skipDelivery = true
  │     ├─ createPasscode() → 物理删除旧码 + 插入新码（数据库有记录）
  │     ├─ if (skipDelivery) return; → 不实际发送邮件
  │     └─ save() → 保存 verificationId
  └─ 返回 { verificationId }（与正常发送完全相同的响应）
        ↓
[POST /experience/verification/verification-code/verify]
  ├─ ① withSentinel(VerificationCode, verify())
  │     ├─ verifyPasscode() → code 错误（因为用户没收到邮件，输入的是瞎猜的）
  │     │   └─ tryCount++ + 抛 code_mismatch
  │     └─ reportActivity(Failed) → Sentinel 合并池 +1
  └─ 返回 code_mismatch（同样的错误码，攻击者无法区分）
```

**防枚举效果**：整个流程中接口响应与真实用户场景完全一致，攻击者无法判断该邮箱是否注册过账号。同时 Captcha 防止枚举请求被自动化发起，Sentinel 防止同一邮箱被反复尝试。

---

## 四、各入口 Captcha 与 Sentinel 的执行顺序

> **核心结论**：只有「验证码发送」入口**先做人机校验**（guardCaptcha）；密码验证、验证码校验、一次性令牌入口都**先记录失败次数**（withSentinel），Captcha 校验延迟到最终 submit。

### 4.1 密码验证：先 Sentinel，无前置 Captcha

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

### 4.2 验证码发送：先 Captcha，无 Sentinel

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
  ├─ 2b. createPasscode() → 旧码物理删除 + 新码插入
  ├─ 2c. ForgotPassword + 用户不存在 → skipDelivery（不实际发送）
  ├─ 2d. sendPasscode()（非 skipDelivery 时）
  └─ 2e. setVerificationRecord + save()
```

**关键点**：
- **先 Captcha 后发送**：`guardCaptcha()` 在 sendCode 之前执行，防止自动化脚本消耗短信/邮件配额
- **无 Sentinel**：发送验证码不涉及凭证校验，不记录失败次数
- **条件守卫**：仅当 `!identifiedUserId` 时才检查 Captcha，已识别用户（如 MFA 流程中）无需再次验证
- **ForgotPassword 也过 Captcha**：即使用户不存在、最终 skipDelivery，仍需先过 Captcha

### 4.3 验证码校验：先 Sentinel（内嵌套三层 passcode 校验），无前置 Captcha

**路由**：`POST /experience/verification/verification-code/verify`
**代码**：[verification-code-helpers.ts L172-L223](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/verification-code-helpers.ts#L172-L223)

```
请求进入
  ↓
① withSentinel(VerificationCode,
     codeVerificationRecord.verify(identifier, code))
  │
  ├─ 内层 verifyPasscode()：
  │   ├─ 过期检查（600s）
  │   ├─ tryCount 检查（10 次）→ 超限抛 exceed_max_try
  │   └─ code 比对 → 错误时 tryCount++ 抛 code_mismatch
  │
  ├─ reportActivity(VerificationCode, Failed/Success)
  │   └─ 合并池累计（跨多码）达 100 次/小时 → 抛 verification_blocked
  │
  └─ withSentinel 返回：Sentinel 锁定 > 原验证错误 > 成功
  ↓
② save()
```

**关键点**：
- **无前置 guardCaptcha**：验证码校验路由中不调用 `guardCaptcha()`
- **三层校验嵌套**：Sentinel 包裹，内层 verifyPasscode 依次做过期 → tryCount → code 比对
- **双重计数器**：单码 tryCount（10 次/码）+ Sentinel 合并池（100 次/小时/标识符）

### 4.4 一次性令牌验证：先 Sentinel，成功后 skipCaptcha

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

### 4.5 最终提交：先 Captcha，再 MFA 守卫

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

## 五、执行顺序总览表

| 入口 | Captcha 守卫 | Sentinel 记录 | 执行顺序 | 原因 |
|------|-------------|--------------|----------|------|
| **密码验证** `/verification/password` | ❌ 无 | ✅ 先执行 | **Sentinel → （submit 时 Captcha）** | 密码验证不消耗外部资源，先记录失败即可 |
| **验证码发送** `/verification/verification-code` | ✅ 先执行 | ❌ 无 | **Captcha → 旧码失效 → 发送/skipDelivery** | 发送消耗短信/邮件配额，必须先拦截机器人 |
| **验证码校验** `/verification/verification-code/verify` | ❌ 无 | ✅ 先执行 | **Sentinel(过期 → tryCount → code) → （submit 时 Captcha）** | 三层校验嵌套，双重计数器 |
| **一次性令牌** `/verification/one-time-token/verify` | ❌ 无 | ✅ 先执行 | **Sentinel → 成功后 skipCaptcha** | Sentinel 先判断，通过后 Captcha 自动跳过 |
| **社交登录** `/verification/social/:connectorId/verify` | ❌ 无 | ❌ 无 | **验证 → 成功后 skipCaptcha** | 第三方已验证身份，两者都不需要 |
| **企业 SSO** `/verification/sso/:connectorId/verify` | ❌ 无 | ❌ 无 | **验证 → 成功后 skipCaptcha** | 企业 IdP 已验证身份，两者都不需要 |
| **Passkey** `/verification/sign-in-passkey/.../verify` | ❌ 无 | ❌ 无 | **验证 → 成功后 skipCaptcha** | Passkey 是强认证因子，两者都不需要 |
| **最终提交** `/submit` | ✅ 先执行 | ❌ 无 | **Captcha → MFA → 完成** | Captcha 是最终守门员 |

### 执行顺序分类

**A 类：先 Captcha（人机校验优先）**
- 验证码发送：防止机器人消耗资源（即使 skipDelivery 也先过 Captcha）
- 最终提交：防止未通过人机校验的请求完成登录

**B 类：先 Sentinel（失败计数优先）**
- 密码验证：记录失败次数，延迟 Captcha 到提交
- 验证码校验：Sentinel 包裹内层三层校验（过期 → tryCount → code），双重计数器
- 一次性令牌：先记录失败次数，成功后自动跳过 Captcha

**C 类：两者都不需要**
- 社交登录、企业 SSO、Passkey：第三方/强认证已完成验证

---

## 六、Captcha 验证代码路径

### 6.1 核心类与文件

| 类/文件 | 位置 | 职责 |
|--------|------|------|
| `CaptchaValidator` | [captcha-validator.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/captcha-validator.ts) | 调用第三方 API 验证验证码令牌 |
| `ExperienceInteraction` | [experience-interaction.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts) | 管理交互会话中的 captcha 状态 |
| `SignInExperienceValidator` | [sign-in-experience-validator.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/sign-in-experience-validator.ts) | 检查 captcha 策略是否要求验证 |

### 6.2 Captcha 状态管理

在 `ExperienceInteraction` 中维护 captcha 状态（[L74-L77](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L74-L77)）：

```typescript
private readonly captcha = {
  verified: false,
  skipped: false,
};
```

- `verified`: 前端在创建交互时主动提交 captchaToken 并验证通过
- `skipped`: 后端在第三方验证成功后自动标记（skipCaptcha）

### 6.3 Captcha 验证入口

**交互创建时可选验证** ([index.ts L62-L96](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/index.ts#L62-L96))

```
PUT /experience
Body: { interactionEvent, captchaToken? }
```

- 调用链：`index.ts L82-L84` → `ExperienceInteraction.verifyCaptcha()` → `CaptchaValidator.verifyCaptcha()`
- 这是**主动验证**入口，captchaToken 由前端根据策略决定是否提交
- 验证通过后 `captcha.verified = true`

### 6.4 Captcha 校验守卫

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

### 6.5 guardCaptcha 调用点

| 调用位置 | 代码路径 | 触发条件 |
|---------|----------|----------|
| 验证码发送前 | [verification-code.ts L50-L52](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/verification-code.ts#L50-L52) | `!identifiedUserId` 时检查 |
| 创建用户时 | [experience-interaction.ts L303](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L303) | 注册流程 createUser 前检查 |
| 提交交互时 | [experience-interaction.ts L483](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L483) | 登录/注册最终 submit 前检查 |

### 6.6 skipCaptcha 调用点

`skipCaptcha()` 定义于 [experience-interaction.ts L440-L442](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L440-L442)。

| 登录方式 | 代码位置 | 触发条件 |
|----------|----------|----------|
| 一次性令牌 | [one-time-token.ts L66](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/one-time-token.ts#L66) | withSentinel 通过后 |
| Passkey 登录 | [web-authn-verification.ts L435](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/web-authn-verification.ts#L435) | Passkey 验证成功后 |
| 社交登录 | [social-verification.ts L153](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/social-verification.ts#L153) | OAuth 回调验证成功后 |
| 企业 SSO | [enterprise-sso-verification.ts L125](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/verification-routes/enterprise-sso-verification.ts#L125) | SSO 回调验证成功后 |

> **关键时序**：skipCaptcha 全部在「验证成功后」触发。一次性令牌场景中，如果 withSentinel 因验证失败或被锁定而抛出异常，skipCaptcha 不会执行——这意味着失败路径仍需在 submit 时过 Captcha。

### 6.7 Captcha 第三方验证实现

**Turnstile** ([captcha-validator.ts L43-L76](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/captcha-validator.ts#L43-L76))
- Cloudflare API，检查 `success` 字段

**Recaptcha Enterprise** ([captcha-validator.ts L78-L133](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/captcha-validator.ts#L78-L133))
- Google API，Checkbox 模式仅验证 token，Invisible 模式还需风险分数 ≥ 0.5

---

## 七、Sign-in 节流 (Sentinel) 代码路径

### 7.1 核心类与文件

| 类/文件 | 位置 | 职责 |
|--------|------|------|
| `BasicSentinel` | [basic-sentinel.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/sentinel/basic-sentinel.ts) | 核心节流逻辑：记录活动、决策是否阻止 |
| `withSentinel()` | [sentinel-guard.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/routes/experience/classes/libraries/sentinel-guard.ts) | 验证操作包装器，自动报告活动结果 |
| `defaultSentinelPolicy` | [sentinel.ts L9-L12](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/schemas/src/consts/sentinel.ts#L9-L12) | 默认阈值定义 |

### 7.2 Sentinel 策略配置与默认阈值

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

### 7.3 活动类型与计数池

**计数池分组** 定义于 [basic-sentinel.ts L30-L45](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/core/src/sentinel/basic-sentinel.ts#L30-L45)：

| 分组 | 操作类型 | 计数方式 |
|------|----------|----------|
| **合并池** (pooledActions) | `Password`、`VerificationCode`、`OneTimeToken` | 三者共享同一个失败计数器 |
| **独立池** (isolatedActions) | `MfaTotp`、`WebAuthn`、`MfaBackupCode` | 每个 Action 独立计数，互不影响 |

- 合并池：1 小时内密码错 60 次 + 验证码错 40 次 = 累计 100 次 → 触发锁定
- 独立池：TOTP 错 100 次只锁定 TOTP，不影响密码登录
- 注意：MFA 的邮箱/手机验证码也使用 `VerificationCode`，同样计入合并池

### 7.4 withSentinel 内部执行顺序

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

### 7.5 Sentinel 应用位置一览表

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

## 八、完整登录流程详解

### 8.1 密码登录流程

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

### 8.2 验证码登录流程

```
用户输入手机号/邮箱
        ↓
[PUT /experience] （可选：提前 captchaToken → captcha.verified = true）
        ↓
[POST /experience/verification/verification-code]
  ├─ ① guardCaptcha() → 未识别用户且策略启用 → 422 captcha_required  ← 先 Captcha
  └─ ② sendCode()
        ├─ createPasscode() → 旧码物理删除 + 新码插入
        └─ sendPasscode() → 发送验证码
        ↓
用户输入验证码
        ↓
[POST /experience/verification/verification-code/verify]
  ├─ ③ withSentinel(VerificationCode, verify(code))               ← 后 Sentinel
  │     ├─ 内层：过期 → tryCount → code 比对（三层）
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

**执行顺序**：Captcha（步骤①）→ Sentinel + 三层 passcode 校验（步骤③）→ Captcha 再次确认（步骤⑥）

### 8.3 一次性令牌 (Magic Link) 流程

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

---

## 九、关键配置与默认值

### 9.1 CaptchaPolicy
```typescript
type CaptchaPolicy = {
  enabled?: boolean;  // 默认 undefined（不启用）
};
```

### 9.2 SentinelPolicy
```typescript
type SentinelPolicy = {
  maxAttempts?: number;      // 默认 100 次/小时
  lockoutDuration?: number;  // 默认 60 分钟
};
```

### 9.3 VerificationCodePolicy
```typescript
type VerificationCodePolicy = {
  expirationDuration?: number;  // 默认 600 秒（10分钟）
  maxRetryAttempts?: number;    // 默认 10 次（单码 tryCount）
};
```

默认值定义于 [verification-code.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/64-logto/packages/schemas/src/consts/verification-code.ts#L9-L12)。

---

## 十、错误码汇总

| 错误码 | 触发场景 | HTTP 状态 |
|--------|----------|-----------|
| `session.captcha_required` | Captcha 启用且未 verified/skipped | 422 |
| `session.captcha_failed` | captchaToken 第三方验证未通过 | 422 |
| `session.verification_blocked_too_many_attempts` | Sentinel 失败次数超阈值 | 422 |
| `session.invalid_credentials` | 密码错误 | 422 |
| `verification_code.not_found` | Passcode 记录不存在（已被删/未创建） | 422 |
| `verification_code.code_mismatch` | 验证码错误（tryCount++） | 422 |
| `verification_code.expired` | 验证码超过有效期 | 422 |
| `verification_code.exceed_max_try` | 单码重试次数超限（默认 10 次） | 422 |
| `verification_code.email_mismatch` | 邮箱与 passcode 记录不匹配 | 422 |
| `verification_code.phone_mismatch` | 手机号与 passcode 记录不匹配 | 422 |

---

## 十一、设计要点总结

### 11.1 执行顺序分两类
- **资源消耗型操作**（验证码发送）→ 先 Captcha 后执行，防止机器人消耗配额
- **凭证校验型操作**（密码/验证码/令牌校验）→ 先 Sentinel 后 Captcha，失败次数优先记录

### 11.2 Passcode 三层防护
1. **过期时间**（600s）：防止旧码被长期利用
2. **单码 tryCount**（10 次/码）：防止单条验证码被暴力猜测
3. **Sentinel 合并池**（100 次/小时）：防止重发新码绕过 tryCount，跨码累计失败次数

### 11.3 Passcode 旧码失效机制
- 创建新码时**物理删除**旧码（DELETE），不是置 consumed
- 按 `interactionJti + templateType`（会话级）或 `identifier + templateType`（全局级）查找
- ForgotPassword skipDelivery 场景同样触发旧码失效

### 11.4 ForgotPassword skipDelivery
- 忘记密码 + 用户不存在 → 仍写 passcode 记录，但不发送邮件/短信
- 目的：防止账号枚举（接口响应与正常发送完全一致）
- 配合：Captcha 仍需先过（防止自动化枚举），Sentinel 在校验时仍计数（防止反复尝试）

### 11.5 Captcha 延迟到 submit
- 密码验证和验证码校验不在自身路由检查 Captcha，而是在 `submit()` 统一守卫
- skipCaptcha 时序保证：一次性令牌场景中 skipCaptcha 在 withSentinel 之后，验证失败时不会跳过 Captcha

### 11.6 其他设计要点
- Sentinel 默认阈值 100 次/小时：较高阈值与 Captcha 前置拦截互补
- 计数池双轨制：合并池（Password+VerificationCode+OneTimeToken）vs 独立池（MFA 各因素）
- 隐私保护：Sentinel 目标标识符以 SHA256 哈希存入数据库，不落明文
- Captcha 状态持久化：verified/skipped 随 OIDC interaction 会话存储，同一会话只需验证一次
- 灵活配置：所有阈值均可通过 SignInExperience 配置调整
