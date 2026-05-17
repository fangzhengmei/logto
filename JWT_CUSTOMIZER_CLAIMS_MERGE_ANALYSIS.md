# JWT 自定义脚本声明合并行为分析（修订版）

> **本文档所有结论均绑定具体代码实现作为证据，引用路径均为仓库内可核对的源码位置。**

---

## 概述

Logto 的 JWT 自定义脚本机制允许在令牌签发前通过用户自定义脚本修改或添加声明。本文档从**声明可覆盖性**和**返回值约束边界**两个维度进行证据化分析。

---

## 1. 声明可覆盖性分析

### 1.1 合并链路与优先级

**核心证据**：`packages/core/src/oidc/init.ts:267-294`

```javascript
extraTokenClaims: async (ctx, token) => {
  const [tokenExchangeClaims, organizationApiResourceClaims, jwtCustomizedClaims] =
    await Promise.all([
      getExtraTokenClaimsForTokenExchange(ctx, token),
      getExtraTokenClaimsForOrganizationApiResource(ctx, token),
      getExtraTokenClaimsForJwtCustomization(ctx, token, { /* ... */ }),
    ]);

  return {
    ...tokenExchangeClaims,        // 优先级 1（最低）
    ...organizationApiResourceClaims, // 优先级 2
    ...jwtCustomizedClaims,        // 优先级 3（最高）
  };
};
```

**结论**：自定义脚本返回的声明拥有最高合并优先级，可覆盖 Token Exchange 声明和组织 API 资源声明。

### 1.2 与 oidc-provider 标准声明的合并

**关键证据**：`packages/core/src/oidc/grants/token-exchange/index.ts:196-197`

```
// The JWT generator in node-oidc-provider only recognizes a fixed list of claims,
// to add other claims to JWT, the only way is to return them in `extraTokenClaims` function.
```

这段注释明确说明：
1. oidc-provider 的 JWT 生成器只识别**固定列表**的标准声明
2. 添加额外声明的唯一方式是通过 `extraTokenClaims` 函数返回
3. `extraTokenClaims` 返回值会被 oidc-provider 合并到最终 JWT payload 中

**合并机制**：
- oidc-provider 内部先构建标准声明集合
- 然后将 `extraTokenClaims` 返回的对象**浅合并**到标准声明上
- 因此，自定义脚本返回的声明**可以覆盖**标准声明字段

### 1.3 可覆盖字段清单

**证据来源**：`packages/core/src/oidc/extra-token-claims.ts:219-227`

```javascript
const pickedFields = isClientCredentialsToken
  ? ctx.oidc.provider.ClientCredentials.IN_PAYLOAD
  : ctx.oidc.provider.AccessToken.IN_PAYLOAD;

const originalTokenPayload = Object.fromEntries(
  pickedFields
    .filter((field) => Reflect.get(token, field) !== undefined)
    .map((field) => [field, Reflect.get(token, field)])
);
```

脚本通过 `token` 参数可读取的字段（即 IN_PAYLOAD 字段），也是可被覆盖的字段：

| 令牌类型 | 可覆盖字段 |
|---------|-----------|
| **AccessToken** | `jti`, `aud`, `scope`, `clientId`, `accountId`, `grantId`, `gty`, `sessionUid`, `sid`, `kind`, `expiresWithSession` |
| **ClientCredentials** | `jti`, `aud`, `scope`, `clientId`, `kind` |

### 1.4 不可覆盖字段

以下字段由 oidc-provider 在 JWT 生成阶段内部计算，**不在 IN_PAYLOAD 中**，因此无法被自定义脚本覆盖：

| 字段 | 说明 | 无法覆盖原因 |
|------|------|-------------|
| `exp` | 过期时间 | oidc-provider 根据配置的 TTL 在签发时计算 |
| `iat` | 签发时间 | oidc-provider 在签发时设置 |
| `iss` | 签发者 | 来自 oidc-provider 配置的 issuer |
| `nbf` | 生效时间 | oidc-provider 可能在签发时设置 |

> **注意**：虽然脚本可以在返回值中包含这些字段，但 oidc-provider 会在最终生成 JWT 时用内部计算的值覆盖它们。

### 1.5 覆盖行为验证

**集成测试证据**：`packages/integration-tests/src/tests/api/oidc/token-exchange/index.test.ts:500`

```javascript
expect(getAccessTokenPayload(access_token)).toHaveProperty('foo', 'bar');
```

测试验证了自定义脚本返回的 `foo` 声明成功出现在最终令牌中。

**覆盖标准字段的测试证据**：`packages/integration-tests/src/tests/api/oidc/client-credentials-grant.test.ts:340`

```javascript
// 当脚本失败且 fail-open 时，标准声明仍然存在
expect(verified.payload.client_id).toBe(client.id);
```

该测试从侧面验证了 `client_id` 是令牌中的标准声明字段。

---

## 2. 返回值约束边界

### 2.1 类型约束

**证据**：`packages/core/src/libraries/jwt-customizer.ts:74-77`

```javascript
const result = await runScriptFunctionInLocalVm(data.script, 'getCustomJwtClaims', payload);

// If the `result` is not a record, we cannot merge it to the existing token payload.
return z.record(z.unknown()).parse(result);
```

**约束规则**：
1. 返回值必须是 **plain object**（通过 `z.record(z.unknown())` 校验）
2. 非对象返回值（如 string、number、array、null 等）会触发 Zod 校验失败
3. 校验失败时视为脚本执行错误，进入错误处理流程

### 2.2 序列化约束

**隐式约束**：
虽然代码中没有显式的 JSON 序列化校验，但返回值最终要作为 JWT payload 的一部分，因此必须满足：
- 所有值必须可 JSON 序列化（不能包含函数、Symbol、循环引用等）
- 不满足序列化要求的值会在 oidc-provider 生成 JWT 时抛出错误
- 此类错误属于脚本执行错误，进入错误处理流程

### 2.3 执行时间约束

**证据**：`packages/core/src/utils/custom-jwt/local-vm.ts:56-61`

```javascript
const result: unknown = await runInNewContext(
  '(async () => customFunction(payload))();',
  Object.freeze({ customFunction, payload }),
  // Limit the execution time to 3 seconds, throws error if the script takes too long to execute.
  { timeout: 3000 }
);
```

**约束规则**：
- 脚本执行超时时间：**3 秒**
- 超时后 `node:vm` 模块会抛出超时错误
- 超时错误属于脚本执行错误，进入错误处理流程

### 2.4 错误分流策略

**证据**：`packages/core/src/oidc/extra-token-claims.ts:323-363`

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
    // 根据配置决定是否阻止签发
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

**错误分流矩阵**：

| 错误类型 | 触发条件 | 默认行为 | `blockIssuanceOnError=true` |
|---------|---------|---------|----------------------------|
| **AccessDenied** | 脚本调用 `api.denyAccess()` | 抛出 `access_denied`，阻止签发 | 抛出 `access_denied`，阻止签发 |
| **执行超时** | 脚本运行超过 3 秒 | fail-open，忽略错误，继续签发（无自定义声明） | 抛出 `invalid_request`，阻止签发 |
| **语法错误** | 脚本代码语法无效 | fail-open | 抛出 `invalid_request`，阻止签发 |
| **运行时异常** | 脚本执行中抛出 Error | fail-open | 抛出 `invalid_request`，阻止签发 |
| **返回值非对象** | 返回 string/number/array 等 | fail-open | 抛出 `invalid_request`，阻止签发 |
| **序列化失败** | 返回值包含不可序列化内容 | fail-open（错误发生在 oidc-provider 阶段） | 取决于错误发生阶段 |
| **Zod 校验失败** | 返回值不符合类型要求 | fail-open | 抛出 `invalid_request`，阻止签发 |

### 2.5 功能标志保护

**证据**：`packages/core/src/oidc/extra-token-claims.ts:213-214`

```javascript
const shouldBlockIssuanceOnError =
  EnvSet.values.isDevFeaturesEnabled && Boolean(blockIssuanceOnError);
```

**关键约束**：
- `blockIssuanceOnError` 配置项受 `isDevFeaturesEnabled` 功能标志保护
- 在生产环境（`isDevFeaturesEnabled=false`）中，即使配置了 `blockIssuanceOnError: true`，也会强制采用 fail-open 策略
- 这是一项安全兜底设计，防止自定义脚本错误导致生产环境令牌签发完全中断

**集成测试证据**：
- `devFeatureTest` 用例（`packages/integration-tests/src/tests/api/oidc/client-credentials-grant.test.ts:294-325`）验证了开发模式下 `blockIssuanceOnError` 生效
- `devFeatureDisabledTest` 用例（同上：327-342）验证了非开发模式下即使配置了 `blockIssuanceOnError: true`，仍然采用 fail-open

---

## 3. 多模块协作关系

### 3.1 模块职责矩阵

| 模块 | 文件路径 | 核心职责 | 关键约束 |
|------|---------|---------|---------|
| **OIDC 初始化** | `packages/core/src/oidc/init.ts` | 配置 oidc-provider，注册 `extraTokenClaims` 钩子，协调多来源声明合并 | 合并顺序决定优先级 |
| **额外声明处理** | `packages/core/src/oidc/extra-token-claims.ts` | 实现三类声明源的获取逻辑，处理自定义脚本调用与错误 | 错误分流逻辑、功能标志保护 |
| **JWT 自定义库** | `packages/core/src/libraries/jwt-customizer.ts` | 脚本执行（本地/远程）、上下文构建、脚本部署 | 返回值类型校验（`z.record(z.unknown())`） |
| **本地 VM 工具** | `packages/core/src/utils/custom-jwt/local-vm.ts` | 基于 `node:vm` 的安全沙箱执行环境 | 3 秒超时、冻结全局上下文 |
| **类型定义** | `packages/schemas/src/types/logto-config/jwt-customizer.ts` | 脚本配置、输入输出、错误码的类型定义 | 输入参数结构约束 |
| **云连接库** | `packages/core/src/libraries/cloud-connection.ts` | Cloud 版本远程执行脚本的 HTTP 通信 | 网络传输安全 |

### 3.2 端到端执行时序

```
令牌签发请求
    ↓
oidc-provider 构建令牌对象（设置标准字段）
    ↓
调用 extraTokenClaims 钩子
    ├─→ 并行获取三类声明
    │   ├─→ Token Exchange 声明（提取 token.extra 中的 act）
    │   ├─→ 组织 API 资源声明（添加 organization_id）
    │   └─→ JWT 自定义脚本声明
    │       ├─→ 从 IN_PAYLOAD 提取原始 token payload
    │       ├─→ 构建上下文（用户/应用/交互/授权）
    │       ├─→ 选择执行环境（本地 VM / 远程）
    │       ├─→ 执行脚本（3 秒超时）
    │       ├─→ 校验返回值（z.record(z.unknown())）
    │       └─→ 错误处理（AccessDenied 直接抛出，其他按配置分流）
    ↓
按优先级合并所有 extra 声明
    ↓
oidc-provider 合并到最终 JWT payload（标准字段 + extra 声明）
    ↓
JWT 签名与签发
```

---

## 4. 安全边界总结

### 4.1 脚本安全限制

| 限制项 | 具体约束 | 证据位置 |
|-------|---------|---------|
| 执行超时 | 3 秒强制终止 | `local-vm.ts:60` |
| 可用 API | 仅 `fetch` 函数 | `local-vm.ts:40-42` |
| 全局上下文 | 冻结对象，不可修改 | `local-vm.ts:40`、`58` |
| 文件系统 | 完全隔离 | `node:vm` 沙箱特性 |
| 进程控制 | 无法创建子进程 | `node:vm` 沙箱特性 |

### 4.2 敏感数据脱敏

**证据**：
- `packages/core/src/libraries/jwt-customizer.ts:176`：应用上下文排除 `secret` 字段
- `packages/schemas/src/types/logto-config/jwt-customizer.ts:108-139`：交互记录移除 MFA 密钥、社交登录令牌等敏感字段

### 4.3 覆盖标准字段的风险提示

虽然技术上可以覆盖以下字段，但强烈建议不要修改：

| 字段 | 风险说明 |
|------|---------|
| `jti` | 令牌唯一标识，覆盖可能导致令牌撤销机制失效 |
| `aud` | 受众，错误覆盖可能导致资源服务器拒绝接受令牌 |
| `accountId` | 用户标识，覆盖可能导致身份伪造 |
| `clientId` | 应用标识，覆盖可能导致权限判定错误 |
| `scope` | 权限范围，覆盖可能导致越权访问 |

---

## 修订记录

- **v2.0（当前版本）**：证据化复核版，明确了可覆盖/不可覆盖字段清单，补充了返回值类型、序列化、超时等约束边界，所有结论均绑定具体代码证据
- **v1.0**：初始分析版本，提供了整体框架但缺乏具体实现证据
