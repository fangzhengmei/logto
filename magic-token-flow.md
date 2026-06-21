# One-Time Token 与魔法链接生成消费链路

## 概述

Logto 中存在两套相似但用途不同的令牌/验证码机制：

1. **One-Time Token (一次性令牌)**：通过 Management API 创建，主要用于魔法链接（Magic Link）场景，用户点击邮件中的链接后直接登录。
2. **Verification Code (验证码)**：通过 Experience API 创建，用于常规的邮箱/手机验证码登录、注册、找回密码等场景。

两者最终都会汇入 **Verification Record（验证记录）** 抽象层，再通过 **Experience Interaction（交互会话）** 完成登录衔接。

---

## 一、核心概念

### 1.1 One-Time Token

一次性令牌是存储在 `one_time_tokens` 表中的长字符串令牌，具有以下特性：

- **状态机**：`Active` → `Consumed` / `Revoked` / `Expired`
- **默认有效期**：10 分钟
- **绑定邮箱**：每个令牌与一个邮箱绑定
- **上下文数据**：支持 `jitOrganizationIds` 等扩展上下文（用于组织 JIT 开通）

相关类型定义在 [one-time-tokens.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/schemas/src/foundations/jsonb-types/one-time-tokens.ts)。

### 1.2 Verification Code (Passcode)

验证码是存储在 `passcodes` 表中的 6 位数字码，具有以下特性：

- **长度**：6 位数字
- **有效期**：可配置，默认 10 分钟
- **重试次数**：可配置，默认 10 次
- **模板类型**：SignIn、Register、ForgotPassword、BindMfa、MfaVerification、Generic 等
- **投递方式**：邮箱或短信

核心逻辑在 [passcode.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/libraries/passcode.ts)。

### 1.3 Verification Record

验证记录是对所有验证方式的抽象，统一了交互层的验证接口。每种验证方式对应一个 Verification Record 类型：

| 验证类型 | 枚举值 | 说明 |
|---------|-------|------|
| 密码 | `Password` | 用户名密码验证 |
| 邮箱验证码 | `EmailVerificationCode` | 邮箱验证码验证 |
| 手机验证码 | `PhoneVerificationCode` | 手机验证码验证 |
| 一次性令牌 | `OneTimeToken` | 一次性令牌验证 |
| 社交登录 | `Social` | 第三方社交登录 |
| 企业 SSO | `EnterpriseSso` | 企业 SSO 登录 |
| TOTP | `Totp` | 时间-based 一次性密码 |
| WebAuthn | `WebAuthn` | 生物识别/安全密钥 |
| 备份码 | `BackupCode` | MFA 备份码 |

类型定义在 [verification-type.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/schemas/src/types/verification-records/verification-type.ts)。

### 1.4 Experience Interaction

交互会话（Interaction）是用户登录/注册过程中的短期会话，管理整个交互流程的状态：

- 存储所有 Verification Records
- 管理用户识别状态
- 管理 Profile 数据
- 管理 MFA 验证状态
- 负责最终的提交与会话创建

核心类在 [experience-interaction.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/classes/experience-interaction.ts)。

---

## 二、One-Time Token 生成流程

### 2.1 创建入口

通过 Management API 创建：`POST /one-time-tokens`

路由定义在 [one-time-tokens.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/one-time-tokens.ts#L83-L119)。

### 2.2 创建步骤

```
1. 请求参数校验
   ├── email: 绑定的邮箱
   ├── expiresIn: 有效期（秒），可选，默认 600 秒
   └── context: 扩展上下文，可选（如 jitOrganizationIds）

2. 清理同邮箱的过期令牌
   └── updateExpiredOneTimeTokensStatusByEmail(email)
       └── 将该邮箱下所有已过期的 Active 状态令牌标记为 Expired

3. 生成新令牌
   ├── id: generateStandardId()
   ├── token: generateStandardSecret()  // 随机长字符串
   ├── expiresAt: 当前时间 + expiresIn
   ├── status: Active
   └── context: 传入的上下文数据

4. 插入数据库
   └── insertOneTimeToken() → one_time_tokens 表

5. 返回完整的令牌对象
```

### 2.3 数据库表结构（one_time_tokens）

- `id`: 令牌记录 ID
- `token`: 令牌值（随机字符串）
- `email`: 绑定的邮箱
- `status`: 状态（active / consumed / revoked / expired）
- `expiresAt`: 过期时间
- `context`: JSONB 上下文数据
- `createdAt`: 创建时间

查询逻辑在 [one-time-tokens.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/queries/one-time-tokens.ts)。

---

## 三、One-Time Token 验证与消费

### 3.1 验证入口

有两个验证入口：

1. **Management API**：`POST /one-time-tokens/verify`
2. **Experience API**：`POST /experience/verification/one-time-token/verify`

Experience 端的路由在 [one-time-token.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/verification-routes/one-time-token.ts)。

### 3.2 Experience 端验证流程

```
1. 创建 OneTimeTokenVerification 记录
   ├── OneTimeTokenVerification.create(libraries, queries, identifier)
   ├── 生成 verificationId
   ├── 初始状态: verified = false
   └── 存入 interaction 的 verificationRecords 中

2. Sentinel 防护（防暴力破解）
   └── withSentinel() 包装验证操作

3. 调用 verify 方法
   └── oneTimeTokenVerificationRecord.verify(token)
       ├── 调用 libraries.oneTimeTokens.verifyOneTimeToken(token, email)
       │   ├── 按 token 查询数据库
       │   ├── 校验邮箱匹配
       │   ├── 校验未过期
       │   ├── 校验状态为 Active
       │   ├── 标记状态为 Consumed
       │   └── 返回令牌记录
       ├── 设置 verified = true
       └── 保存 context 数据

4. 跳过 CAPTCHA
   └── experienceInteraction.skipCaptcha()

5. 保存交互状态
   └── experienceInteraction.save()

6. 返回 verificationId
```

### 3.3 核心验证逻辑

`verifyOneTimeToken` 函数在 [one-time-token.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/libraries/one-time-token.ts#L49-L53)：

```typescript
const verifyOneTimeToken = async (token: string, email: string) => {
  await checkOneTimeToken(token, email);  // 校验
  return updateOneTimeTokenStatus(token, OneTimeTokenStatus.Consumed);  // 消费
};
```

`checkOneTimeToken` 校验项：

- 令牌存在（404 token_not_found）
- 邮箱匹配（400 email_mismatch）
- 未过期（400 token_expired）
- 状态不是 Consumed（400 token_consumed）
- 状态不是 Revoked（400 token_revoked）

### 3.4 状态转换规则

在 [one-time-token.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/libraries/one-time-token.ts#L19-L23) 中定义：

- **不能重新激活**：`updateOneTimeTokenStatus` 会拒绝将状态设回 Active
- **过期自动标记**：查询时会动态计算过期状态，创建新令牌时会清理同邮箱的过期令牌

---

## 四、Verification Code 生成流程

### 4.1 创建入口

通过 Experience API 创建：`POST /experience/verification/verification-code`

路由在 [verification-code.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/verification-routes/verification-code.ts)。

### 4.2 生成步骤

```
1. 参数校验
   ├── identifier: { type: 'email' | 'phone', value: string }
   └── interactionEvent: SignIn | Register | ForgotPassword

2. CAPTCHA 校验（未识别用户时）
   └── experienceInteraction.guardCaptcha()

3. 判断是否为 MFA 绑定验证码
   └── 已识别用户 + 标识符不在注册标识符列表中 → BindMfa 模板

4. 创建 Code Verification Record
   ├── createNewCodeVerificationRecord()
   ├── 根据 identifier.type 创建 EmailCodeVerification 或 PhoneCodeVerification
   ├── 生成 verificationId
   ├── 设置 templateType
   └── 初始状态: verified = false

5. 发送验证码
   └── codeVerification.sendVerificationCode(payload)
       ├── createPasscode(jti=verificationId, templateType, identifier)
       │   ├── 失效该 jti 下的旧 passcode
       │   ├── 生成 6 位随机码
       │   └── 插入 passcodes 表
       └── sendPasscode(passcode, context)
           ├── 获取邮件/短信连接器
           ├── 渲染模板（含应用名、组织名等上下文）
           └── 发送

6. 保存交互状态
   ├── experienceInteraction.setVerificationRecord()
   └── experienceInteraction.save()

7. 返回 verificationId
```

### 4.3 核心类：CodeVerification

抽象基类在 [code-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/classes/verifications/code-verification.ts)。

子类：
- `EmailCodeVerification` - 邮箱验证码
- `PhoneCodeVerification` - 手机验证码
- `MfaEmailCodeVerification` - MFA 邮箱验证码
- `MfaPhoneCodeVerification` - MFA 手机验证码

---

## 五、Verification Code 验证与消费

### 5.1 验证入口

`POST /experience/verification/verification-code/verify`

### 5.2 验证步骤

```
1. 参数校验
   ├── verificationId
   ├── code: 6 位验证码
   └── identifier

2. 从 interaction 中获取验证记录
   └── getVerificationRecordByTypeAndId(verificationType, verificationId)

3. Sentinel 防护
   └── withSentinel() 包装验证操作

4. 调用 verify 方法
   └── codeVerificationRecord.verify(identifier, code)
       └── verifyPasscode(jti=verificationId, templateType, code, identifier)
           ├── 按 jti + type 查询未消费的 passcode
           ├── 校验标识符匹配
           ├── 校验未过期
           ├── 校验未超过最大尝试次数
           ├── 校验验证码匹配（不匹配则增加尝试次数）
           └── consumePasscode() → 标记为已消费

5. 设置 verified = true

6. 保存交互状态

7. 返回 verificationId
```

### 5.3 Passcode 验证细节

在 [passcode.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/libraries/passcode.ts#L123-L169) 中：

```
校验顺序：
1. passcode 存在 → verification_code.not_found
2. 标识符匹配 → phone_mismatch / email_mismatch
3. 未过期 → verification_code.expired
4. 未超最大尝试次数 → verification_code.exceed_max_try
5. 验证码匹配 → verification_code.code_mismatch（不匹配时 tryCount++）
6. 消费 passcode → consumePasscode()
```

---

## 六、Verification Record 抽象层

### 6.1 类层次结构

```
VerificationRecord (抽象基类)
├── IdentifierVerificationRecord (标识符验证抽象类)
│   ├── EmailCodeVerification
│   ├── PhoneCodeVerification
│   ├── OneTimeTokenVerification
│   ├── PasswordVerification
│   ├── SocialVerification
│   └── EnterpriseSsoVerification
└── MfaVerificationRecord (MFA 验证抽象类)
    ├── TotpVerification
    ├── BackupCodeVerification
    └── WebAuthnVerification
```

基类定义在 [verification-record.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/classes/verifications/verification-record.ts)。

### 6.2 核心属性与方法

所有 Verification Record 都有：

- `id`: 验证记录 ID（verificationId）
- `type`: 验证类型（VerificationType 枚举）
- `isVerified`: 是否已验证
- `toJson()`: 序列化为 JSON
- `toSanitizedJson()`: 脱敏后的 JSON

IdentifierVerificationRecord 额外有：

- `identifier`: 标识符（邮箱/手机等）
- `identifyUser()`: 识别关联的用户
- `toUserProfile()`: 转换为用户 Profile 数据

### 6.3 VerificationRecordsMap

管理 interaction 中所有验证记录的 Map 类，在 [verification-records-map.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/classes/verifications/verification-records-map.ts)。

特点：
- 以 VerificationType 为 key
- 每种类型最多一条记录（新的会覆盖旧的）
- 类型安全的 get 方法

### 6.4 持久化

Verification Record 存储在 `verification_records` 表中：

- `id`: 记录 ID
- `userId`: 关联用户 ID（可选）
- `data`: JSONB 格式，存储具体验证数据
- `expiresAt`: 过期时间（默认 10 分钟）

查询逻辑在 [verification-records.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/queries/verification-records.ts)。

辅助函数在 [verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/libraries/verification.ts)：

- `insertVerificationRecord()`: 插入新记录
- `updateVerificationRecord()`: 更新记录
- `buildVerificationRecordByIdAndType()`: 按 ID 和类型重建记录实例

---

## 七、登录衔接完整流程

以 One-Time Token 登录为例，完整流程如下：

### 7.1 前置：令牌创建与魔法链接拼接

```
Management API 调用
  POST /one-time-tokens
  Body: { email, expiresIn?, context? }
  ↓
生成 one_time_token 记录（status=Active）
  返回 { id, token, email, status, expiresAt, context }
  ↓
业务系统拼接 OIDC 授权 URL（魔法链接）
  https://<logto-domain>/oidc/auth?
    client_id=<app-id>&
    redirect_uri=<callback>&
    response_type=code&
    scope=openid+profile+email&
    one_time_token=<token>&
    login_hint=<email>
  ↓
通过邮件将链接发送给用户
  ↓
用户点击魔法链接，请求 OIDC 授权端点
```

### 7.2 第一步：OIDC 授权端点与 koa-consent-guard 网关

用户点击魔法链接后，请求进入 OIDC 授权端点，经过 `koaConsentGuard` 中间件处理（详见第八章）：

```
GET /oidc/auth?one_time_token=xxx&login_hint=yyy&...
↓
koa-consent-guard 中间件
  ├── 提取 one_time_token + login_hint（需同时存在）
  ├── 账户切换检测
  │   └── 已有会话 + 邮箱不匹配 → 重定向 /switch-account
  ├── checkOneTimeToken 预检查
  │   ├── token_consumed + 当前用户匹配 → 放行 next()
  │   └── 其他错误 → 重定向 /one-time-token?errorMessage=...
  └── 预检查通过 → 重定向到 SPA
      ctx.redirect(buildExperienceUrl(oneTimeToken, token, loginHint))
      → /one-time-token?login_hint=<email>&one_time_token=<token>
```

核心逻辑在 [koa-consent-guard.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/middleware/koa-consent-guard.ts)。

### 7.3 第二步：SPA 落地与交互会话创建

```
用户浏览器加载 /one-time-token 页面
  ↓
OneTimeToken/index.tsx 解析 URL 参数
  ├── token = params.get('one_time_token')
  ├── email = params.get('login_hint')
  └── errorMessage = params.get('errorMessage')
  ↓
前置校验通过 → 触发 signInWithOneTimeToken
  ↓
1. initInteraction(InteractionEvent.SignIn)
   PUT /experience
   Body: { interactionEvent: 'SignIn' }
   ↓
   创建 ExperienceInteraction 实例
     ├── interactionEvent = SignIn
     ├── verificationRecords = []
     ├── userId = undefined
     └── profile = {}
   ↓
   保存到 interaction storage（OIDC session）
```

Experience API 入口在 [index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/index.ts#L62-L96)，前端落地页在 [OneTimeToken/index.tsx](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/experience/src/pages/OneTimeToken/index.tsx)。

### 7.4 第三步：验证 One-Time Token

```
POST /experience/verification/one-time-token/verify
Body: { identifier: { type: 'email', value: 'xxx' }, token: 'xxx' }
↓
创建 OneTimeTokenVerification 记录
  ├── id: verificationId
  ├── type: OneTimeToken
  ├── identifier: 邮箱
  └── verified: false
↓
存入 interaction.verificationRecords
↓
verifyOneTimeToken(token, email)
  ├── 查询 one_time_tokens 表
  ├── 校验邮箱、过期、状态
  └── 标记为 Consumed
↓
设置 verified = true
保存 context（jitOrganizationIds 等）
↓
跳过 CAPTCHA（skipCaptcha）
↓
保存 interaction
↓
返回 { verificationId }
```

### 7.5 第四步：识别用户

```
POST /experience/identification
Body: { verificationId }
↓
experienceInteraction.identifyUser(verificationId)
  ├── 获取 verification record
  ├── guardIdentificationMethod() 校验是否允许该方式
  ├── verificationRecord.identifyUser()
  │   └── findUserByIdentifier(queries, identifier)
  │       └── 按邮箱/手机查找用户
  ├── 校验用户未被挂起
  ├── 校验无身份冲突
  └── 设置 this.userId = user.id
↓
保存 interaction
```

### 7.6 第五步：提交交互（含注册兜底）

```
POST /experience/submit
↓
experienceInteraction.submit()
  ├── guardCaptcha() 校验人机验证（OneTimeToken 已跳过 CAPTCHA）
  ├── getIdentifiedUser() 确保用户已识别
  ├── guardMfaVerificationStatus() 校验 MFA（SignIn 时）
  ├── profile.validateAvailability() 校验 Profile 唯一性
  ├── profile.assertUserMandatoryProfileFulfilled() 校验必填字段
  ├── 更新用户 Profile（如果有变更）
  ├── 更新用户 MFA（如果有变更）
  ├── cleanUp() 清理交互数据
  └── assignReleaseOnSuccessInteractionHookResult()
      └── 触发 OIDC 登录，建立会话
↓
返回重定向 URI 或直接完成登录

———— 特殊分支：user.user_not_exist ————
识别用户失败 → 注册兜底：
  1. 条款同意校验（Manual 策略需弹窗确认）
  2. updateInteractionEvent(Register)
     PUT /experience/interaction-event
  3. guardInteractionEvent(Register, hasVerifiedOneTimeToken=true)
     → 即使 signInMode=SignIn 也允许注册
  4. 重新 POST /experience/identification
  5. 重新 POST /experience/submit → 完成注册并登录
```

Submit 逻辑在 [experience-interaction.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L474)，注册兜底特权在 [sign-in-experience-validator.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/classes/libraries/sign-in-experience-validator.ts#L103-L128)。

### 7.7 流程图

```
┌─────────────────────────────────────────────────────────────────────┐
│                      魔法链接登录流程（修正版）                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  [令牌生成阶段]                                                      │
│  POST /one-time-tokens (Management API)                             │
│    → 创建 one_time_token 记录 (status=Active)                        │
│    → 业务系统拼接 OIDC 授权 URL                                      │
│    → https://<logto-domain>/oidc/auth?...                           │
│          &one_time_token=<token>&login_hint=<email>                 │
│    → 邮件发送给用户                                                   │
│                                                                     │
│                           ↓ 用户点击魔法链接                          │
│                                                                     │
│  [OIDC 授权网关阶段]                                                │
│  GET /oidc/auth?one_time_token=xxx&login_hint=yyy                   │
│    ↓                                                                 │
│  koaConsentGuard 中间件                                              │
│    ├── 已有会话+邮箱不匹配 → 重定向 /switch-account                   │
│    ├── checkOneTimeToken 失败 → 重定向 /one-time-token?error=...    │
│    │     └── token_consumed + 当前用户匹配 → 放行(next)              │
│    └── 预检查通过 → 重定向到 SPA                                      │
│           /one-time-token?login_hint=yyy&one_time_token=xxx        │
│                                                                     │
│                           ↓ SPA 加载                                 │
│                                                                     │
│  [交互创建与验证阶段]                                                │
│  OneTimeToken 页面                                                   │
│    ├── 参数解析 + 前置校验                                           │
│    ├── initInteraction(SignIn) → PUT /experience                    │
│    └── verifyOneTimeToken → /verification/one-time-token/verify     │
│        → 创建 OneTimeTokenVerification 记录                         │
│        → verifyOneTimeToken() → 标记 Consumed                        │
│        → verified = true + 跳过 CAPTCHA                              │
│                                                                     │
│                           ↓                                          │
│                                                                     │
│  [识别与提交阶段]                                                    │
│  POST /experience/identification { verificationId }                 │
│    → 按邮箱 findUserByIdentifier()                                   │
│    → 设置 interaction.userId                                        │
│    ↓                                                                 │
│  POST /experience/submit                                            │
│    ├── 成功 → redirectTo → 完成登录 ✅                               │
│    └── user.user_not_exist → 注册兜底 ↓                             │
│                                                                     │
│  [注册兜底分支]                                                      │
│    ├── 条款同意确认（Manual 策略）                                   │
│    ├── updateInteractionEvent(Register)                              │
│    ├── guardInteractionEvent: 即使 signInMode=SignIn 也放行          │
│    ├── POST /experience/identification                              │
│    └── POST /experience/submit → 完成注册并登录 ✅                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 八、魔法链接入口与登录衔接

### 8.1 魔法链接 URL 参数

魔法链接通过 OIDC 授权 URL 的额外参数传递。关键参数定义在 [oidc.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/schemas/src/consts/oidc.ts#L20-L80)：

| 参数键 | 枚举值 | 说明 |
|--------|-------|------|
| `one_time_token` | `ExtraParamsKey.OneTimeToken` | 一次性令牌值，后端生成的随机字符串 |
| `login_hint` | `ExtraParamsKey.LoginHint` | 登录提示，在魔法链接场景中传入邮箱地址 |
| `prompt` | 标准 OIDC 参数 | 当值为 `login` 时强制重新认证 |

魔法链接的完整 URL 格式：

```
https://<logto-domain>/oidc/auth?
  client_id=<app-id>&
  redirect_uri=<callback>&
  response_type=code&
  scope=openid+profile+email&
  one_time_token=<token>&
  login_hint=<email>
```

业务系统在调用 `POST /one-time-tokens` 创建令牌后，将返回的 `token` 和 `email` 拼接到 OIDC 授权 URL 中，通过邮件发送给用户。

### 8.2 后端入口：koa-consent-guard 中间件

当用户点击魔法链接，OIDC 授权端点接收请求后，会经过 `koaConsentGuard` 中间件处理。这是魔法链接进入 Experience SPA 的**后端网关**。

核心逻辑在 [koa-consent-guard.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/middleware/koa-consent-guard.ts)。

#### 8.2.1 参数提取与校验

```
从 OIDC params 中提取 one_time_token + login_hint
  ↓
getOneTimeTokenParams() 校验
  ├── 两个参数必须同时存在且为 string 类型
  └── 缺少任一参数 → 跳过 one-time-token 处理，继续正常授权流程
```

#### 8.2.2 账户切换判断（SwitchAccount）

```
获取当前 session 的登录用户 primaryEmail
  ↓
判断是否需要切换账户：
  ├── 当前用户邮箱 ≠ login_hint
  ├── 且没有 prompt=login
  └── 且上一次提交的登录账号不匹配 login_hint
  ↓
满足以上所有条件 → 重定向到 /switch-account 页面
  ↓
不满足（邮箱匹配 / prompt=login / 上次登录匹配）→ 继续后续流程
```

重定向 URL 格式：`/switch-account?login_hint=<email>&one_time_token=<token>`

#### 8.2.3 令牌预检查

```
调用 libraries.oneTimeTokens.checkOneTimeToken(token, loginHint)
  ├── 令牌不存在 → 重定向到错误页
  ├── 邮箱不匹配 → 重定向到错误页
  ├── 令牌已过期 → 重定向到错误页
  ├── 令牌已消费（token_consumed）→ 特殊处理（见下文）
  └── 令牌已撤销 → 重定向到错误页
```

错误页重定向 URL 格式：`/one-time-token?errorMessage=<error.message>`

#### 8.2.4 已消费令牌的特殊处理

当令牌状态为 `Consumed` 时，存在一个**宽松放行**逻辑：

```
token_consumed 错误 + shouldContinueWithConsumedOneTimeToken() 判断
  ├── 当前用户邮箱 === login_hint → 放行（继续 next()）
  ├── 上次提交登录匹配 login_hint → 放行
  └── 均不匹配 → 重定向到错误页
```

设计意图：如果用户已经用该邮箱登录了（令牌被消费），不需要再强制报错，直接放行完成授权即可。

#### 8.2.5 正常流程重定向

令牌预检查通过后，重定向到 Experience SPA 的 OneTimeToken 页面：

```
ctx.redirect(buildExperienceUrl(experience.routes.oneTimeToken, token, loginHint))
→ /one-time-token?login_hint=<email>&one_time_token=<token>
```

### 8.3 前端落地页：OneTimeToken 组件

路由：`/one-time-token`（不在 AppLayout 内，无导航栏）

组件在 [OneTimeToken/index.tsx](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/experience/src/pages/OneTimeToken/index.tsx)。

#### 8.3.1 参数解析

```
useEffect 中解析 URL 参数：
  ├── token = params.get('one_time_token')
  ├── email = params.get('login_hint')
  └── errorMessage = params.get('errorMessage')
```

#### 8.3.2 前置校验与错误跳转

```
1. errorMessage 存在 → 跳转错误页
   navigate('/one-time-token/error', { state: { errorMessage } })

2. token 或 email 缺失 → 跳转错误页
   navigate('/one-time-token/error')

3. 条款同意策略为 Manual → 弹出条款确认
   ├── 用户拒绝 → 跳转错误页
   └── 用户同意 → 继续

4. 防重复提交
   └── isSubmitted.current 标志位
```

#### 8.3.3 令牌验证（signInWithOneTimeToken）

```
asyncSignInWithOneTimeToken({
  token,
  identifier: { type: SignInIdentifier.Email, value: email }
})
  ↓
内部调用链：
  1. initInteraction(InteractionEvent.SignIn)
     → PUT /experience { interactionEvent: 'SignIn' }

  2. POST /experience/verification/one-time-token/verify
     → 创建 OneTimeTokenVerification 记录
     → 校验并消费令牌
     → 返回 { verificationId }
```

#### 8.3.4 登录衔接：先登录后注册

这是魔法链接流程的**核心衔接逻辑**：

```
验证通过获得 verificationId
  ↓
submit(verificationId)  // 尝试用 SignIn 事件登录
  ↓
asyncIdentifyUserAndSubmit({ verificationId })
  → POST /experience/identification { verificationId }
  → POST /experience/submit
  ↓
判断结果：
  ├── 成功 → redirectTo(result.redirectTo) 完成登录
  └── 错误码 user.user_not_exist → 注册兜底
```

#### 8.3.5 注册兜底（registerWithOneTimeToken）

当用户不存在时，自动切换为注册流程：

```
registerWithOneTimeToken(verificationId)
  ↓
1. 条款同意校验（agreeToTermsPolicy）
   ├── Manual 策略 → 弹出条款确认
   │   └── 拒绝 → 跳转错误页 terms_acceptance_required_description
   └── Automatic 或已同意 → 继续

2. asyncRegisterWithVerifiedIdentifier(verificationId)
  ↓
内部调用链：
  a. updateInteractionEvent(InteractionEvent.Register)
     → PUT /experience/interaction-event { interactionEvent: 'Register' }

  b. identifyAndSubmitInteraction({ verificationId })
     → POST /experience/identification { verificationId }
     → POST /experience/submit
```

**关键点**：令牌已被验证（verified=true），注册时不需要重新验证邮箱。Verification Record 从 SignIn 交互保留到 Register 交互，`verified` 状态不重置。

#### 8.3.6 服务端对注册兜底的支持

在 [sign-in-experience-validator.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/classes/libraries/sign-in-experience-validator.ts#L103-L128) 中：

```typescript
public async guardInteractionEvent(event: InteractionEvent, hasVerifiedOneTimeToken = false) {
  switch (event) {
    case InteractionEvent.Register: {
      assertThat(
        signInMode !== SignInMode.SignIn ||
          // 即使注册被关闭，One-Time Token 验证通过后仍允许注册
          hasVerifiedOneTimeToken,
        new RequestError({ code: 'auth.forbidden', status: 403 })
      );
      break;
    }
  }
}
```

这意味着：**即使管理员将 signInMode 设为 SignIn（禁止注册），通过魔法链接验证的新用户仍可注册**。这是 One-Time Token 的特权——它保证了通过邮件验证身份的新用户不会因为注册开关被拦截。

同时，在 `guardSignInVerificationMethod` 中，OneTimeToken 类型**不做方法级别校验**：

```typescript
case VerificationType.OneTimeToken:
case VerificationType.Social: {
  // No need to verify one-time token and social verification methods
  break;
}
```

这是因为 One-Time Token 不在常规的 signIn.methods 配置中，它是一种独立的认证通道。

### 8.4 前端入口的多路汇聚

魔法链接的用户可以从多个页面进入 OneTimeToken 流程，系统会自动做路由汇聚：

#### 8.4.1 从 SignIn 页面进入

[SignIn/index.tsx](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/experience/src/pages/SignIn/index.tsx#L117-L124)：

```typescript
if (params.get(ExtraParamsKey.OneTimeToken)) {
  return <Navigate replace to={`/${experience.routes.oneTimeToken}?${params.toString()}`} />;
}
```

#### 8.4.2 从 Register 页面进入

[Register/index.tsx](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/experience/src/pages/Register/index.tsx#L46-L53)（RegisterFooter 中）：

```typescript
if (params.get(ExtraParamsKey.OneTimeToken)) {
  return <Navigate replace to={`/${experience.routes.oneTimeToken}?${params.toString()}`} />;
}
```

#### 8.4.3 从 SwitchAccount 页面进入

[SwitchAccount/index.tsx](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/experience/src/pages/SwitchAccount/index.tsx#L79-L89)：

用户点击"Continue as"按钮后，导航到 OneTimeToken 页面：

```typescript
onClick={() => {
  navigate(
    { pathname: `/${experience.routes.oneTimeToken}`, search: `?${params.toString()}` },
    { replace: true }
  );
}}
```

#### 8.4.4 从后端 consent-guard 直接重定向

[koa-consent-guard.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/middleware/koa-consent-guard.ts#L163)：

```
ctx.redirect(buildExperienceUrl(experience.routes.oneTimeToken, token, loginHint))
```

### 8.5 错误页跳转

错误页路由：`/one-time-token/error`（在 AppLayout 内）

组件在 [Error.tsx](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/experience/src/pages/OneTimeToken/Error.tsx)。

支持三种错误信息展示方式：

| state 字段 | 类型 | 说明 |
|-----------|------|------|
| `title` | i18n key | 错误标题 |
| `message` | i18n key | 错误描述 |
| `errorMessage` | string | 后端原始错误消息（rawMessage） |

默认展示：`error.invalid_link` / `error.invalid_link_description`

触发错误跳转的场景：

1. **后端预检查失败**：令牌过期/已消费/已撤销/邮箱不匹配/不存在
2. **前端参数缺失**：URL 中缺少 `one_time_token` 或 `login_hint`
3. **令牌验证 API 报错**：任何非 `user.user_not_exist` 的错误
4. **条款拒绝**：Manual 策略下用户拒绝条款

### 8.6 SwitchAccount 账户切换页面

路由：`/switch-account`

组件在 [SwitchAccount/index.tsx](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/experience/src/pages/SwitchAccount/index.tsx)。

**触发条件**：用户已有活跃会话，但魔法链接的 `login_hint` 与当前登录用户邮箱不匹配。

页面展示：
- 当前登录用户的头像和邮箱
- "Continue as [login_hint]" 按钮 → 跳转到 OneTimeToken 页面继续验证
- "Back to current account" 链接 → 返回上一页

### 8.7 完整链路图

```
┌────────────────────────────────────────────────────────────────────┐
│                    魔法链接完整链路（从点击到登录）                    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  用户点击魔法链接                                                    │
│  https://logto.dev/oidc/auth?...&one_time_token=xxx&login_hint=yy │
│                                                                    │
│                          ↓                                         │
│                                                                    │
│  [后端 koaConsentGuard]                                            │
│    ├── 提取 one_time_token + login_hint                            │
│    ├── 无效参数 → 正常授权流程                                      │
│    ├── 已有会话 + 邮箱不匹配 + 无 prompt=login → /switch-account    │
│    ├── checkOneTimeToken 失败 → /one-time-token?errorMessage=xxx  │
│    │     └── token_consumed + 当前邮箱匹配 → 放行(next)             │
│    └── 预检查通过 → 重定向到 /one-time-token                        │
│                                                                    │
│                          ↓                                         │
│                                                                    │
│  [前端 OneTimeToken 页面]                                          │
│    ├── 参数缺失 → /one-time-token/error                            │
│    ├── errorMessage 存在 → /one-time-token/error                   │
│    ├── Manual 条款 → 用户拒绝 → /one-time-token/error              │
│    └── 参数合法 → 继续                                              │
│                                                                    │
│                          ↓                                         │
│                                                                    │
│  [signInWithOneTimeToken API 调用]                                 │
│    1. initInteraction(SignIn) → PUT /experience                    │
│    2. POST /experience/verification/one-time-token/verify          │
│       → 校验并消费令牌 → 返回 verificationId                       │
│                                                                    │
│                          ↓                                         │
│                                                                    │
│  [submit: 尝试登录]                                                 │
│    identifyAndSubmitInteraction({ verificationId })                │
│      → POST /experience/identification                            │
│      → POST /experience/submit                                    │
│    ├── 成功 → redirectTo → 完成登录                                 │
│    └── user.user_not_exist → 注册兜底                               │
│                                                                    │
│                          ↓ (注册兜底)                               │
│                                                                    │
│  [registerWithOneTimeToken]                                        │
│    1. 条款校验（Manual 策略）                                       │
│    2. updateInteractionEvent(Register)                             │
│       → PUT /experience/interaction-event                          │
│       → guardInteractionEvent: 即使 signInMode=SignIn 也允许注册    │
│    3. identifyAndSubmitInteraction({ verificationId })             │
│       → POST /experience/identification                            │
│       → POST /experience/submit                                    │
│    └── 成功 → redirectTo → 完成注册并登录                           │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## 九、核心文件索引

### 9.1 One-Time Token 后端

| 文件 | 说明 |
|------|------|
| [one-time-tokens.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/one-time-tokens.ts) | Management API 路由 |
| [one-time-token.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/libraries/one-time-token.ts) | 核心业务逻辑库 |
| [one-time-tokens.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/queries/one-time-tokens.ts) | 数据库查询 |
| [one-time-token.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/verification-routes/one-time-token.ts) | Experience API 路由 |
| [one-time-token-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/classes/verifications/one-time-token-verification.ts) | Verification Record 实现 |
| [one-time-tokens.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/schemas/src/foundations/jsonb-types/one-time-tokens.ts) | 类型与状态枚举 |
| [one-time-token-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/schemas/src/types/verification-records/one-time-token-verification.ts) | Verification Record 数据类型 |

### 9.2 Verification Code 相关

| 文件 | 说明 |
|------|------|
| [verification-code.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/verification-code.ts) | Management API 路由 |
| [passcode.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/libraries/passcode.ts) | 核心业务逻辑库 |
| [verification-code.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/verification-routes/verification-code.ts) | Experience API 路由 |
| [verification-code-helpers.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/verification-routes/verification-code-helpers.ts) | 发送/验证辅助函数 |
| [code-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/classes/verifications/code-verification.ts) | Verification Record 实现 |

### 9.3 Verification Record 抽象层

| 文件 | 说明 |
|------|------|
| [verification-record.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/classes/verifications/verification-record.ts) | 抽象基类 |
| [verification-records-map.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/classes/verifications/verification-records-map.ts) | 记录集合管理 |
| [verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/libraries/verification.ts) | 持久化辅助函数 |
| [verification-records.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/queries/verification-records.ts) | 数据库查询 |
| [verification-type.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/schemas/src/types/verification-records/verification-type.ts) | 验证类型枚举 |

### 9.4 Experience Interaction

| 文件 | 说明 |
|------|------|
| [experience-interaction.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/classes/experience-interaction.ts) | 交互会话核心类 |
| [index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/index.ts) | Experience API 入口 |

### 9.5 魔法链接入口与中间件

| 文件 | 说明 |
|------|------|
| [koa-consent-guard.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/middleware/koa-consent-guard.ts) | 后端网关：令牌预检查、账户切换、错误重定向 |
| [sign-in-experience-validator.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/core/src/routes/experience/classes/libraries/sign-in-experience-validator.ts) | 交互事件校验（含 OneTimeToken 注册特权） |
| [oidc.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/schemas/src/consts/oidc.ts) | ExtraParamsKey 枚举定义 |
| [experience.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/schemas/src/consts/experience.ts) | Experience 路由常量 |

### 9.6 Experience SPA 前端

| 文件 | 说明 |
|------|------|
| [OneTimeToken/index.tsx](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/experience/src/pages/OneTimeToken/index.tsx) | 魔法链接落地页 |
| [Error.tsx](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/experience/src/pages/OneTimeToken/Error.tsx) | 魔法链接错误页 |
| [SwitchAccount/index.tsx](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/experience/src/pages/SwitchAccount/index.tsx) | 账户切换页 |
| [SignIn/index.tsx](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/experience/src/pages/SignIn/index.tsx) | 登录页（含 OneTimeToken 路由汇聚） |
| [Register/index.tsx](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/experience/src/pages/Register/index.tsx) | 注册页（含 OneTimeToken 路由汇聚） |
| [one-time-token.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/experience/src/apis/experience/one-time-token.ts) | signInWithOneTimeToken API |
| [index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/experience/src/apis/experience/index.ts) | registerWithVerifiedIdentifier API |
| [interaction.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/experience/src/apis/experience/interaction.ts) | 交互 API（init/identify/submit） |
| [App.tsx](file:///d:/fz/0601-2/solo-dogfeeding/code/68-logto/packages/experience/src/App.tsx) | SPA 路由定义 |

---

## 十、关键设计要点

### 10.1 幂等性与安全性

- **One-Time Token**：一次性使用，验证后立即标记为 Consumed
- **Verification Code**：一次性使用，验证后立即 consume
- **防重放**：已消费/已过期的令牌不能重复使用
- **防暴力破解**：Sentinel 防护、验证码尝试次数限制

### 10.2 分层架构

```
┌─────────────────────────┐
│   Experience API 层     │  ← 用户交互入口
├─────────────────────────┤
│  Verification Record 层 │  ← 统一验证抽象
├─────────────────────────┤
│   业务 Library 层       │  ← 核心业务逻辑
├─────────────────────────┤
│    Queries 数据层       │  ← 数据库操作
└─────────────────────────┘
```

### 10.3 状态隔离

- **One-Time Token**：独立的数据库表，Management API 管理
- **Passcode**：独立的数据库表，passcode 库管理
- **Verification Record**：统一存储在 verification_records 表，JSONB 格式
- **Interaction**：存储在 OIDC session 中，短期有效

### 10.4 扩展能力

One-Time Token 的 `context` 字段支持扩展上下文，目前支持：
- `jitOrganizationIds`: 组织 JIT（Just-In-Time）开通

未来可以在此基础上扩展更多魔法链接场景。
