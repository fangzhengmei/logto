# 外部身份连接器错误处理拦截链架构调研

## 概述

本文档梳理 Logto 系统中外部身份连接器（社交连接器 / 企业 SSO 连接器）在握手（handshake）或回调（callback）阶段出错时的统一拦截链，明确各层职责边界。

---

## 核心分层架构

```
┌─────────────────────────────────────────────────────────┐
│  5. 前端体验层 (Experience Layer)                       │
│     - 接收 API 响应，根据错误码展示用户友好提示          │
└─────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────────────────────────────────┐
│  4. 通用错误处理层 (General Error Handler)              │
│     - koa-error-handler.ts                              │
│     - 捕获 RequestError，调用 toBody() 生成响应          │
│     - 决定向终端用户暴露什么信息（i18n 翻译）            │
└─────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────────────────────────────────┐
│  3. 业务逻辑层 (Business Logic Layer)                   │
│     - single-sign-on.ts / social-verification.ts        │
│     - 调用连接器 API，部分场景直接捕获 ConnectorError    │
│     - ⚠️  存在与中间件层重复处理的问题                   │
└─────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────────────────────────────────┐
│  2. 连接器错误翻译层 (Connector Error Translator)       │
│     - koa-connector-error-handler.ts                    │
│     - 捕获 ConnectorError，翻译为 RequestError           │
│     - 决定 HTTP 状态码映射                               │
└─────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────────────────────────────────┐
│  1. 连接器实现层 (Connector Implementation)             │
│     - SamlConnector / OidcConnector / 各社交连接器       │
│     - 抛出原始 ConnectorError / SsoConnectorError        │
│     - 包含详细调试信息（metadata、config、error 等）      │
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

### 第 2 层：连接器错误翻译层

**位置**：`packages/core/src/middleware/koa-connector-error-handler.ts`

**挂载位置**：`Tenant.ts:128`，在所有路由之前全局挂载

**核心职责**：
- **统一捕获**所有 `ConnectorError` 类型的错误
- **翻译**为系统统一的 `RequestError` 类型
- **映射**错误码到标准格式：`connector.${code}`
- **决定**HTTP 状态码：
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

### 第 3 层：业务逻辑层

**位置**：
- `packages/core/src/routes/interaction/utils/single-sign-on.ts`
- `packages/core/src/routes/interaction/utils/social-verification.ts`
- `packages/core/src/routes/experience/classes/verifications/`

**核心职责**：
- 调用连接器 API 执行实际的握手和回调逻辑
- 组装业务数据（如 connector session、user info 等）

**⚠️  注意：存在重复错误处理**

在 `single-sign-on.ts` 中，`getSsoAuthorizationUrl` 和 `verifySsoIdentity` 函数内部也捕获了 `ConnectorError` 并直接转换为 `RequestError`：

```typescript
try {
  // 连接器调用
} catch (error: unknown) {
  if (error instanceof ConnectorError) {
    throw new RequestError({ code: `connector.${error.code}`, status: 500 }, error.data);
  }
  throw error;
}
```

**问题**：
1. 状态码硬编码为 500，绕过了中间件层的精细状态码映射
2. 与中间件层的错误处理逻辑重复
3. 由于错误被重新抛出为 `RequestError`，中间件层不会再处理它

---

### 第 4 层：通用错误处理层

**位置**：`packages/core/src/middleware/koa-error-handler.ts`

**核心职责**：
- **最终**决定向终端用户暴露什么信息
- 捕获 `RequestError`，调用 `toBody(ctx.i18n)` 生成响应体
- `toBody()` 方法使用 i18n 系统将错误码翻译为用户可读的本地化消息
- 敏感的调试数据（如原始 error 对象、详细 config）通过 `data` 字段传递，但在生产环境可能被过滤

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

## 错误流转示例

### 示例 1：SAML 元数据无效

```
1. SamlConnector.getIdentityProvider()
   → 验证 XML 失败
   → 抛出 SsoConnectorError(InvalidMetadata, { metadata, error })

2. 向上冒泡至 koa-connector-error-handler
   → 捕获 ConnectorError
   → 转换为 RequestError({ code: "connector.invalid_metadata", status: 400 }, data)

3. 向上冒泡至 koa-error-handler
   → 捕获 RequestError
   → 调用 toBody() 生成响应
   → 返回给前端：
     {
       code: "connector.invalid_metadata",
       message: "Invalid SAML metadata.",  // 经 i18n 翻译
       data: { ssoErrorCode: "invalid_metadata", metadata: "...", error: {} }
     }
```

### 示例 2：OIDC 授权失败

```
1. OidcConnector.getUserInfo()
   → 发现 access token 缺失
   → 抛出 SsoConnectorError(AuthorizationFailed, { message: "..." })

2. 被 single-sign-on.ts 中的 try-catch 捕获
   → 转换为 RequestError({ code: "connector.authorization_failed", status: 500 }, data)
   ⚠️  状态码被硬编码为 500，跳过了中间件层的 401 映射

3. 向上冒泡至 koa-error-handler
   → 捕获 RequestError
   → 返回给前端
```

---

## 关键发现与问题

### 1. 错误处理存在两条路径

**路径 A（经过中间件层）**：
```
连接器抛出 ConnectorError → koa-connector-error-handler → koa-error-handler
```

**路径 B（业务层直接处理）**：
```
连接器抛出 ConnectorError → single-sign-on.ts try-catch → koa-error-handler
```

路径 B 绕过了中间件层的精细状态码映射，导致状态码不准确（如授权失败被标记为 500 而非 401）。

### 2. 敏感数据暴露风险

- 连接器层抛出的 `data` 可能包含详细配置、原始错误栈等敏感信息
- 这些数据被原样传递到 `RequestError` 中，并可能在响应中暴露给前端
- 生产环境需要额外的过滤机制

### 3. SSO 连接器错误码映射

`SsoConnectorError` 通过 `connectorErrorCodeMap` 映射到通用 `ConnectorErrorCodes`，
但部分上下文信息（如 `ssoErrorCode`）被保留在 `data` 中，可用于更精细的错误分析。

---

## 职责边界总结表

| 层级 | 模块 | 翻译错误 | 决定状态码 | 决定用户可见信息 | 包含调试数据 |
|------|------|----------|------------|-----------------|-------------|
| 1. 连接器实现层 | SamlConnector / OidcConnector | ❌ 抛出原始错误 | ❌ | ❌ | ✅ 完整调试信息 |
| 2. 连接器错误翻译层 | koa-connector-error-handler | ✅ ConnectorError → RequestError | ✅ 精细映射 | ❌ | ✅ 透传 |
| 3. 业务逻辑层 | single-sign-on.ts | ⚠️  部分重复处理 | ⚠️  硬编码 500 | ❌ | ✅ 透传 |
| 4. 通用错误处理层 | koa-error-handler | ✅ i18n 翻译 | ✅ 最终状态码 | ✅ 决定暴露内容 | ⚠️  可能暴露 data |
| 5. 前端体验层 | experience/apis | ❌ | ❌ | ✅ UI 展示逻辑 | ❌ |

---

## 优化建议（概念级）

1. **统一错误处理路径**：移除业务逻辑层的重复 `ConnectorError` 捕获，让所有连接器错误都经过 `koa-connector-error-handler` 统一处理
2. **敏感数据过滤**：在 `RequestError.toBody()` 中增加敏感字段过滤逻辑，生产环境不暴露 `config`、`metadata` 等详细数据
3. **状态码一致性**：确保所有连接器错误的 HTTP 状态码映射一致，避免业务层硬编码覆盖
4. **错误分类标准化**：建立清晰的错误分类机制，区分「用户可操作错误」（如授权失败）和「系统配置错误」（如元数据无效）
