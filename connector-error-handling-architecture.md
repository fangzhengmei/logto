# 外部身份连接器错误处理拦截链架构调研（修订版）

## 概述

本文档**准确梳理** Logto 系统中外部身份连接器（社交连接器 / 企业 SSO 连接器）在握手（handshake）和回调（callback）阶段的**实际错误分流路径**，明确哪些错误会走连接器翻译层、哪些会在业务层直接转成通用错误，并说明这对状态码与用户可见信息的影响。

---

## 核心结论速览

| 连接器类型 | 阶段 | 错误处理路径 | 经过连接器翻译层 | 状态码 |
|-----------|------|-------------|----------------|--------|
| **社交连接器** | 握手（getAuthorizationUrl） | 冒泡至中间件 | ✅ 是 | 由 `koa-connector-error-handler` 精细映射 |
| **社交连接器** | 回调（verify） | 冒泡至中间件 | ✅ 是 | 由 `koa-connector-error-handler` 精细映射 |
| **社交连接器** | SAML ACS 回调 | 冒泡至中间件 | ✅ 是 | 由 `koa-connector-error-handler` 精细映射 |
| **企业 SSO 连接器** | 握手（getAuthorizationUrl） | 业务层捕获转换 | ❌ 否 | 硬编码 **500** |
| **企业 SSO 连接器** | 回调（verify） | 业务层捕获转换 | ❌ 否 | 硬编码 **500** |
| **企业 SSO 连接器** | SAML ACS 回调 | 冒泡至中间件 | ✅ 是 | 由 `koa-connector-error-handler` 精细映射 |

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
│  连接器错误翻译层   │                   │  业务逻辑层         │
│  (仅部分路径)       │                   │  (部分路径直接处理) │
│  - koa-connector-   │                   │  - single-sign-on.ts│
│    error-handler.ts │                   │  - 捕获 Connector- │
│  - 捕获 Connector-  │                   │    Error 并直接转   │
│    Error，翻译为    │                   │    为 RequestError  │
│    RequestError     │                   │  - 状态码硬编码 500 │
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

### 第 3 层：业务逻辑层（部分路径直接处理）

**位置**：
- `packages/core/src/routes/interaction/utils/single-sign-on.ts`（企业 SSO 专用）
- `packages/core/src/routes/interaction/utils/social-verification.ts`（社交连接器用）
- `packages/core/src/routes/experience/classes/verifications/`

**核心职责**：
- 调用连接器 API 执行实际的握手和回调逻辑
- 组装业务数据（如 connector session、user info 等）

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

#### 企业 SSO 连接器路径（有 try-catch）：
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

### 第 4 层：通用错误处理层

**位置**：`packages/core/src/middleware/koa-error-handler.ts`

**核心职责**：
- **最终**决定向终端用户暴露什么信息
- 捕获 `RequestError`，调用 `toBody(ctx.i18n)` 生成响应体
- `toBody()` 方法使用 i18n 系统将错误码翻译为用户可读的本地化消息
- 敏感的调试数据（如原始 error 对象、详细 config）通过 `data` 字段传递

**关键代码**：
```typescript
if (error instanceof RequestError) {
  ctx.status = error.status;
  ctx.body = error.toBody(ctx.i18n);
  return;
}
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

### 第 5 层：前端体验层

**位置**：`packages/experience/src/apis/experience/social.ts` 等

**核心职责**：
- 调用后端 API
- 根据返回的错误码和消息，在 UI 上展示给终端用户
- 前端可以根据 `code` 字段做特定的错误处理逻辑

---

## 详细错误分流路径

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

```
POST /authn/saml/:connectorId
    ↓
直接调用 connector.validateSamlAssertion()
    ↓  无 try-catch
抛出 ConnectorError
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

```
POST /authn/sso/saml/:connectorId
    ↓
直接调用 connectorInstance.parseSamlAssertionContent()
    ↓  无 try-catch
抛出 ConnectorError
    ↓
koa-connector-error-handler.ts  ✅ 经过连接器翻译层
    ↓
转换为 RequestError（状态码精细映射）
    ↓
koa-error-handler.ts
    ↓
返回前端（状态码正确）
```

---

## 状态码映射对比表

| 错误码 | 中间件层映射（路径 A/B/C/F） | 业务层硬编码（路径 D/E） | 差异 |
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

---

## 对用户可见信息的影响

### 经过中间件层的路径（A/B/C/F）：
- ✅ 状态码准确反映错误类型（400=配置错误，401=授权失败等）
- ✅ 前端可以根据状态码和错误码做差异化处理
- ✅ 用户能看到准确的错误类型（如"授权失败"而非"服务器内部错误"）

### 业务层直接处理的路径（D/E）：
- ❌ 状态码始终为 500，前端无法区分错误类型
- ❌ 用户看到"服务器内部错误"，无法知道是配置问题还是授权失败
- ❌ 前端无法根据错误类型提供合适的用户引导

---

## 职责边界总结表

| 层级 | 模块 | 翻译错误 | 决定状态码 | 决定用户可见信息 | 包含调试数据 |
|------|------|----------|------------|-----------------|-------------|
| 1. 连接器实现层 | SamlConnector / OidcConnector | ❌ 抛出原始错误 | ❌ | ❌ | ✅ 完整调试信息 |
| 2. 连接器错误翻译层 | koa-connector-error-handler | ✅ ConnectorError → RequestError（仅社交连接器 + SSO ACS 路径） | ✅ 精细映射（仅经过的路径） | ❌ | ✅ 透传 |
| 3. 业务逻辑层 | single-sign-on.ts（SSO） | ⚠️  仅 SSO 握手/回调直接转换 | ⚠️  SSO 硬编码 500 | ❌ | ✅ 透传 |
| 4. 通用错误处理层 | koa-error-handler | ✅ i18n 翻译 | ✅ 最终状态码 | ✅ 决定暴露内容 | ⚠️  可能暴露 data |
| 5. 前端体验层 | experience/apis | ❌ | ❌ | ✅ UI 展示逻辑 | ❌ |

---

## 关键发现

### 1. 错误处理存在**三条**实际路径

**路径 1（社交连接器 + SSO ACS）**：
```
连接器抛出 ConnectorError → koa-connector-error-handler → koa-error-handler
```
✅ 状态码精细映射

**路径 2（企业 SSO 握手/回调）**：
```
连接器抛出 ConnectorError → single-sign-on.ts try-catch → koa-error-handler
```
❌ 状态码硬编码 500

**路径 3（其他非连接器错误）**：
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

---

## 优化建议（概念级）

1. **统一错误处理路径**：移除 `single-sign-on.ts` 中的重复 `ConnectorError` 捕获，让所有连接器错误都经过 `koa-connector-error-handler` 统一处理
2. **状态码一致性**：确保所有连接器错误的 HTTP 状态码映射一致，避免业务层硬编码覆盖
3. **敏感数据过滤**：在 `RequestError.toBody()` 中增加敏感字段过滤逻辑，生产环境不暴露 `config`、`metadata` 等详细数据
4. **错误分类标准化**：建立清晰的错误分类机制，区分「用户可操作错误」（如授权失败）和「系统配置错误」（如元数据无效）
