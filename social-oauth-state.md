# 社交登录 state 参数全链路分析

本文档梳理 Logto 中社交登录（Social OAuth）流程里 `state` 参数从生成、回调校验到最终账号关联的完整实现路径。

---

## 一、State 生成阶段

### 1.1 前端随机生成（发起方）

**入口**：用户点击社交登录按钮 → [use-social.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/experience/src/containers/SocialSignInList/use-social.ts#L51-L116) 中 `invokeSocialSignInHandler`。

核心步骤：

```typescript
const state = generateState();          // 1. 生成随机字符串
storeState(state, connectorId);         // 2. 存入 sessionStorage
// 3. 调后端 API 拿授权 URL，state 随请求上送
const result = await asyncInvokeSocialSignIn(connectorId, state, redirectUri);
// 4. 同时写入 localStorage fallback 包（应对 App WebView session 丢失）
storeRedirectContext({ state, flow: 'social', connectorId, verificationId, ... });
```

#### 生成算法

在 [social-connectors.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/experience/src/utils/social-connectors.ts#L16-L24)：

- `generateState()` 调用通用 `generateRandomString()` 产出 UUID 级别随机串；
- `storeState()` 以 `social_auth_state:${connectorId}` 为 key 写入 `sessionStorage`。

### 1.2 后端授权 URI 构造（透传 + 附加会话）

**Experience API 入口**：[social-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/routes/experience/verification-routes/social-verification.ts#L31-L81) `POST /experience/verification/social/:connectorId/authorization-uri`

内部调用链：

1. `SocialVerification.create()` → 生成带唯一 `id`（即 `verificationId`）的记录。
2. `socialVerification.createAuthorizationUrl()` 按存储模式分流：
   - **Experience 模式（默认）**：调用 [social-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/libraries/verification-helpers/social-verification.ts#L26-L64) `createSocialAuthorizationUrl()`：
     - 从 OIDC `provider.interactionDetails()` 取当前交互的 `jti`；
     - 调 `connector.getAuthorizationUri(payload, setSession)`，`payload` 含 `state`、`redirectUri`、`connectorId`、`jti`、`scope`、`userAgent` 等；
     - `setSession` 回调通过 `assignConnectorSessionResult()` 把连接器返回的 session（含 `nonce`、`redirectUri`、`state` 等）写入 OIDC interaction result。
   - **Profile/Account 模式**：直接调用 `createSocialAuthorizationSession()`，session 存进 `SocialVerification.connectorSession` 自身，不依赖 OIDC interaction（见 [social-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/routes/experience/classes/verifications/social-verification.ts#L375-L403)）。

### 1.3 连接器内部：附加 nonce（仅 OIDC/SAML）

不同类型连接器对 state 的附加处理不同：

| 连接器类型 | state 透传 | 附加字段 | session 存储 | 典型实现 |
|---|---|---|---|---|
| **OAuth2** | ✅ 原样放到授权 URL | 无 | 仅存 `redirectUri` | [connector-oauth2/src/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/connectors/connector-oauth2/src/index.ts#L30-L49) |
| **OIDC** | ✅ 原样放到授权 URL | **`nonce`**（`generateStandardId()` 生成） | `{ nonce, redirectUri }` | [connector-oidc/src/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/connectors/connector-oidc/src/index.ts#L39-L75) |
| **SAML** | ✅ | SAMLRequest/RelayState | 含 jti 的 SAML session | connector-saml |

> **注意**：state **不会**在 `ConnectorSession` 中再次存储（OAuth2/OIDC 连接器均只保存 `redirectUri`/`nonce`，state 由前端独立管理）——这是两层校验设计：前端校验 state 防 CSRF，后端/连接器校验 nonce 防 ID Token 重放。

`ConnectorSession` 的 zod 定义见 [social.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/toolkit/connector-kit/src/types/social.ts#L76-L89)：

```typescript
export const connectorSessionGuard = z.object({
  nonce: z.string(),
  redirectUri: z.string(),
  connectorId: z.string(),
  connectorFactoryId: z.string(),
  jti: z.string(),
  state: z.string(),        // 字段存在，但大多数连接器并不写入
}).partial().catchall(z.unknown());
```

---

## 二、回调校验阶段

用户在第三方完成授权后被重定向回 `/callback/:connectorId` 或 `/callback/social/:connectorId`，进入校验流程。

### 2.1 前端 state 校验（含 session 丢失恢复）

**入口**：[use-redirect-callback-validation.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/experience/src/hooks/use-redirect-callback-validation.ts#L26-L98) `validateAndRestore(state)`

其基于 [social-connectors.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/experience/src/utils/social-connectors.ts#L43-L53) 的 `validateState()` 做三态判定：

```
URL 中的 state
    │
    ├─ undefined ──────────→ { valid: false, error: 'invalid_connector_auth' }
    │
    └─ validateState(state, connectorId) ──┬─ 'match'    ──→ ✅ 清 fallback，取 verificationId
                                           ├─ 'mismatch' ──→ ❌ 硬失败（疑似 CSRF），不查 fallback
                                           └─ 'missing'  ──→ 尝试 localStorage fallback
                                                                   │
                                                                   ├─ 无 fallback ──→ ❌ invalid_connector_auth
                                                                   ├─ flow/connector 不匹配 → ❌
                                                                   └─ 匹配 → 恢复 appId/organizationId/uiLocales
                                                                              → 还原 verificationId → ✅
```

**关键实现细节**：

1. `validateState()` 在比对后**立即删除** `sessionStorage` 中的 state（一次性使用）。
2. `'mismatch'` 与 `'missing'` 严格区分：前者说明 session 还在但值被篡改，绝不降级；后者通常发生在 iOS WebView 或 App 内嵌浏览器导致 `sessionStorage` 丢失，此时走 fallback。
3. fallback 包的写入在发起阶段 `storeRedirectContext()`，读取用 `consumeRedirectContext()`，内容含 state + flow + connectorId + verificationId + 若干上下文。

### 2.2 后端校验：verificationId + connector session + nonce

**入口**：前端 state 校验通过后，调 [social.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/experience/src/apis/experience/social.ts#L36-L44) `verifySocialVerification()` → [social-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/routes/experience/verification-routes/social-verification.ts#L83-L169) `POST /experience/verification/social/:connectorId/verify`

后端处理步骤：

**Step A — 定位 SocialVerification 记录**

- 若为 **Google One Tap**（`connectorData.credential` 存在）：直接创建新 `SocialVerification`（不依赖 verificationId），但需额外校验 cookie 中的 `g_csrf_token` 或外部 credential cookie。
- 否则：根据请求 body 的 `verificationId` 从当前 interaction 的 verification records 中取出对应记录，并断言 `connectorId` 一致。

**Step B — 调用 verify()**

进入 [social-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/routes/experience/classes/verifications/social-verification.ts#L419-L467) `verifySocialIdentity()`：

```
1. Google One Tap → Cookie CSRF 双重校验
2. 根据存储模式取 connector session：
   - 'interactionSession' → getConnectorSessionResult(ctx, provider)
     即从 OIDC interaction.result.connectorSession 取出并清除（一次性消费）
   - 'verificationRecord'  → this.connectorSession
3. 调用 getUserInfoWithOptionalTokenResponse(connectorId, connectorData, getSession)
   a. connector.getUserInfo(data, getSession) 或 getTokenResponseAndUserInfo()
   b. 对于 OIDC 连接器：
      - getSession() 返回 { nonce, redirectUri }
      - 用 redirectUri + code 换 token
      - 解析 ID Token，校验 nonce === id_token.nonce（重放防护）
4. 将 userInfo / encryptedTokenSet 写入 SocialVerification 实例（isVerified = true）
```

**Step C — 持久化并返回**

- `skipCaptcha()`：社交验证自带第三方信任，跳过图形验证码。
- `experienceInteraction.save()` 将 verification record 写回 interaction。
- 清除 Google One Tap 的临时 cookie。

### 2.3 连接器内部 nonce 校验（以 OIDC 为例）

[connector-oidc/src/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/connectors/connector-oidc/src/index.ts#L77-L151)：

```typescript
// 生成阶段（getAuthorizationUri）
const nonce = generateNonce();
await setSession({ nonce, redirectUri });

// 校验阶段（parseUserInfoFromIdToken）
if (nonce) {
  assert(validationNonce, 'Cannot find `nonce` in session storage.');
  assert(validationNonce === nonce, 'ID Token nonce mismatch.');
}
```

> **state vs nonce 的分工**：
> - `state` = 前端生成 + 前端校验，**防 CSRF**（保证回调请求来自自己发起的授权）；
> - `nonce` = 后端/连接器生成 + 后端校验，**防 ID Token 重放**（保证 token 是针对本次会话签发）；
> - 两者在不同层、不同代码路径，任一不匹配即失败。

---

## 三、账号关联阶段：三种绑定方式

state 本身不直接参与账号关联写入，但它是确保 `SocialVerification` 记录可信的前置门槛。只有通过 state + nonce 双重校验、`isVerified = true` 的记录，才能用于后续的身份查找与绑定。

Logto 中社交身份与用户账号的绑定存在**三种典型方式**，各自的触发条件、验证记录依赖和实现路径各不相同。

### 3.1 方式一：默认绑定（新用户注册时自动绑定）

**触发条件**：

- 社交身份（target + id）在系统中不存在；
- 社交返回的邮箱/手机号也不匹配任何现有用户；
- 注册模式开启（`SignInMode.SignInAndRegister`）。

**验证记录依赖**：

- **仅需 1 条** `SocialVerification` 记录（`isVerified = true`）。

**核心流程**：

前端入口：[use-social-register.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/experience/src/hooks/use-social-register.ts) → `registerWithVerifiedIdentifier(verificationId)`

后端调用链：

```
POST /experience/register
    │
    ├─ experienceInteraction.createUser(socialVerificationId)
    │     │
    │     ├─ getNewUserProfileFromVerificationRecord()
    │     │    ├─ verificationRecord.toUserProfile()
    │     │    │    → { socialIdentity: { target, userInfo } }
    │     │    ├─ verificationRecord.toSyncedProfile(true)
    │     │    │    → { name, avatar, primaryEmail, primaryPhone }
    │     │    └─ socialConnectorTokenSetSecret
    │     │
    │     ├─ profile.setProfileWithValidation()           // 唯一校验
    │     ├─ profile.assertUserMandatoryProfileFulfilled() // 必填字段校验
    │     └─ provisionLibrary.createUser(profile)
    │          └─ insertUser({ ..., identities: toUserSocialIdentityData(socialIdentity) })
    │              // identities[target] = { userId: userInfo.id, details: userInfo }
    │
    └─ 返回 redirectTo → 完成注册并登录
```

**关键实现细节**：

1. `createUser()` 方法在 [experience-interaction.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L273-L315) 中定义，仅在 `InteractionEvent.Register` 事件下可用。
2. 新用户创建时 social identity 与 profile 数据一起通过 `insertUser` 写入 `identities` 字段，见 [provision-library.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/routes/experience/classes/libraries/provision-library.ts#L58-L136)。
3. 如果连接器启用了 token storage，`socialConnectorTokenSetSecret` 也会在创建用户后一起 upsert 到 secrets 表。

---

### 3.2 方式二：关联用户绑定（Linking Flow）

**触发条件**：

- 社交身份（target + id）在系统中不存在；
- 但社交返回的 email / phone **已绑定到某个已有用户**（`findSocialRelatedUser()` 命中）。

该方式又根据 `automaticAccountLinking` 开关分为**自动绑定**和**手动绑定**两条子路径，两者的**验证记录依赖完全不同**。

#### 3.2.1 自动绑定（`automaticAccountLinking = true`）

**验证记录依赖**：

- **仅需 1 条** `SocialVerification` 记录（`isVerified = true`）。
- 不需要额外的邮箱/手机验证记录——目标用户完全由社交 identity 自身携带的 email/phone 推导得出。

**核心实现**：

前端入口：[use-social-sign-in-listener.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/experience/src/pages/SocialSignInWebCallback/use-social-sign-in-listener.ts#L59-L106)

```typescript
const accountNotExistErrorHandler = useCallback(async (error) => {
  const { relatedUser } = error.data ?? {};
  const verificationId = verificationIdRef.current;
  if (relatedUser) {
    if (socialSignInSettings.automaticAccountLinking) {
      // 直接用已有的 socialVerificationId 完成绑定
      await bindSocialRelatedUser(verificationId);
    } else {
      navigate(`/social/link/${connectorId}`, { replace: true, state: { relatedUser } });
    }
  }
  // ...
});
```

后端实现：[social.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/experience/src/apis/experience/social.ts#L46-L50)

```typescript
export const bindSocialRelatedUser = async (verificationId: string) => {
  await updateInteractionEvent(InteractionEvent.SignIn);
  // 关键：linkSocialIdentity = true，用 socialVerification 自身的 email/phone 找关联用户
  await identifyUser({ verificationId, linkSocialIdentity: true });
  return submitInteraction();
};
```

后端 identity 查找与写入——[helpers.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/routes/experience/classes/helpers.ts#L147-L159)：

```typescript
case VerificationType.Social: {
  const user = linkSocialIdentity
    ? await verificationRecord.identifyRelatedUser() // 仅用 socialUserInfo 的 email/phone 找用户
    : await verificationRecord.identifyUser();       // 按社交 identity 找用户
  const syncedProfile = {
    ...(await verificationRecord.toSyncedProfile()),
    // 关键：自动绑定时追加 socialIdentity 到 profile，一并写入
    ...conditional(linkSocialIdentity && (await verificationRecord.toUserProfile())),
    socialConnectorTokenSetSecret: await verificationRecord.getTokenSetSecret(),
  };
  return { user, syncedProfile };
}
```

`identifyRelatedUser()` 内部通过 [social.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/libraries/social.ts#L161-L181) `findSocialRelatedUser()` 按优先级 `phone → email` 查找已存在的用户。

之后 [experience-interaction.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/routes/experience/classes/experience-interaction.ts#L212-L258) 的 `identifyUser()` 方法将 `syncedProfile` 写入 `this.profile`，最终在 `submitInteraction` 时把 social identity merge 进目标用户的 `user.identities`。

#### 3.2.2 手动绑定（`automaticAccountLinking = false`）

**验证记录依赖**：

- **必须 2 条**验证记录，缺一不可：
  1. `SocialVerification` — 待绑定的社交身份（`isVerified = true`）；
  2. `EmailVerificationCode` 或 `PhoneVerificationCode` — 证明用户实际拥有目标账号的邮箱或手机号。

**核心流程**：

```
SocialVerification.identifyUser() 抛 user.identity_not_exist（带 relatedUser）
         │
         ▼
automaticAccountLinking = false → 跳转 /social/link/:connectorId 页面
         │
         ▼
用户使用邮箱/手机完成验证码验证 → 生成 identifierVerificationId
         │
         ▼
调用 signInAndLinkWithSocial(identifierVerificationId, socialVerificationId)
         │
         ├─ identifyUser({ verificationId: identifierVerificationId })
         │    └─ 用 Email/Phone 验证记录定位目标用户
         │
         ├─ updateProfile({ type: 'social', verificationId: socialVerificationId })
         │    └─ 将社交身份追加到该用户的 profile.socialIdentity
         │
         └─ submitInteraction()
              └─ 合并写入 user.identities
```

关键 API：[signInAndLinkWithSocial](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/experience/src/apis/experience/social.ts#L86-L94)

```typescript
export const signInAndLinkWithSocial = async (
  verificationId: string,           // 邮箱/手机验证码的 verificationId
  socialVerificationId: string      // 社交身份的 verificationId
) => {
  await updateInteractionEvent(InteractionEvent.SignIn);
  await identifyUser({ verificationId });                           // 用标识符找到目标用户
  await updateProfile({ type: 'social', verificationId: socialVerificationId }); // 追加社交身份
  return submitInteraction();
};
```

页面入口：[SocialLinkAccount](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/experience/src/pages/SocialLinkAccount/index.tsx)

---

### 3.3 方式三：My Account 主动绑定

**触发条件**：

- 用户已登录（已通过身份认证）；
- 在账号中心（My Account / Account Center）主动发起社交身份绑定操作；
- 账号中心 social 字段可编辑（`AccountCenterControlValue.Edit`）。

**验证记录依赖**：

- **1 条** `SocialVerification` 记录（通过独立的 verification API 创建并持久化到 `verification_records` 表，不依赖 Experience interaction）；
- 可选：**安全验证记录**（如密码或邮箱二次验证），取决于账号安全策略（`assertIdentityVerifiedIfRequired`）。

---

#### 3.3.1 验证记录生命周期三阶段

My Account 场景下的 `SocialVerification` 有清晰的三阶段生命周期，每个阶段对数据库的操作不同：

```
  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
  │  创建阶段   │────▶│  校验阶段   │────▶│  绑定阶段   │
  │  insert DB  │     │  read+update│     │  read only  │
  └─────────────┘     └─────────────┘     └─────────────┘
```

##### 阶段一：创建（插入数据库）

**入口 API**：`POST /api/verifications/social` —— [verification/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/routes/verification/index.ts#L188-L225)

```typescript
router.post(`${verificationApiPrefix}/social`, ..., async (ctx, next) => {
  const { connectorId, ...rest } = ctx.guard.body;

  // 1. 内存中创建 SocialVerification 实例
  const socialVerification = SocialVerification.create(libraries, queries, connectorId);

  // 2. 生成授权 URL（session 写入 verificationRecord.connectorSession）
  const authorizationUri = await socialVerification.createAuthorizationUrl(
    ctx, tenantContext, rest, 'verificationRecord'  // 存储模式：verificationRecord
  );

  // 3. 插入 verification_records 表
  const { expiresAt } = await insertVerificationRecord(socialVerification, queries);

  ctx.body = { verificationRecordId, authorizationUri, expiresAt };
  ctx.status = 201;
});
```

数据库插入实现：[verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/libraries/verification.ts#L71-L85)

```typescript
export const insertVerificationRecord = async (verificationRecord, queries, userId?) => {
  const { id, ...rest } = verificationRecord.toJson();
  return queries.verificationRecords.insert({
    id,
    userId,        // My Account social 场景不填 userId（新标识符验证）
    data: rest,    // 包含 connectorId、type、connectorSession 等
    expiresAt: new Date(Date.now() + expirationTime).valueOf(),
  });
};
```

> **注意**：此阶段是整个生命周期中**唯一一次写入（insert）**操作。`connectorSession` 随记录一起落库，供后续阶段消费。

##### 阶段二：校验（按 id 读取 + 更新）

**入口 API**：`POST /api/verifications/social/verify` —— [verification/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/routes/verification/index.ts#L227-L262)

```typescript
router.post(`${verificationApiPrefix}/social/verify`, ..., async (ctx, next) => {
  const { connectorData, verificationRecordId } = ctx.guard.body;

  // 1. 按 id 从 verification_records 表中读出并重建 SocialVerification 实例
  const socialVerification = await buildVerificationRecordByIdAndType({
    type: VerificationType.Social,
    id: verificationRecordId,
    queries,
    libraries,
  });

  // 2. 执行身份校验（连接器 getUserInfo → 填充 socialUserInfo / encryptedTokenSet）
  await socialVerification.verify(ctx, tenantContext, connectorData, 'verificationRecord');

  // 3. 更新回数据库（isVerified = true，socialUserInfo 等已写入 data 字段）
  await updateVerificationRecord(socialVerification, queries);

  ctx.body = { verificationRecordId };
});
```

读取实现：[verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/libraries/verification.ts#L17-L43)

```typescript
const getVerificationRecordById = async ({ id, queries, libraries, userId }) => {
  const record = await queries.verificationRecords.findActiveVerificationRecordById(id);
  assertThat(record, 'verification_record.not_found');
  if (userId) {
    assertThat(record.userId === userId, 'verification_record.not_found');
  }
  const result = verificationRecordDataGuard.safeParse({ ...record.data, id: record.id });
  assertThat(result.success, 'verification_record.not_found');
  return buildVerificationRecord(libraries, queries, result.data);
};
```

> **注意**：此阶段先**按 id 读取**验证记录，完成 verify 后再**更新**（update）回数据库。`findActiveVerificationRecordById` 会检查 `expiresAt`，过期记录直接报 not found。

##### 阶段三：绑定（按 id 读取，只读）

**入口 API**：`POST /api/my-account/identities` / `PUT /api/my-account/identities` —— [identities.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/routes/account/identities.ts#L46-L105)

绑定阶段只做**只读读取**，不修改验证记录本身：

```typescript
const linkSocialIdentityCore = async ({
  user,
  newIdentifierVerificationRecordId,
  allowReplace,
  ...
}) => {
  // 1. 按 id 从 verification_records 表中读出验证记录（只读）
  const newVerificationRecord = await buildVerificationRecordByIdAndType({
    type: VerificationType.Social,
    id: newIdentifierVerificationRecordId,
    queries,
    libraries,
  });

  // 2. 强校验：必须已通过 verify 阶段
  assertThat(newVerificationRecord.isVerified, 'verification_record.not_found');

  // 3. 取出社交身份信息（来自阶段二写入的 socialUserInfo）
  const { socialIdentity: { target, userInfo } } = await newVerificationRecord.toUserProfile();

  // 4. identity 冲突校验
  await checkIdentifierCollision({ identity: { target, id: userInfo.id } }, user.id);

  // 5. 写入目标用户的 identities 字段（操作 users 表，非 verification_records 表）
  const currentUser = await findUserById(user.id);
  const existingIdentity = currentUser.identities[target];
  if (!allowReplace) {
    assertThat(!existingIdentity, 'user.identity_already_in_use');
  }
  const updatedUser = await updateUserById(user.id, {
    identities: {
      ...currentUser.identities,
      [target]: { userId: userInfo.id, details: userInfo },
    },
  });

  // 6. 可选：upsert token set secret
  const tokenSetSecret = await newVerificationRecord.getTokenSetSecret();
  if (tokenSetSecret) {
    await trySafe(async () => upsertSocialTokenSetSecret(user.id, tokenSetSecret));
  }
};
```

> **关键理解**：
> - 绑定阶段**仅读取**验证记录（`findActiveVerificationRecordById`），不会调用 `updateVerificationRecord`；
> - 验证记录在整个生命周期中只经历 **一次 insert（创建） + 一次 update（校验）**，之后一直处于只读状态；
> - 绑定操作的写入发生在 `users.identities` 字段和 `user_social_connectors` 表（token storage），与 `verification_records` 表无关。

---

#### 3.3.2 前端调用流程

**前端**：[SocialCallback](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/account/src/pages/SocialCallback/index.tsx)

```
用户在账号中心点击"添加社交账号"
    │
    ▼
  阶段一：创建验证记录
    │
    ├─ createSocialVerification(accessToken, { connectorId, state, redirectUri })
    │   → POST /api/verifications/social
    │   → 返回 { verificationRecordId, authorizationUri, expiresAt }
    │
    ├─ state 存入 accountStorage.socialFlow（含 verificationRecordId）
    │
    ▼
  跳转到第三方授权
    │
    ▼
  阶段二：校验验证记录
    │
    ├─ 回调 /social/callback/:connectorId?state=xxx&code=xxx
    │
    ├─ 前端校验 state（与 accountStorage 中存储的值比对）
    │
    └─ verifySocialVerification(accessToken, { verificationRecordId, connectorData })
        → POST /api/verifications/social/verify
        → 验证通过，isVerified = true
    │
    ▼
  阶段三：绑定到用户
    │
    └─ linkSocialIdentity(accessToken, verificationId, socialVerificationRecordId)
        → POST /api/my-account/identities
        → body: { newIdentifierVerificationRecordId: socialVerificationRecordId }
        → 从 verification_records 读出 → 写入 users.identities
```

---

#### 3.3.3 安全验证与操作接口

**安全验证要求**：根据账号安全策略，可能需要用户先完成身份验证（密码或邮箱验证码），通过 `assertIdentityVerifiedIfRequired()` 检查请求头 `verification_id` 传入的验证记录。

三种操作接口：

- `POST /api/my-account/identities` — 新增绑定（`allowReplace: false`）
- `PUT /api/my-account/identities` — 替换绑定（`allowReplace: true`）
- `DELETE /api/my-account/identities/:target` — 解绑

---

#### 3.3.4 三阶段操作总表

| 阶段 | API | 数据库操作 | 关键函数 | 记录状态变化 |
|---|---|---|---|---|
| **创建** | `POST /verifications/social` | `INSERT` | `insertVerificationRecord()` | 新建 → 未校验（带 connectorSession） |
| **校验** | `POST /verifications/social/verify` | `SELECT` + `UPDATE` | `buildVerificationRecordByIdAndType()` → `verify()` → `updateVerificationRecord()` | 未校验 → 已校验（填充 socialUserInfo） |
| **绑定** | `POST/PUT /my-account/identities` | `SELECT`（只读） | `buildVerificationRecordByIdAndType()` → 断言 `isVerified` → 写入 users.identities | 保持已校验（只读消费） |

---

### 3.4 三种绑定方式对比

| 维度 | 默认绑定（注册时） | 关联用户绑定-自动 | 关联用户绑定-手动 | My Account 主动绑定 |
|---|---|---|---|---|
| **触发场景** | 新用户首次社交登录注册 | 社交 identity 不存在但 email/phone 已被占用 + automaticAccountLinking=true | 社交 identity 不存在但 email/phone 已被占用 + automaticAccountLinking=false | 已登录用户在账号中心主动添加 |
| **验证记录数** | 1 条（SocialVerification） | 1 条（SocialVerification） | 2 条（SocialVerification + Email/Phone 验证） | 1 条（SocialVerification） + 可选安全验证 |
| **目标用户定位依据** | N/A（创建新用户） | 社交身份自身携带的 email/phone | 独立的邮箱/手机验证码验证 | 当前已登录用户（ctx.auth） |
| **交互上下文** | Experience Interaction（OIDC interaction） | Experience Interaction（OIDC interaction） | Experience Interaction（OIDC interaction） | Account API（独立 verification records 表） |
| **identity 写入时机** | 创建用户时一并写入 | submitInteraction 阶段 merge 到已有用户 | submitInteraction 阶段 merge 到已有用户 | 直接 updateUserById 写入 identities |
| **关键 API** | POST /experience/register | identifyUser(linkSocialIdentity=true) + submitInteraction | identifyUser + updateProfile + submitInteraction | POST/PUT /api/my-account/identities |
| **token storage** | 支持（创建用户后 upsert） | 支持（syncedProfile 携带） | 支持（syncedProfile 携带） | 支持（linkSocialIdentityCore 内 upsert） |
| **state 校验方** | 前端 sessionStorage + 后端 nonce | 前端 sessionStorage + 后端 nonce | 前端 sessionStorage + 后端 nonce | 前端 accountStorage + 后端 nonce |

---

### 3.5 SocialVerification 记录的数据结构

[social-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/schemas/src/types/verification-records/social-verification.ts)：

```typescript
type SocialVerificationRecordData = {
  id: string;                    // verificationId，贯穿生成→校验→关联
  connectorId: string;
  type: VerificationType.Social;
  socialUserInfo?: SocialUserInfo;     // 校验成功后填充，关联操作的数据源
  encryptedTokenSet?: EncryptedTokenSet; // 可选：加密的 access_token/refresh_token
  connectorSession?: ConnectorSession;  // 可选：profile 模式会话（experience 模式存 OIDC interaction）
};
```

**两种存储模式**：

- **Experience 模式**：`connectorSession` 存放在 OIDC `interaction.result.connectorSession`（兼容 SAML ACS 等依赖 jti 的连接器）；
- **Profile/Account 模式**：`connectorSession` 存放在 verificationRecord 自身内（不依赖 OIDC interaction，适合 My Account 等独立 API 场景）。

---

## 四、端到端调用链总览

```
[用户点击社交按钮]
        │
        ▼
use-social.ts : generateState() ──→ sessionStorage + localStorage(fallback)
        │
        ▼
POST /experience/verification/social/:id/authorization-uri
        │
        ├─ SocialVerification.create() → 生成 verificationId
        ├─ getAuthorizationUri(payload, setSession)
        │     ├─ 前端 state 透传进授权 URL
        │     └─ OIDC: 生成 nonce → setSession → 写入 interaction.result
        ├─ verificationRecord 存 interaction
        └─ 返回 { authorizationUri, verificationId }
        │
        ▼
[用户跳转第三方授权]
        │
        ▼
/callback/:connectorId?state=xxx&code=xxx
        │
        ├─ use-redirect-callback-validation.validateAndRestore()
        │     ├─ sessionStorage 校验 state (match/mismatch/missing)
        │     └─ missing → localStorage fallback + flow/connector 归属校验
        │
        ▼
POST /experience/verification/social/:id/verify { connectorData, verificationId }
        │
        ├─ 按 verificationId 取 SocialVerification
        ├─ Google One Tap → Cookie CSRF 校验
        ├─ 取出 connectorSession
        │     ├─ experience: interaction.result.connectorSession
        │     └─ profile: verificationRecord.connectorSession
        ├─ connector.getUserInfo(connectorData, getSession)
        │     └─ OIDC: nonce 二次校验（防 ID Token 重放）
        ├─ 填充 socialUserInfo + encryptedTokenSet (isVerified = true)
        └─ 保存 interaction
        │
        ▼
identifyAndSubmitInteraction / signInAndLinkWithSocial
        │
        ├─ identifyUser()
        │     ├─ findUserByIdentity(target, id) → 直接登录（路径一）
        │     └─ findSocialRelatedUser() → linking flow（路径二）
        │
        └─ updateProfile + submitInteraction → 完成 identity 写入
```

---

## 五、关键安全设计总结

| 机制 | 职责 | 所在层 | 代码位置 |
|---|---|---|---|
| **state** | 防 CSRF，保证回调是自己发起的 | 浏览器 `sessionStorage` | [social-connectors.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/experience/src/utils/social-connectors.ts) |
| **localStorage fallback** | 应对 App WebView session 丢失 | 浏览器 `localStorage` | [social-redirect-fallback-context.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/experience/src/utils/social-redirect-fallback-context.ts) + [use-redirect-callback-validation.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/experience/src/hooks/use-redirect-callback-validation.ts) |
| **nonce** | 防 ID Token 重放 | 连接器 session（OIDC interaction 或 verificationRecord） | [connector-oidc/src/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/connectors/connector-oidc/src/index.ts) |
| **Google One Tap CSRF** | Google One Tap 专用 CSRF | Cookie + `connectorData` | [social-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/routes/experience/classes/verifications/social-verification.ts#L427-L443) |
| **verificationId 归属校验** | 确保 connectorId 与 record 匹配 | 后端 | [social-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/routes/experience/verification-routes/social-verification.ts#L146-L149) |
| **identity 唯一约束** | 防止同一社交账号绑到多用户 | 数据库层 + [routes-me/social.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/routes-me/social.ts#L123-L129) | `hasUserWithIdentity` 前置检查 |
