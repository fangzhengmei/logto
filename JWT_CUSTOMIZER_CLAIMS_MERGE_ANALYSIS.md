# JWT 自定义脚本声明合并行为分析

## 概述

本文档详细分析 Logto 系统中令牌签发前自定义脚本与系统默认声明的合并行为，包括脚本运行环境、字段优先级、越界写入兜底策略以及多模块协作关系。

---

## 1. 脚本运行环境

### 1.1 执行模式

Logto 支持两种脚本执行模式，根据部署环境自动选择：

| 环境 | 执行方式 | 位置 |
|------|---------|------|
| OSS (开源版) | 本地 Node.js VM | `packages/core/src/utils/custom-jwt/local-vm.ts:35-64` |
| Cloud (云版) | 远程隔离环境 | Azure Functions / Cloudflare Workers |

### 1.2 本地 VM 环境特性

**核心实现**：`runScriptFunctionInLocalVm()` 函数

- **隔离机制**：使用 Node.js 内置 `vm` 模块的 `runInNewContext()` 创建沙箱环境
- **超时限制**：3 秒执行超时，防止脚本挂起
- **可用 API**：仅提供 `fetch` 函数用于外部网络请求
- **全局上下文**：冻结对象，防止脚本修改全局环境

```javascript
const globalContext = Object.freeze({
  fetch: async (...args: Parameters<typeof fetch>) => fetch(...args),
});
```

### 1.3 脚本输入参数

脚本接收 `CustomJwtScriptPayload` 类型参数：

| 字段 | 类型 | 说明 |
|------|------|------|
| `token` | `Record<string, unknown>` | 原始令牌 payload（仅包含 IN_PAYLOAD 字段） |
| `context` | `Record<string, unknown>` | 上下文信息（用户、应用、交互、授权等） |
| `environmentVariables` | `Record<string, string>` | 管理员配置的环境变量 |
| `api` | `CustomJwtApiContext` | 内置 API（当前仅 `denyAccess()`） |

### 1.4 上下文数据结构

**访问令牌上下文**：
- `user`：用户信息（ID、角色、组织、SSO 身份、MFA 因素等）
- `grant`：授权上下文（仅 Token Exchange 时包含 subjectToken 信息）
- `interaction`：交互上下文（登录事件、验证记录、登录上下文）
- `application`：应用信息（排除 secret 字段）

**客户端凭据令牌上下文**：
- `application`：应用信息

---

## 2. 字段优先级与合并策略

### 2.1 声明来源与优先级

令牌最终声明由以下来源按优先级从低到高合并：

```
oidc-provider 标准声明
    ↓
Token Exchange 声明 (getExtraTokenClaimsForTokenExchange)
    ↓
组织 API 资源声明 (getExtraTokenClaimsForOrganizationApiResource)
    ↓
JWT 自定义脚本声明 (getExtraTokenClaimsForJwtCustomization)
```

**合并实现**：`packages/core/src/oidc/init.ts:267-294`

```javascript
extraTokenClaims: async (ctx, token) => {
  const [tokenExchangeClaims, organizationApiResourceClaims, jwtCustomizedClaims] =
    await Promise.all([
      getExtraTokenClaimsForTokenExchange(ctx, token),
      getExtraTokenClaimsForOrganizationApiResource(ctx, token),
      getExtraTokenClaimsForJwtCustomization(ctx, token, { /* ... */ }),
    ]);

  return {
    ...tokenExchangeClaims,
    ...organizationApiResourceClaims,
    ...jwtCustomizedClaims,  // 最高优先级，可覆盖前面的声明
  };
};
```

### 2.2 与 oidc-provider 标准声明的合并

oidc-provider 内部会将 `extraTokenClaims` 返回值与标准声明进行合并。自定义脚本返回的声明**可以覆盖**标准声明字段。

**标准声明字段**（IN_PAYLOAD）：

| 令牌类型 | 标准字段 |
|---------|---------|
| AccessToken | `jti`, `aud`, `scope`, `clientId`, `accountId`, `grantId`, `gty`, `sessionUid`, `sid`, `kind`, `expiresWithSession` |
| ClientCredentials | `jti`, `aud`, `scope`, `clientId`, `kind` |

### 2.3 自定义脚本读取原始声明

脚本可以通过 `token` 参数读取原始声明，但返回的新声明将在后续合并中覆盖原值：

```javascript
// 自定义脚本示例
const getCustomJwtClaims = async ({ token, context }) => {
  // 读取原始 clientId
  const originalClientId = token.clientId;
  
  // 返回的声明将覆盖原始值
  return {
    clientId: 'overridden-client-id',  // 将覆盖原始 clientId
    customClaim: 'custom-value',        // 新增声明
  };
};
```

---

## 3. 越界写入兜底策略

### 3.1 返回值校验

脚本返回值必须满足以下条件，否则视为无效：

1. **类型校验**：必须是 plain object（通过 `z.record(z.unknown()).parse(result)` 校验）
2. **字段限制**：无显式字段黑名单，但 oidc-provider 对部分关键字段有内部保护
3. **序列化**：所有值必须可 JSON 序列化

### 3.2 错误处理策略

| 错误场景 | 默认行为 | `blockIssuanceOnError=true` |
|---------|---------|----------------------------|
| 脚本执行超时 | 忽略错误，继续签发（无自定义声明） | 抛出 `invalid_request` 错误，阻止签发 |
| 脚本语法错误 | 忽略错误，继续签发 | 抛出 `invalid_request` 错误，阻止签发 |
| 脚本运行时异常 | 忽略错误，继续签发 | 抛出 `invalid_request` 错误，阻止签发 |
| 返回值非对象 | 忽略错误，继续签发 | 抛出 `invalid_request` 错误，阻止签发 |
| 调用 `api.denyAccess()` | 抛出 `access_denied` 错误，阻止签发 | 抛出 `access_denied` 错误，阻止签发 |

**关键代码**：`packages/core/src/oidc/extra-token-claims.ts:323-363`

```javascript
try {
  const result = EnvSet.values.isCloud
    ? await libraries.jwtCustomizers.runScriptRemotely(payload)
    : await JwtCustomizerLibrary.runScriptInLocalVm(payload);
  return result;
} catch (error: unknown) {
  if (error instanceof ResponseError) {
    const errorResponse = await trySafe(async () => parseCustomJwtResponseError(error));
    // AccessDenied 错误总是阻止签发
    if (errorResponse && isAccessDeniedError(errorResponse.error)) {
      throw new errors.AccessDenied(errorResponse.message);
    }
    // 根据 blockIssuanceOnError 配置决定是否阻止签发
    if (shouldBlockIssuanceOnError) {
      throwJwtCustomizerInvalidRequest(ctx, errorResponse?.message);
    }
    return;  // 默认 fail-open
  }
  // 其他错误同样根据配置决定
  if (shouldBlockIssuanceOnError) {
    throwJwtCustomizerInvalidRequest(ctx, error.message);
  }
}
```

### 3.3 功能标志控制

`blockIssuanceOnError` 目前受 `isDevFeaturesEnabled` 标志保护：

```javascript
const shouldBlockIssuanceOnError =
  EnvSet.values.isDevFeaturesEnabled && Boolean(blockIssuanceOnError);
```

这意味着在生产环境中（非开发特性模式），即使配置了 `blockIssuanceOnError: true`，也会采用 fail-open 策略。

---

## 4. 多模块协作关系

### 4.1 核心模块协作图

```
┌─────────────────────────────────────────────────────────┐
│                  oidc-provider (init.ts)               │
│  ┌───────────────────────────────────────────────────┐  │
│  │          extraTokenClaims 钩子函数                │  │
│  └───────────────────────────────────────────────────┘  │
│                           ↓                             │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Promise.all([声明源1, 声明源2, 声明源3])         │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│           extra-token-claims.ts                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────┐│
│  │ Token Exchange  │  │  Organization   │  │   JWT    ││
│  │   Claims        │  │   API Resource  │  │ Customizer││
│  └─────────────────┘  └─────────────────┘  └──────────┘│
│                                                      ↓  │
│                                           ┌────────────┐│
│                                           │  合并返回  ││
│                                           └────────────┘│
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│              jwt-customizer.ts 库                       │
│  ┌─────────────────┐  ┌─────────────────┐               │
│  │  本地 VM 执行   │  │  远程执行       │               │
│  │  (OSS)          │  │  (Cloud)        │               │
│  └─────────────────┘  └─────────────────┘               │
└─────────────────────────────────────────────────────────┘
```

### 4.2 关键模块职责

| 模块 | 文件路径 | 核心职责 |
|------|---------|---------|
| OIDC 初始化 | `packages/core/src/oidc/init.ts` | 配置 oidc-provider，注册 `extraTokenClaims` 钩子，协调多来源声明合并 |
| 额外声明处理 | `packages/core/src/oidc/extra-token-claims.ts` | 实现三类声明源的获取逻辑，处理自定义脚本调用与错误 |
| JWT 自定义库 | `packages/core/src/libraries/jwt-customizer.ts` | 脚本执行（本地/远程）、上下文构建、脚本部署 |
| 本地 VM 工具 | `packages/core/src/utils/custom-jwt/local-vm.ts` | 基于 `node:vm` 的安全沙箱执行环境 |
| 类型定义 | `packages/schemas/src/types/logto-config/jwt-customizer.ts` | 脚本配置、输入输出、错误码的类型定义 |

### 4.3 执行时序

```
令牌签发请求
    ↓
oidc-provider 开始构建令牌
    ↓
调用 extraTokenClaims 钩子
    ├─→ 并行获取三类声明
    │   ├─→ Token Exchange 声明
    │   ├─→ 组织 API 资源声明
    │   └─→ JWT 自定义脚本声明
    │       ├─→ 构建上下文（用户/应用/交互）
    │       ├─→ 选择执行环境（本地/远程）
    │       ├─→ 执行脚本
    │       └─→ 错误处理
    ↓
按优先级合并所有声明
    ↓
oidc-provider 合并到最终令牌
    ↓
签发完成
```

---

## 5. 安全边界与限制

### 5.1 脚本安全限制

1. **执行超时**：3 秒强制终止
2. **内存限制**：Node.js VM 默认为进程共享内存，无单独限制
3. **网络访问**：仅可使用 `fetch` API，无其他网络权限
4. **文件系统**：完全隔离，无法访问本地文件
5. **进程控制**：无法创建子进程或执行系统命令

### 5.2 数据脱敏

- 用户密码哈希：不出现在上下文中
- 应用密钥：`getApplicationContext()` 明确排除 `secret` 字段
- MFA 密钥：交互记录中移除 TOTP secret、WebAuthn challenge 等敏感字段
- 社交登录令牌：移除 `connectorSession` 和 `encryptedTokenSet`

### 5.3 可覆盖字段的潜在风险

虽然自定义脚本理论上可以覆盖所有标准声明，但修改以下字段可能导致严重问题：

| 字段 | 风险说明 |
|------|---------|
| `jti` | 令牌唯一标识，覆盖可能导致撤销机制失效 |
| `exp` | 过期时间（oidc-provider 内部计算，不在 token 参数中） |
| `iat` | 签发时间（同上） |
| `iss` | 签发者（同上） |
| `aud` | 受众，错误覆盖可能导致令牌无法被资源服务器接受 |
| `accountId` | 用户标识，覆盖可能导致身份伪造 |

---

## 6. 配置与部署

### 6.1 脚本配置结构

```typescript
interface JwtCustomizerConfig {
  script: string;                    // 自定义脚本代码
  environmentVariables?: Record<string, string>;  // 环境变量
  contextSample?: object;            // 测试用上下文示例
  blockIssuanceOnError?: boolean;    // 错误时是否阻止签发
}
```

### 6.2 云版部署流程

1. 管理员通过管理 API 保存脚本配置
2. 系统调用 `deployJwtCustomizerScript()` 部署到 Cloudflare Workers / Azure Functions
3. 部署成功后更新数据库
4. 令牌签发时通过 HTTP 调用远程执行端点

---

## 7. 测试与调试

### 7.1 测试接口

系统提供测试端点 `/api/configs/jwt-customizer/test`，支持：
- 使用自定义脚本和示例数据进行测试
- 不影响生产环境令牌签发
- 实时返回脚本执行结果或错误信息

### 7.2 日志记录

- 成功执行：自定义声明会被记录到审计日志（`customTokenClaims` 字段）
- 执行失败：错误详情记录到 `customJwtError` 字段
- 安全考虑：脚本代码和环境变量不会被记录

---

## 总结

Logto 的 JWT 自定义脚本机制采用**分层合并**策略，自定义声明拥有最高优先级；通过**本地 VM 沙箱**或**远程隔离环境**确保脚本执行安全；错误处理采用**默认 fail-open** 策略，可通过 `blockIssuanceOnError` 配置为 fail-close；整个流程涉及 OIDC Provider 钩子、声明获取、脚本执行、错误处理等多个模块的紧密协作。
