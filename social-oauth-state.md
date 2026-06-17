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

## 三、账号关联阶段

state 本身不直接参与账号关联写入，但它是确保 `SocialVerification` 记录可信的前置门槛。只有通过 state + nonce 双重校验、`isVerified = true` 的记录，才能用于后续的身份查找与绑定。

### 3.1 路径一：直接登录（identity 已存在）

[social-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/routes/experience/classes/verifications/social-verification.ts#L180-L203) `identifyUser()`：

```
findUserBySocialIdentity()
  = queries.users.findUserByIdentity(target, socialUserInfo.id)
        │
        ├─ 找到用户 → 返回 User → identifyAndSubmitInteraction 完成登录
        └─ 未找到 → 尝试 findSocialRelatedUser() 走路径二
```

### 3.2 路径二：基于邮箱/手机的 Linking Flow

当社交 identity 不存在，但返回的 email/phone 已在系统中绑到其他账号时：

1. `identifyUser()` 抛 `user.identity_not_exist`，payload 带 `relatedUser: { type, value }`；
2. 前端跳转 [SocialLinkAccount](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/experience/src/pages/SocialLinkAccount/index.tsx) 页面，要求用户用该邮箱/手机做二次验证；
3. 用户完成邮箱/手机验证，产生 `identifierVerificationId`；
4. 调 [signInAndLinkWithSocial()](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/experience/src/apis/experience/social.ts#L86-L94)：
   ```typescript
   await identifyUser({ verificationId: identifierVerificationId });  // 找到目标用户
   await updateProfile({ type: 'social', verificationId: socialVerificationid }); // 写入 identity
   return submitInteraction();
   ```
5. `updateProfile` 内部将 social identity（target + userInfo.id + details）合并进 `user.identities`。

### 3.3 路径三：控制台/My Account 主动关联

不依赖 Experience 的 OIDC interaction，直接走独立 API：

**后端路由**：[routes-me/social.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/core/src/routes-me/social.ts)

1. `POST /me/social/authorization-uri` — 由客户端自己生成 state + redirectUri，后端仅透传给连接器（**注意**：此处 `jti` 传空串，仅支持 Google/GitHub 这类不依赖 session 的连接器）。
2. `POST /me/social/link-identity` — 回调成功后，携带 `connectorData`：
   ```typescript
   const socialUserInfo = await connector.getUserInfo(connectorData, notImplemented);
   await updateUserById(userId, {
     identities: {
       ...user.identities,
       [target]: { userId: socialUserInfo.id, details: socialUserInfo },
     },
   });
   ```
3. `DELETE /me/social/identity/:connectorId` — 解绑。

### 3.4 SocialVerification 记录的数据结构

[social-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/22-logto/packages/schemas/src/types/verification-records/social-verification.ts)：

```typescript
type SocialVerificationRecordData = {
  id: string;                    // verificationId，贯穿生成→校验→关联
  connectorId: string;
  type: VerificationType.Social;
  socialUserInfo?: SocialUserInfo;  // 校验成功后填充，关联操作的数据源
  encryptedTokenSet?: EncryptedTokenSet; // 可选：存储加密的 access_token/refresh_token
  connectorSession?: ConnectorSession;  // 可选：profile 模式会话（experience 模式存 interaction）
};
```

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
