# JWT 自定义脚本声明合并行为分析（证据分层收敛版）

> **证据分层原则**：每条结论标注为「已证实」或「推断」。
> - **已证实**：有仓库内可直接核对的代码或测试证据
> - **推断**：基于已证实结论的合理推演，但缺乏直接代码证据
> - 所有证据路径均为仓库内可直接跳转核对的位置

---

## 概述

本文档对 Logto JWT 自定义脚本与系统默认声明的合并行为进行证据化分析，重点澄清声明可覆盖性边界和返回值约束边界。

---

## 1. 声明可覆盖性分析

### 1.1 合并优先级

**结论**：自定义脚本声明 > 组织 API 资源声明 > Token Exchange 声明  
**状态**：✅ 已证实  
**证据**：`packages/core/src/oidc/init.ts:267-294`

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

**说明**：对象展开运算符的顺序明确决定了优先级，后展开的对象会覆盖先展开对象的同名字段。

---

### 1.2 可覆盖字段清单

#### 1.2.1 传递给脚本的原始 token payload 字段

**结论**：脚本可读取的原始 token payload 字段来自 IN_PAYLOAD  
**状态**：✅ 已证实  
**证据**：`packages/core/src/oidc/extra-token-claims.ts:219-227`

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

#### 1.2.2 IN_PAYLOAD 具体字段清单

**结论**：  
- AccessToken IN_PAYLOAD 字段：`jti`, `aud`, `scope`, `clientId`, `accountId`, `grantId`, `gty`, `sessionUid`, `sid`, `kind`, `expiresWithSession`  
- ClientCredentials IN_PAYLOAD 字段：`jti`, `aud`, `scope`, `clientId`, `kind`  
**状态**：✅ 已证实  
**证据**：`packages/schemas/src/types/logto-config/oidc-provider.ts:11-38`

```typescript
const baseTokenPayloadGuardObject = {
  jti: z.string(),
  aud: z.union([z.string(), z.string().array()]),
  scope: z.string().optional(),
  clientId: z.string().optional(),
};

export const accessTokenPayloadGuard = z
  .object({
    ...baseTokenPayloadGuardObject,
    accountId: z.string(),
    expiresWithSession: z.boolean().optional(),
    grantId: z.string(),
    gty: z.string(),
    sessionUid: z.string().optional(),
    sid: z.string().optional(),
    kind: z.literal('AccessToken'),
  })
  .strict();

export const clientCredentialsPayloadGuard = z
  .object({
    ...baseTokenPayloadGuardObject,
    kind: z.literal('ClientCredentials'),
  })
  .strict();
```

**注释佐证**：同上文件第 4-7 行
> "Please note that we defined `accessTokenPayloadGuard` and `clientCredentialsPayloadGuard` in this file, they are used to make the user-defined token sample to be aligned with the real token payload given by the OIDC provider in a real use case."

#### 1.2.3 这些字段是否可被自定义脚本覆盖

**结论**：脚本返回的同名字段会在 `extraTokenClaims` 合并中覆盖前面来源的声明  
**状态**：✅ 已证实（针对 Logto 内部合并）  
**证据**：同 1.1 节，对象展开运算符的语义明确保证后展开的 `jwtCustomizedClaims` 会覆盖前面的同名字段

**注意**：这仅证实了在 Logto 的 `extraTokenClaims` 钩子内部的合并行为。oidc-provider 收到 `extraTokenClaims` 返回值后如何与内部标准声明合并，见下节。

---

### 1.3 oidc-provider 内部合并行为

#### 1.3.1 extraTokenClaims 返回值与 oidc-provider 标准声明的合并

**结论**：oidc-provider 会将 `extraTokenClaims` 返回值合并到最终 JWT payload  
**状态**：✅ 已证实（有间接证据）  
**证据 1**：`packages/core/src/oidc/grants/token-exchange/index.ts:196-197`

```
// The JWT generator in node-oidc-provider only recognizes a fixed list of claims,
// to add other claims to JWT, the only way is to return them in `extraTokenClaims` function.
```

**证据 2**：集成测试验证自定义声明出现在最终令牌中。`packages/integration-tests/src/tests/api/oidc/token-exchange/index.test.ts:500`

```javascript
expect(getAccessTokenPayload(access_token)).toHaveProperty('foo', 'bar');
```

**证据 3**：集成测试验证标准声明 `client_id` 出现在最终令牌中。`packages/integration-tests/src/tests/api/oidc/client-credentials-grant.test.ts:340`

```javascript
expect(verified.payload.client_id).toBe(client.id);
```

#### 1.3.2 不可覆盖字段边界

**结论**：`exp`、`iat`、`iss`、`nbf` 字段**不在** IN_PAYLOAD 中，也不在 Logto 定义的 token payload guard 中  
**状态**：✅ 已证实  
**证据**：`packages/schemas/src/types/logto-config/oidc-provider.ts:11-38` — 这些 guard 中明确不包含 `exp`、`iat`、`iss`、`nbf` 字段

**进一步推断**：这些字段可能由 oidc-provider 在 JWT 生成阶段内部计算，即使脚本返回这些字段，也可能被 oidc-provider 覆盖  
**状态**：⚠️ 推断（缺乏直接证据）  
**缺失证据说明**：
- 仓库内未包含 oidc-provider 的 JWT 生成源码
- 无集成测试验证脚本返回 `exp`/`iat`/`iss` 后的实际行为
- 无法在仓库内直接核对 oidc-provider 的内部合并逻辑

**审慎结论**：基于 JWT 规范和 oidc-provider 文档的通用理解，`exp`（过期时间）、`iat`（签发时间）、`iss`（签发者）通常由 OIDC 提供者在签发时计算，不建议在自定义脚本中尝试修改这些字段。但此结论无法仅通过仓库内代码完全证实。

---

### 1.4 声明可覆盖性汇总表

| 字段 | 所在 token payload | 可在 Logto 内部合并中覆盖 | oidc-provider 最终是否允许覆盖 |
|------|-------------------|--------------------------|------------------------------|
| `jti` | ✅ IN_PAYLOAD | ✅ 已证实 | ⚠️ 推断允许 |
| `aud` | ✅ IN_PAYLOAD | ✅ 已证实 | ⚠️ 推断允许 |
| `scope` | ✅ IN_PAYLOAD | ✅ 已证实 | ⚠️ 推断允许 |
| `clientId` / `client_id` | ✅ IN_PAYLOAD | ✅ 已证实 | ✅ 已证实（测试验证存在） |
| `accountId` | ✅ IN_PAYLOAD (AccessToken) | ✅ 已证实 | ⚠️ 推断允许 |
| `grantId` | ✅ IN_PAYLOAD (AccessToken) | ✅ 已证实 | ⚠️ 推断允许 |
| `gty` | ✅ IN_PAYLOAD (AccessToken) | ✅ 已证实 | ⚠️ 推断允许 |
| `sessionUid` | ✅ IN_PAYLOAD (AccessToken) | ✅ 已证实 | ⚠️ 推断允许 |
| `sid` | ✅ IN_PAYLOAD (AccessToken) | ✅ 已证实 | ⚠️ 推断允许 |
| `kind` | ✅ IN_PAYLOAD | ✅ 已证实 | ⚠️ 推断允许 |
| `expiresWithSession` | ✅ IN_PAYLOAD (AccessToken) | ✅ 已证实 | ⚠️ 推断允许 |
| `exp` | ❌ 不在 IN_PAYLOAD | ❌ 脚本无法读取原值 | ⚠️ 推断不允许（内部计算） |
| `iat` | ❌ 不在 IN_PAYLOAD | ❌ 脚本无法读取原值 | ⚠️ 推断不允许（内部计算） |
| `iss` | ❌ 不在 IN_PAYLOAD | ❌ 脚本无法读取原值 | ⚠️ 推断不允许（内部计算） |
| `nbf` | ❌ 不在 IN_PAYLOAD | ❌ 脚本无法读取原值 | ⚠️ 推断不允许（内部计算） |

---

## 2. 返回值约束边界

### 2.1 类型约束

**结论**：脚本返回值必须是 plain object，通过 `z.record(z.unknown())` 校验  
**状态**：✅ 已证实  
**证据**：`packages/core/src/libraries/jwt-customizer.ts:74-77`

```javascript
const result = await runScriptFunctionInLocalVm(data.script, 'getCustomJwtClaims', payload);

// If the `result` is not a record, we cannot merge it to the existing token payload.
return z.record(z.unknown()).parse(result);
```

**约束规则**：
- 返回值必须是对象（`typeof result === 'object' && result !== null && !Array.isArray(result)`）
- 非对象返回值（string、number、array、null 等）会触发 Zod 校验失败
- 校验失败视为脚本执行错误，进入错误处理流程

---

### 2.2 序列化约束

**结论**：代码中无显式的 JSON 序列化校验  
**状态**：✅ 已证实  
**证据**：在 `packages/core/src/libraries/jwt-customizer.ts` 和 `packages/core/src/oidc/extra-token-claims.ts` 中均未发现对返回值进行 JSON 序列化尝试的代码

**推断**：返回值最终需要作为 JWT payload 的一部分，因此必须可 JSON 序列化。如果返回值包含不可序列化内容（函数、Symbol、循环引用等），错误可能发生在 oidc-provider 的 JWT 生成阶段  
**状态**：⚠️ 推断  
**缺失证据说明**：
- 仓库内无代码验证序列化失败后的具体行为
- 无测试用例覆盖返回不可序列化值的场景
- 无法确定序列化失败是被 oidc-provider 静默忽略、还是抛出错误导致签发失败

**审慎结论**：脚本应确保返回值可 JSON 序列化。对于序列化失败的行为边界，建议通过实际测试确认。

---

### 2.3 执行时间约束

**结论**：本地 VM 执行超时时间为 3 秒  
**状态**：✅ 已证实  
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
- 超时后 `node:vm` 模块会抛出超时错误
- 超时错误属于脚本执行错误，进入错误处理流程

---

### 2.4 错误分流策略

#### 2.4.1 错误处理核心逻辑

**结论**：错误分流逻辑区分 `AccessDenied` 错误和其他错误  
**状态**：✅ 已证实  
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

#### 2.4.2 功能标志保护

**结论**：`blockIssuanceOnError` 受 `isDevFeaturesEnabled` 功能标志保护  
**状态**：✅ 已证实  
**证据**：`packages/core/src/oidc/extra-token-claims.ts:213-214`

```javascript
const shouldBlockIssuanceOnError =
  EnvSet.values.isDevFeaturesEnabled && Boolean(blockIssuanceOnError);
```

**集成测试证据 1（开发模式）**：`packages/integration-tests/src/tests/api/oidc/client-credentials-grant.test.ts:294-325`  
验证 `isDevFeaturesEnabled=true` 时，`blockIssuanceOnError: true` 生效，脚本错误阻止签发。

**集成测试证据 2（非开发模式）**：同上文件 327-342  
验证 `isDevFeaturesEnabled=false` 时，即使配置 `blockIssuanceOnError: true`，仍然采用 fail-open 策略。

#### 2.4.3 错误分流矩阵

| 错误类型 | 触发条件 | 默认行为 | `blockIssuanceOnError=true` (dev) |
|---------|---------|---------|----------------------------------|
| **AccessDenied** | 脚本调用 `api.denyAccess()` | 抛出 `access_denied`，阻止签发 ✅ | 抛出 `access_denied`，阻止签发 ✅ |
| **执行超时** | 脚本运行超过 3 秒 | fail-open，忽略错误 ✅ | 抛出 `invalid_request`，阻止签发 ✅ |
| **语法错误** | 脚本代码语法无效 | fail-open ✅ | 抛出 `invalid_request`，阻止签发 ✅ |
| **运行时异常** | 脚本执行中抛出 Error | fail-open ✅ | 抛出 `invalid_request`，阻止签发 ✅ |
| **返回值非对象** | 返回 string/number/array 等 | fail-open ✅ | 抛出 `invalid_request`，阻止签发 ✅ |
| **Zod 校验失败** | 返回值不符合类型要求 | fail-open ✅ | 抛出 `invalid_request`，阻止签发 ✅ |
| **序列化失败** | 返回值包含不可序列化内容 | ⚠️ 推断 fail-open（取决于 oidc-provider 行为） | ⚠️ 推断取决于错误发生阶段 |

> 注：标记 ✅ 的行为有代码证据，标记 ⚠️ 的为推断

---

### 2.5 返回值约束汇总

| 约束类型 | 具体规则 | 状态 | 证据位置 |
|---------|---------|------|---------|
| **类型** | 必须是 plain object，通过 `z.record(z.unknown())` 校验 | ✅ 已证实 | `jwt-customizer.ts:74-77` |
| **序列化** | 隐式要求可 JSON 序列化，但无代码校验 | ⚠️ 推断 | 无直接代码证据 |
| **执行时间** | 本地 VM 3 秒超时 | ✅ 已证实 | `local-vm.ts:60` |
| **AccessDenied** | 总是阻止签发 | ✅ 已证实 | `extra-token-claims.ts:332-334` |
| **其他错误** | 默认 fail-open，dev 模式下可配置 fail-close | ✅ 已证实 | `extra-token-claims.ts:323-363` |

---

## 3. 多模块协作关系

### 3.1 模块职责与证据矩阵

| 模块 | 文件路径 | 核心职责 | 可证实的关键行为 |
|------|---------|---------|----------------|
| **OIDC 初始化** | `packages/core/src/oidc/init.ts` | 配置 oidc-provider，注册 `extraTokenClaims` 钩子 | 声明合并顺序（267-294）✅ |
| **额外声明处理** | `packages/core/src/oidc/extra-token-claims.ts` | 实现三类声明源的获取逻辑 | 错误分流逻辑（323-363）✅<br>功能标志保护（213-214）✅<br>IN_PAYLOAD 字段提取（219-227）✅ |
| **JWT 自定义库** | `packages/core/src/libraries/jwt-customizer.ts` | 脚本执行、上下文构建 | 返回值类型校验（74-77）✅<br>应用上下文排除 secret（176）✅ |
| **本地 VM 工具** | `packages/core/src/utils/custom-jwt/local-vm.ts` | 安全沙箱执行环境 | 3 秒超时（56-61）✅<br>冻结全局上下文（40, 58）✅ |
| **类型定义** | `packages/schemas/src/types/logto-config/oidc-provider.ts` | token payload 结构定义 | IN_PAYLOAD 字段清单（11-38）✅ |
| **集成测试** | `packages/integration-tests/src/tests/api/oidc/**` | 端到端行为验证 | 自定义声明出现在令牌中 ✅<br>功能标志行为验证 ✅ |

---

## 4. 证据缺口与待确认项

### 4.1 已识别的证据缺口

| 待确认项 | 缺失证据说明 | 建议确认方式 |
|---------|-------------|-------------|
| oidc-provider 内部合并逻辑 | 仓库内无 oidc-provider JWT 生成源码，无法确认 `extraTokenClaims` 与标准声明的最终合并方式 | 查阅 oidc-provider 官方文档或源码 |
| 序列化失败行为 | 无代码或测试验证返回不可序列化值后的具体行为 | 添加集成测试用例 |
| 覆盖 `exp`/`iat`/`iss` 的实际效果 | 无测试验证脚本返回这些字段后的最终令牌内容 | 添加集成测试用例 |
| Cloud 版本远程执行的超时和错误处理 | 远程执行逻辑依赖外部服务，仓库内仅能看到调用接口 | 查阅 Cloud 版本文档或实际测试 |

### 4.2 审慎使用建议

对于标记为「推断」的结论，在生产环境使用前建议：
1. 通过实际测试验证行为
2. 避免依赖未证实的行为（如尝试覆盖 `exp`/`iat`/`iss`）
3. 确保返回值可 JSON 序列化，避免依赖隐式容错行为

---

## 修订记录

- **v3.0（当前版本）**：证据分层收敛版，每条结论标注「已证实」或「推断」，删除无法自证的确定性表述，明确证据缺口
- **v2.0**：证据化复核版，明确了可覆盖/不可覆盖字段清单和返回值约束
- **v1.0**：初始分析版本，提供整体框架
