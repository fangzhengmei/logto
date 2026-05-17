# 外部身份连接器错误处理拦截链架构调研

## 概述

本文档梳理 Logto 系统中外部身份连接器（社交连接器 / 企业 SSO 连接器）在握手（handshake）和回调（callback）阶段的实际错误分流路径，明确哪些错误会走连接器翻译层、哪些会在业务层直接转成通用错误，并说明这对状态码与用户可见信息的影响。

---

## 核心结论速览

| 连接器类型 | 阶段 | 回调地址 | 经过连接器翻译层 | 状态码 |
|-----------|------|---------|----------------|--------|
| **社交连接器** | 握手（getAuthorizationUrl） | N/A | ✅ 是 | 精细映射（400/401/429 等） |
| **社交连接器** | 回调（verify） | N/A | ✅ 是 | 精细映射 |
| **社交 SAML 连接器** | ACS 回调 | `/authn/saml/:connectorId` | ✅ 是 | 精细映射 |
| **企业 SSO 连接器** | 握手（getAuthorizationUrl） | N/A | ❌ 否 | 硬编码 **500** |
| **企业 SSO 连接器** | 回调（verify） | N/A | ❌ 否 | 硬编码 **500** |
| **企业 SSO SAML 连接器** | ACS 回调 | `/authn/single-sign-on/saml/:connectorId` | ✅ 是（连接器错误） | 精细映射（连接器错误）+ 多个 404 分支（业务错误） |

---

## 整体架构分层

```
┌─────────────────────────────────────────────────────────┐
│  前端体验层 (Experience Layer)                          │
│  - 接收 API 响应，展示用户友好提示                       │
└─────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────────────────────────────────┐
│  通用错误处理层 (General Error Handler)                 │
│  - koa-error-handler.ts                                 │
│  - 捕获 RequestError，调用 toBody() 生成响应             │
│  - 决定向终端用户暴露什么信息（i18n 翻译）               │
└─────────────────────────────────────────────────────────┘
                              ▲
                              │
        ┌─────────────────────┴─────────────────────┐
        │                                           │
        ▼                                           ▼
┌─────────────────────┐                   ┌─────────────────────┐
│  OIDC 错误处理层    │                   │  业务逻辑层         │
│  (部分路径经过)     │                   │  (部分路径直接处理) │
│  - koa-oidc-error-  │                   │  - single-sign-on.ts│
│    handler.ts       │                   │  - 捕获 Connector- │
│  - 处理 oidc-       │                   │    Error 并直接转   │
│    provider 内置错误│                   │    为 RequestError  │
│  - SessionNotFound  │                   │  - 状态码硬编码 500 │
│    映射为 404       │                   │                     │
└─────────────────────┘                   └─────────────────────┘
        ▲                                           ▲
        │                                           │
        ▼                                           ▼
┌─────────────────────┐                   ┌─────────────────────┐
│  连接器错误翻译层   │                   │  业务逻辑层         │
│  (仅部分路径经过)   │                   │  (部分路径直接抛出) │
│  - koa-connector-   │                   │  - authn.ts (SAML)  │
│    error-handler.ts │                   │  - 抛出 Request-    │
│  - 捕获 Connector-  │                   │    Error (404 等)   │
│    Error，翻译为    │                   │                     │
│    RequestError     │                   │                     │
└─────────────────────┘                   └─────────────────────┘
        ▲                                           ▲
        │                                           │
        └─────────────────────┬─────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│  连接器实现层 (Connector Implementation)               │
│  - SamlConnector / OidcConnector / 各社交连接器         │
│  - 抛出原始 ConnectorError / SsoConnectorError          │
│  - 包含详细调试信息（metadata、config、error 等）        │
└─────────────────────────────────────────────────────────┘
```

---

## 各层详细职责

### 第 1 层：连接器实现层

**位置**：`packages/core/src/sso/` 下各连接器实现

**核心职责**：
- 在握手（获取授权 URL）和回调（验证身份）阶段，遇到协议错误、配置错误、网络错误等问题时，**抛出原始错误**
- 错误类型：
  - `ConnectorError`（来自 `@logto/connector-kit`）- 通用连接器错误
  - `SsoConnectorError` - SSO 连接器专用错误，继承自 `ConnectorError`

**关键代码**：
- `SamlConnector.ts` 中 `getIdentityProvider()` 遇到无效 XML metadata 时抛出 `SsoConnectorError`
- `OidcConnector.ts` 中 `getUserInfo()` 遇到缺失 access token 时抛出 `SsoConnectorError`
- `SamlConnector/utils.ts` 中 `handleSamlAssertion()` 解析 SAML 断言失败时抛出 `SsoConnectorError(AuthorizationFailed)`
- 错误数据包含详细调试信息：`metadata`、`config`、原始 `error` 对象等

**错误码定义**（`SsoConnectorErrorCodes`）：
```typescript
InvalidMetadata        // 元数据无效
InvalidConfig          // 配置无效
InvalidCertificate     // 证书无效
AuthorizationFailed    // 授权失败
InvalidResponse        // 响应无效
InvalidRequestParameters // 请求参数无效
```

---

### 第 2 层：连接器错误翻译层（仅部分路径经过）

**位置**：`packages/core/src/middleware/koa-connector-error-handler.ts`

**挂载位置**：`Tenant.ts:128`，在所有路由之前全局挂载

**核心职责**：
- **统一捕获**所有未被业务层捕获的 `ConnectorError` 类型错误
- **翻译**为系统统一的 `RequestError` 类型
- **映射**错误码到标准格式：`connector.${code}`
- **精细决定**HTTP 状态码：
  - 400：配置错误、参数错误、元数据错误等
  - 401：授权失败、token 无效等
  - 429：限流超限
  - 501：未实现
  - 400：默认兜底

**关键代码片段**：
```typescript
switch (code) {
  case ConnectorErrorCodes.InvalidMetadata:
  case ConnectorErrorCodes.InvalidConfig:
  case ConnectorErrorCodes.InvalidCertificate:
  case ConnectorErrorCodes.InvalidResponse: {
    throw new RequestError({ code: `connector.${code}`, status: 400 }, data);
  }
  case ConnectorErrorCodes.AuthorizationFailed: {
    throw new RequestError({ code: `connector.${code}`, status: 401 }, data);
  }
  // ...
}
```

---

### 第 3 层：OIDC 错误处理层（仅 oidc-provider 内置错误经过）

**位置**：`packages/core/src/middleware/koa-oidc-error-handler.ts`

**挂载位置**：`Tenant.ts:126`，在 `koa-error-handler` 之后、`koa-connector-error-handler` 之前

**核心职责**：
- 专门处理 `oidc-provider` 内置的 `OIDCProviderError` 类型错误
- 将 `SessionNotFound` 等错误映射为 Logto 统一的错误码格式
- 对 `SessionNotFound` 错误，通过错误描述文本匹配（包含 "session" 和 "not found"），将错误码转为 `session.not_found`，状态码 404

**关键代码片段**：
```typescript
const isSessionNotFound = (description?: string) =>
  Boolean(
    ['session', 'not found'].every((word) => description?.includes(word)) ||
      description?.includes('authorization request has expired')
  );

// 在错误处理中：
const code = isSessionNotFound(data.error_description)
  ? 'session.not_found'
  : `oidc.${data.error}`;
```

**SessionNotFound 错误完整响应**：
```typescript
{
  code: 'session.not_found',
  message: 'Session not found.',  // 经 i18n 翻译
  error: 'SessionNotFound',       // oidc-provider 原始错误名
  error_description: 'interaction session not found',
  error_uri: undefined
}
```

---

### 第 4 层：业务逻辑层（部分路径直接处理）

**位置**：
- `packages/core/src/routes/interaction/utils/single-sign-on.ts`（企业 SSO 专用）
- `packages/core/src/routes/interaction/utils/social-verification.ts`（社交连接器用）
- `packages/core/src/routes/authn.ts`（SAML ACS 回调端点）

**核心职责**：
- 调用连接器 API 执行实际的握手和回调逻辑
- 组装业务数据（如 connector session、user info 等）
- 在 SAML ACS 路径中，业务逻辑会直接抛出多个 404 分支的 `RequestError`

**⚠️  关键差异：社交连接器 vs 企业 SSO 连接器**

#### 社交连接器路径（无 try-catch）：
`createSocialAuthorizationUrl()` 和 `verifySocialIdentity()` 中**没有** try-catch 捕获 `ConnectorError`，错误直接冒泡到中间件层。

```typescript
// social-verification.ts - 无 try-catch
export const createSocialAuthorizationUrl = async (...) => {
  const connector = await getLogtoConnectorById(connectorId);
  // ...
  return connector.getAuthorizationUri(...); // 错误直接抛出
};
```

#### 企业 SSO 连接器握手/回调路径（有 try-catch）：
`getSsoAuthorizationUrl()` 和 `verifySsoIdentity()` 中**有** try-catch 捕获 `ConnectorError`，**直接转换为 RequestError**，状态码硬编码为 500。

```typescript
// single-sign-on.ts - 有 try-catch，硬编码 500
export const getSsoAuthorizationUrl = async (...) => {
  try {
    const connectorInstance = new ssoConnectorFactories[providerName].constructor(...);
    return await connectorInstance.getAuthorizationUrl(...);
  } catch (error: unknown) {
    if (error instanceof ConnectorError) {
      throw new RequestError(
        { code: `connector.${error.code}`, status: 500 }, // ⚠️ 硬编码 500
        error.data
      );
    }
    throw error;
  }
};
```

**问题**：
1. 状态码硬编码为 500，绕过了中间件层的精细状态码映射（如 `AuthorizationFailed` 应为 401）
2. 与中间件层的错误处理逻辑重复
3. 由于错误被重新抛出为 `RequestError`，中间件层不会再处理它

---

### 第 5 层：通用错误处理层

**位置**：`packages/core/src/middleware/koa-error-handler.ts`

**挂载位置**：`Tenant.ts:125`，最外层中间件

**核心职责**：
- **最终**决定向终端用户暴露什么信息
- 捕获 `RequestError`，调用 `toBody(ctx.i18n)` 生成响应体
- `toBody()` 方法使用 i18n 系统将错误码翻译为用户可读的本地化消息
- 对非 `RequestError`、非 `HttpError`、非 `SyntaxError` 的错误，统一返回 500 和 "Internal server error."
- 敏感的调试数据（如原始 error 对象、详细 config）通过 `data` 字段传递

**关键代码**：
```typescript
if (error instanceof RequestError) {
  ctx.status = error.status;
  ctx.body = error.toBody(ctx.i18n);
  return;
}

// Koa will handle `HttpError` with a built-in manner.
if (error instanceof HttpError || isHttpError(error)) {
  return;
}

// Expose JSON body parsing errors
if (error instanceof SyntaxError) {
  ctx.status = 400;
  ctx.body = { message: error.message };
  return;
}

ctx.status = 500;
ctx.body = { message: 'Internal server error.' };
```

`RequestError.toBody()` 返回结构：
```typescript
{
  code: string;           // 错误码，如 "connector.invalid_metadata"
  message: string;        // i18n 翻译后的用户友好消息
  data?: unknown;         // 原始错误数据（可能包含敏感信息）
  details?: string;       // 额外详情
}
```

---

### 第 6 层：前端体验层

**位置**：`packages/experience/src/apis/experience/social.ts` 等

**核心职责**：
- 调用后端 API
- 根据返回的错误码和消息，在 UI 上展示给终端用户
- 前端可以根据 `code` 字段做特定的错误处理逻辑

---

## 中间件挂载顺序

```
Tenant.ts:122-128
    ↓
1. koaI18next()
2. koaErrorHandler()           ← 最外层，捕获所有错误
3. koaOidcErrorHandler()       ← 处理 oidc-provider 内置错误（SessionNotFound 等）
4. koaSlonikErrorHandler()     ← 处理数据库错误
5. koaConnectorErrorHandler()  ← 处理连接器错误
6. koaCompress()
...
```

---

## 详细错误分流路径（含真实回调地址）

### 路径 A：社交连接器 - 握手阶段（获取授权 URL）

```
POST /experience/verification/social/:connectorId/authorization-uri
    ↓
SocialVerification.createAuthorizationUrl()
    ↓
createSocialAuthorizationUrl()  [social-verification.ts]
    ↓  无 try-catch
connector.getAuthorizationUri()
    ↓  抛出 ConnectorError
    ↓
koa-connector-error-handler.ts  ✅ 经过连接器翻译层
    ↓
转换为 RequestError（状态码精细映射）
    ↓
koa-error-handler.ts
    ↓
返回前端（状态码正确，如 400/401 等）
```

### 路径 B：社交连接器 - 回调阶段（验证身份）

```
POST /experience/verification/social/:connectorId/verify
    ↓
SocialVerification.verify()
    ↓
verifySocialIdentity()  [social-verification.ts]
    ↓  无 try-catch
libraries.socials.getUserInfoWithOptionalTokenResponse()
    ↓
connector.getUserInfo()
    ↓  抛出 ConnectorError
    ↓
koa-connector-error-handler.ts  ✅ 经过连接器翻译层
    ↓
转换为 RequestError（状态码精细映射）
    ↓
koa-error-handler.ts
    ↓
返回前端（状态码正确，如 400/401 等）
```

### 路径 C：社交 SAML 连接器 - ACS 回调

**真实回调地址**：`POST /authn/saml/:connectorId`

**进入点**：`authn.ts:107-159`

```
POST /authn/saml/:connectorId
    ↓
authn.ts 路由处理器（第 107 行）
    ↓  无 try-catch
1. 校验 connector 类型为 Social
2. 校验 SAMLResponse 和 RelayState 存在
3. 调用 connector.validateSamlAssertion({ body }, getSession, setSession)
    ↓  抛出 ConnectorError（如断言无效、签名错误等）
    ↓
koa-connector-error-handler.ts  ✅ 经过连接器翻译层
    ↓
转换为 RequestError（状态码精细映射）
    ↓
koa-error-handler.ts
    ↓
返回前端（状态码正确）
```

### 路径 D：企业 SSO 连接器 - 握手阶段（获取授权 URL）

```
POST /experience/verification/sso/:connectorId/authorization-uri
    ↓
EnterpriseSsoVerification.createAuthorizationUrl()
    ↓
getSsoAuthorizationUrl()  [single-sign-on.ts]
    ↓  ⚠️  有 try-catch 捕获 ConnectorError
    ↓  直接转换为 RequestError，状态码硬编码 500
    ↓
koa-connector-error-handler.ts  ❌ 不经过（已是 RequestError）
    ↓
koa-error-handler.ts
    ↓
返回前端（状态码始终 500，即使是授权失败）
```

### 路径 E：企业 SSO 连接器 - 回调阶段（验证身份）

```
POST /experience/verification/sso/:connectorId/verify
    ↓
EnterpriseSsoVerification.verify()
    ↓
verifySsoIdentity()  [single-sign-on.ts]
    ↓  ⚠️  有 try-catch 捕获 ConnectorError
    ↓  直接转换为 RequestError，状态码硬编码 500
    ↓
koa-connector-error-handler.ts  ❌ 不经过（已是 RequestError）
    ↓
koa-error-handler.ts
    ↓
返回前端（状态码始终 500，即使是授权失败）
```

### 路径 F：企业 SSO SAML 连接器 - ACS 回调

**真实回调地址**：`POST /authn/single-sign-on/saml/:connectorId`

**来源**：`ssoPath = 'single-sign-on'`（定义于 `interaction/const.ts:3`）

**进入点**：`authn.ts:177-315`

#### 错误分支全景图：

```
POST /authn/single-sign-on/saml/:connectorId
    ↓
authn.ts 路由处理器（第 177 行）
    ↓
├─ 分支 1：连接器不存在或不支持
│   ssoConnectorsLibrary.getSsoConnectorById(connectorId)
│   → 抛出 RequestError({ code: 'connector.not_found', status: 404 })
│   来源：libraries/sso-connector.ts:67-72
│   响应格式：{ code, message, data }（标准 RequestError 格式）
│
├─ 分支 2：连接器类型不是 SAML
│   assertThat(connectorInstance instanceof SamlConnector, 'connector.unexpected_type')
│   → 抛出 RequestError({ code: 'connector.unexpected_type', status: 400 })
│   来源：authn.ts:203
│   响应格式：{ code, message, data }
│
├─ 分支 3：IdP 发起的 SSO 流程（无 RelayState）
│   ├─ 分支 3a：IdP 发起 SSO 未启用
│   │   assertThat(idpInitiatedAuthConfig, ...)
│   │   → 抛出 RequestError({ code: 'session.connector_validation_session_not_found', status: 404 })
│   │   来源：authn.ts:215-221
│   │   响应格式：{ code, message, data }
│   │
│   └─ 分支 3b：IdP 发起 SSO 已启用
│       → parseSamlAssertionContent(body)
│         → 抛出 SsoConnectorError（连接器错误，经过连接器翻译层）
│
└─ 分支 4：SP 发起的 SSO 流程（有 RelayState）
    ├─ 分支 4a：RelayState(jti) 为空（isDevFeaturesEnabled 为 false 时）
    │   assertThat(jti, ...)
    │   → 抛出 RequestError({ code: 'session.connector_validation_session_not_found', status: 404 })
    │   来源：authn.ts:278-284
    │   响应格式：{ code, message, data }
    │
    ├─ 分支 4b：通过 jti 查找 interaction session 失败（SessionNotFound）
    │   getSingleSignOnSessionResultByJti(jti, provider)
    │   → getInteractionFromProviderByJti(jti, provider)
    │     → provider.Interaction.find(jti) 返回 null
    │       → 抛出 oidc-provider 内置 SessionNotFound 错误
    │   来源：interaction.ts:150-156
    │   处理流程：
    │     1. 错误冒泡至 koa-connector-error-handler → 不是 ConnectorError，跳过
    │     2. 错误冒泡至 koa-oidc-error-handler → 识别为 OIDCProviderError，处理为：
    │        {
    │          code: 'session.not_found',
    │          message: 'Session not found.',
    │          error: 'SessionNotFound',
    │          error_description: 'interaction session not found'
    │        }
    │     3. koa-error-handler 接收已格式化的响应，不再处理
    │   最终状态码：404（由 SessionNotFound 自身的 statusCode 决定）
    │
    ├─ 分支 4c：session 中没有 connectorSession 或格式错误
    │   assertThat(singleSignOnSessionResult.success, 'session.connector_validation_session_not_found')
    │   → 抛出 RequestError({ code: 'session.connector_validation_session_not_found', status: 404 })
    │   来源：saml-assertion-handler.ts:95
    │   响应格式：{ code, message, data }
    │
    ├─ 分支 4d：session 中的 connectorId 与路径参数不匹配
    │   assertThat(connectorId === sessionConnectorId, ...)
    │   → 抛出 RequestError({ code: 'session.connector_validation_session_not_found', status: 404 })
    │   来源：authn.ts:290-296
    │   响应格式：{ code, message, data }
    │
    ├─ 分支 4e：SAML 断言解析失败
    │   parseSamlAssertionContent(body)
    │   → handleSamlAssertion() 抛出 SsoConnectorError(AuthorizationFailed)
    │   → 经过 koa-connector-error-handler 翻译为 RequestError（状态码 401）
    │   来源：SamlConnector/utils.ts:197-201
    │   响应格式：{ code: 'connector.authorization_failed', message, data }
    │
    └─ 分支 4f：用户信息字段缺失或格式错误
        getUserInfoFromSamlAssertion(assertionContent)
        → getExtendedUserInfoFromRawUserProfile() 抛出 SsoConnectorError(AuthorizationFailed)
        → 经过 koa-connector-error-handler 翻译为 RequestError（状态码 401）
        来源：SamlConnector/utils.ts:154-159
        响应格式：{ code: 'connector.authorization_failed', message, data }
```

**路径 F 关键点**：
- ✅ **连接器错误（分支 3b、4e、4f）**：经过 `koa-connector-error-handler` 翻译层，状态码精细映射
- ❌ **业务错误（分支 1、2、3a、4a、4c、4d）**：直接抛出 `RequestError`，不经过连接器翻译层
- ⚠️  **SessionNotFound（分支 4b）**：经过 `koa-oidc-error-handler` 处理，状态码 404，响应格式包含 `error` 和 `error_description` 字段

---

## 社交 SAML ACS 回调 vs 企业 SSO SAML ACS 回调对比

| 维度 | 社交 SAML ACS 回调 | 企业 SSO SAML ACS 回调 |
|------|-------------------|----------------------|
| **回调地址** | `/authn/saml/:connectorId` | `/authn/single-sign-on/saml/:connectorId` |
| **进入点文件** | `authn.ts:107` | `authn.ts:177` |
| **连接器获取方式** | `libraries.socials.getConnector()` | `libraries.ssoConnectors.getSsoConnectorById()` |
| **调用方法** | `connector.validateSamlAssertion()` | `connectorInstance.parseSamlAssertionContent()` + `getUserInfoFromSamlAssertion()` |
| **是否经过连接器翻译层** | ✅ 是 | ✅ 是（仅连接器错误） |
| **状态码映射** | 精细映射 | 精细映射（连接器错误）+ 多个 404 分支（业务错误） |
| **路由内 try-catch** | 无 | 无 |
| **连接器错误传播路径** | 直接冒泡至中间件 | 直接冒泡至中间件 |
| **SessionNotFound 场景** | 无（使用 connector 内部 session） | 有（使用 oidc-provider interaction session） |

---

## 企业 SSO SAML ACS 回调 404 分支汇总表

| 分支 | 触发条件 | 错误码 | 状态码 | 处理层 | 响应格式 | 经过连接器翻译层 |
|------|---------|--------|--------|--------|---------|----------------|
| 1 | 连接器不存在或不支持 | `connector.not_found` | 404 | 业务层 | `{ code, message, data }` | ❌ |
| 3a | IdP 发起 SSO 未配置 | `session.connector_validation_session_not_found` | 404 | 业务层 | `{ code, message, data }` | ❌ |
| 4a | RelayState(jti) 为空（非 dev 模式） | `session.connector_validation_session_not_found` | 404 | 业务层 | `{ code, message, data }` | ❌ |
| **4b** | **jti 对应的 interaction session 不存在** | **`session.not_found`** | **404** | **OIDC 错误处理层** | **`{ code, message, error, error_description }`** | **❌** |
| 4c | session 中没有 connectorSession | `session.connector_validation_session_not_found` | 404 | 业务层 | `{ code, message, data }` | ❌ |
| 4d | session 中的 connectorId 不匹配 | `session.connector_validation_session_not_found` | 404 | 业务层 | `{ code, message, data }` | ❌ |

---

## 状态码映射对比表

| 错误码 | 中间件层映射（路径 A/B/C/F 连接器错误） | 业务层硬编码（路径 D/E） | 差异 |
|--------|-----------------------------|-------------------------|------|
| `InvalidMetadata` | 400 | 500 | ⚠️  配置错误被误报为服务器内部错误 |
| `InvalidConfig` | 400 | 500 | ⚠️  配置错误被误报为服务器内部错误 |
| `InvalidCertificate` | 400 | 500 | ⚠️  证书错误被误报为服务器内部错误 |
| `InvalidResponse` | 400 | 500 | ⚠️  响应错误被误报为服务器内部错误 |
| `InvalidRequestParameters` | 400 | 500 | ⚠️  参数错误被误报为服务器内部错误 |
| `AuthorizationFailed` | **401** | **500** | ⚠️  授权失败被误报为服务器内部错误 |
| `SocialAuthCodeInvalid` | 401 | -（仅社交连接器） | - |
| `SocialAccessTokenInvalid` | 401 | -（仅社交连接器） | - |
| `SocialIdTokenInvalid` | 401 | -（仅社交连接器） | - |
| `RateLimitExceeded` | 429 | 500 | ⚠️  限流被误报为服务器内部错误 |
| `NotImplemented` | 501 | 500 | ⚠️  未实现被误报为服务器内部错误 |
| `SessionNotFound`（分支 4b） | -（不经过连接器层） | - | 404，由 OIDC 错误处理层处理 |

---

## 对用户可见信息的影响

### 经过连接器翻译层的路径（A/B/C + F 连接器错误）：
- ✅ 状态码准确反映错误类型（400=配置错误，401=授权失败等）
- ✅ 前端可以根据状态码和错误码做差异化处理
- ✅ 用户能看到准确的错误类型（如"授权失败"而非"服务器内部错误"）

### 业务层直接处理的路径（D/E）：
- ❌ 状态码始终为 500，前端无法区分错误类型
- ❌ 用户看到"服务器内部错误"，无法知道是配置问题还是授权失败
- ❌ 前端无法根据错误类型提供合适的用户引导

### 企业 SSO SAML ACS 业务错误（F 分支 1/2/3a/4a/4c/4d）：
- ⚠️  状态码为 404，错误码为 `session.connector_validation_session_not_found` 或 `connector.not_found`
- 用户看到"会话不存在"或"连接器不存在"等提示
- 响应格式：`{ code, message, data }`

### 企业 SSO SAML ACS SessionNotFound（F 分支 4b）：
- ⚠️  状态码为 404，错误码为 `session.not_found`
- 响应格式：`{ code, message, error, error_description }`（包含 oidc-provider 原始错误字段）
- 用户看到"会话不存在"提示
- 前端可以根据 `error_description` 做更精细的错误分析

---

## 职责边界总结表

| 层级 | 模块 | 翻译错误 | 决定状态码 | 决定用户可见信息 | 包含调试数据 |
|------|------|----------|------------|-----------------|-------------|
| 1. 连接器实现层 | SamlConnector / OidcConnector | ❌ 抛出原始错误 | ❌ | ❌ | ✅ 完整调试信息 |
| 2. 连接器错误翻译层 | koa-connector-error-handler | ✅ ConnectorError → RequestError（社交连接器 + 所有 SAML ACS 路径的连接器错误） | ✅ 精细映射（仅经过的路径） | ❌ | ✅ 透传 |
| 3. OIDC 错误处理层 | koa-oidc-error-handler | ✅ SessionNotFound → session.not_found | ✅ 404（由 OIDC 错误自身决定） | ✅ 添加 code、message 字段 | ✅ 保留 error、error_description |
| 4. 业务逻辑层 | single-sign-on.ts（SSO 握手/回调） | ⚠️  仅 SSO 握手/回调直接转换 | ⚠️  SSO 硬编码 500 | ❌ | ✅ 透传 |
| 5. 通用错误处理层 | koa-error-handler | ✅ i18n 翻译 | ✅ 最终状态码 | ✅ 决定暴露内容 | ⚠️  可能暴露 data |
| 6. 前端体验层 | experience/apis | ❌ | ❌ | ✅ UI 展示逻辑 | ❌ |

---

## 关键发现

### 1. 错误处理存在四条实际路径

**路径 1（社交连接器 + 所有 SAML ACS 路径的连接器错误）**：
```
连接器抛出 ConnectorError → koa-connector-error-handler → koa-error-handler
```
✅ 状态码精细映射

**路径 2（企业 SSO 握手/回调）**：
```
连接器抛出 ConnectorError → single-sign-on.ts try-catch → koa-error-handler
```
❌ 状态码硬编码 500

**路径 3（oidc-provider 内置错误，如 SessionNotFound）**：
```
抛出 OIDCProviderError → koa-connector-error-handler（跳过）→ koa-oidc-error-handler（处理）→ koa-error-handler（接收已格式化响应）
```
⚠️  SessionNotFound 返回 404，响应包含 `error` 和 `error_description` 字段

**路径 4（所有其他非连接器错误）**：
```
抛出 RequestError / 其他错误 → koa-error-handler
```
✅ 正常处理

### 2. 企业 SSO 连接器状态码不准确的影响

- 授权失败（401）被报告为服务器内部错误（500）
- 配置错误（400）被报告为服务器内部错误（500）
- 前端无法根据状态码提供合适的用户引导
- 监控系统可能误报大量 500 错误

### 3. 敏感数据暴露风险（所有路径都存在）

- 连接器层抛出的 `data` 可能包含详细配置、原始错误栈等敏感信息
- 这些数据被原样传递到 `RequestError` 中，并可能在响应中暴露给前端
- 生产环境需要额外的过滤机制

### 4. SessionNotFound 的特殊处理

- SessionNotFound 是 oidc-provider 内置错误，不经过连接器翻译层
- 由 `koa-oidc-error-handler` 专门处理，错误码映射为 `session.not_found`
- 响应格式与标准 RequestError 不同，包含 `error` 和 `error_description` 字段
- 状态码由错误自身的 `statusCode` 决定（404）

---

## 优化建议（概念级）

1. **统一错误处理路径**：移除 `single-sign-on.ts` 中的重复 `ConnectorError` 捕获，让所有连接器错误都经过 `koa-connector-error-handler` 统一处理
2. **状态码一致性**：确保所有连接器错误的 HTTP 状态码映射一致，避免业务层硬编码覆盖
3. **敏感数据过滤**：在 `RequestError.toBody()` 中增加敏感字段过滤逻辑，生产环境不暴露 `config`、`metadata` 等详细数据
4. **错误分类标准化**：建立清晰的错误分类机制，区分「用户可操作错误」（如授权失败）和「系统配置错误」（如元数据无效）
5. **SessionNotFound 响应对齐**：考虑将 SessionNotFound 的响应格式与标准 RequestError 对齐，或在前端做统一处理
