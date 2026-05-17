# JWT 自定义脚本声明合并行为分析（Cloud/OSS 双链路对照版）

> **证据分层原则**：每条结论标注为「已证实」或「推断」。
> - **✅ 已证实**：有仓库内可直接核对的代码或测试证据
> - **⚠️ 推断**：基于已证实结论的合理推演，但缺乏直接代码证据
> - 所有证据路径均为仓库内可直接跳转核对的位置

---

## 概述

本文档对 Logto JWT 自定义脚本在 **OSS 本地 VM** 与 **Cloud 远程执行** 两条链路上的行为进行对照分析，重点澄清各类错误的处理边界。

---

## 1. 两条执行链路的架构差异

### 1.1 OSS 本地 VM 执行链路

**状态**：✅ 已证实  
**证据**：`packages/core/src/utils/custom-jwt/local-vm.ts:56-61`

```
令牌签发请求
    ↓
extraTokenClaims 钩子
    ↓
runScriptInLocalVm()
    ├─→ 使用 node:vm 创建沙箱
    ├─→ 冻结全局上下文（仅提供 fetch）
    ├─→ 执行脚本（3 秒超时）
    ├─→ 返回值通过 z.record(z.unknown()) 校验
    └─→ 异常直接抛出
    ↓
错误分流处理
```

### 1.2 Cloud 远程执行链路

**状态**：✅ 已证实  
**证据**：`packages/core/src/libraries/jwt-customizer.ts:294-329`

```
令牌签发请求
    ↓
extraTokenClaims 钩子
    ↓
runScriptRemotely()
    ├─→ 首选：区域 Azure Function 调用（got HTTP 客户端）
    │   ├─→ POST /api/custom-jwt
    │   ├─→ 响应通过 jsonObjectGuard 校验
    │   └─→ HTTPError 转换为 ResponseError
    └─→ 备选：Cloud Connection 调用（withtyped 客户端）
        └─→ POST /api/services/custom-jwt
    ↓
ResponseError 解析
    ├─→ parseCustomJwtResponseError() 解析响应体
    └─→ isAccessDeniedError() 检查错误码
    ↓
错误分流处理
```

### 1.3 链路选择逻辑

**状态**：✅ 已证实  
**证据**：`packages/core/src/oidc/extra-token-claims.ts:327-329`

```javascript
const result = EnvSet.values.isCloud
  ? await libraries.jwtCustomizers.runScriptRemotely(payload)
  : await JwtCustomizerLibrary.runScriptInLocalVm(payload);
```

---

## 2. 错误类型与双链路行为对照矩阵

### 2.1 AccessDenied 错误

| 维度 | OSS 本地 VM | Cloud 远程执行 |
|------|------------|---------------|
| **触发条件** | 脚本调用 `api.denyAccess()` | 远程服务返回 `code: "access_denied"` |
| **错误传播路径** | 脚本中调用 `api.denyAccess()` 抛出异常 → `runInNewContext` 捕获 → 直接抛出到调用者 | 远程服务返回 HTTP 4xx → got/withtyped 抛出 HTTPError → 转换为 ResponseError → `isAccessDeniedError()` 识别 |
| **处理行为** | 抛出 `AccessDenied` 错误，阻止签发 ✅ | 抛出 `AccessDenied` 错误，阻止签发 ✅ |
| **证据位置** | `extra-token-claims.ts:332-334` | `extra-token-claims.ts:332-334` + `custom-jwt/index.ts:67-72` |
| **状态** | ✅ 已证实 | ✅ 已证实 |
| **配置影响** | `blockIssuanceOnError` 不影响此错误 | `blockIssuanceOnError` 不影响此错误 |

**关键代码**：`packages/core/src/utils/custom-jwt/index.ts:67-72`

```javascript
export const isAccessDeniedError = (
  error: unknown
): error is CustomJwtErrorBody & { code: CustomJwtErrorCode.AccessDenied } => {
  const errorData = customJwtErrorBodyGuard.safeParse(error);
  return errorData.success && errorData.data.code === CustomJwtErrorCode.AccessDenied;
};
```

---

### 2.2 执行超时错误

| 维度 | OSS 本地 VM | Cloud 远程执行 |
|------|------------|---------------|
| **触发条件** | 脚本运行超过 3 秒 | 远程服务调用超时 |
| **超时配置** | `{ timeout: 3000 }` 传递给 `runInNewContext` ✅ | 未在仓库中发现显式超时配置 ⚠️ |
| **错误类型** | `node:vm` 抛出超时错误 | HTTP 请求超时（ETIMEDOUT）或远程服务超时响应 |
| **默认行为** | fail-open，忽略错误，继续签发 ✅ | fail-open，忽略错误，继续签发 ✅ |
| **dev 模式行为** | 抛出 `invalid_request`，阻止签发 ✅ | 抛出 `invalid_request`，阻止签发 ✅ |
| **证据位置** | `local-vm.ts:60` | `extra-token-claims.ts:323-363` |
| **状态** | ✅ 已证实（OSS 超时值） | ⚠️ 推断（Cloud 超时值） |

**缺失证据（Cloud 超时）**：
- 仓库内未发现 Azure Function 调用的超时配置
- 未发现 Cloud Connection 客户端的超时配置
- **最小验证步骤**：在 Cloud 环境中配置一个执行 10 秒的脚本，观察实际超时时间
- **预期观测结果**：HTTP 客户端应有默认超时（如 10-30 秒），或远程服务有执行时间限制

---

### 2.3 语法错误

| 维度 | OSS 本地 VM | Cloud 远程执行 |
|------|------------|---------------|
| **触发条件** | 脚本代码语法无效 | 远程服务接收到语法错误的脚本 |
| **检测时机** | `runInNewContext` 执行脚本时立即抛出 ✅ | 远程服务执行脚本时检测到语法错误 ⚠️ |
| **错误类型** | `SyntaxError` 直接抛出 | 远程服务返回 HTTP 5xx 错误响应 |
| **错误解析** | 直接作为普通 Error 处理 | `parseAzureFunctionsResponseError()` 或 `parseCustomJwtResponseError()` 解析 |
| **默认行为** | fail-open，忽略错误，继续签发 ✅ | fail-open，忽略错误，继续签发 ✅ |
| **dev 模式行为** | 抛出 `invalid_request`，阻止签发 ✅ | 抛出 `invalid_request`，阻止签发 ✅ |
| **证据位置** | `extra-token-claims.ts:323-363` | `jwt-customizer.ts:302-320` + `custom-jwt/index.ts:82-107` |
| **状态** | ✅ 已证实 | ⚠️ 推断（远端检测语法错误的具体方式） |

**关键代码（Cloud 错误转换）**：`packages/core/src/utils/custom-jwt/index.ts:82-107`

```javascript
export const parseAzureFunctionsResponseError = (error: HTTPError): ResponseError => {
  // 解析 Azure Function 的 HTTP 错误响应
  // 转换为统一的 ResponseError 格式
};
```

---

### 2.4 运行时异常

| 维度 | OSS 本地 VM | Cloud 远程执行 |
|------|------------|---------------|
| **触发条件** | 脚本执行中抛出 Error（如 `throw new Error("oops")`） | 远程服务执行脚本时抛出异常 |
| **错误传播** | 异常直接从 `runInNewContext` 抛出 ✅ | 远程服务捕获异常并返回错误响应 ⚠️ |
| **错误信息** | 原始 Error 对象，包含 stack trace | 经过序列化的错误消息，可能丢失 stack trace |
| **默认行为** | fail-open，忽略错误，继续签发 ✅ | fail-open，忽略错误，继续签发 ✅ |
| **dev 模式行为** | 抛出 `invalid_request`，阻止签发 ✅ | 抛出 `invalid_request`，阻止签发 ✅ |
| **证据位置** | `extra-token-claims.ts:323-363` | `extra-token-claims.ts:323-363` |
| **状态** | ✅ 已证实 | ⚠️ 推断（远端异常捕获与序列化方式） |

---

### 2.5 返回值类型不符

| 维度 | OSS 本地 VM | Cloud 远程执行 |
|------|------------|---------------|
| **触发条件** | 返回 string/number/array/null 等非对象值 | 远程服务返回非 JSON 对象响应 |
| **校验点 1** | `z.record(z.unknown()).parse(result)` ✅ | 区域 Azure Function：`jsonObjectGuard.parse(result)` ✅ |
| **校验点 2** | - | Cloud Connection：由 withtyped 客户端进行类型校验 ⚠️ |
| **错误类型** | ZodError | ZodError（区域 Azure Function）或 ResponseError（Cloud Connection） |
| **默认行为** | fail-open，忽略错误，继续签发 ✅ | fail-open，忽略错误，继续签发 ✅ |
| **dev 模式行为** | 抛出 `invalid_request`，阻止签发 ✅ | 抛出 `invalid_request`，阻止签发 ✅ |
| **证据位置** | `jwt-customizer.ts:74-77` | `jwt-customizer.ts:311` |
| **状态** | ✅ 已证实 | ✅ 已证实（区域 Azure Function）/ ⚠️ 推断（Cloud Connection） |

**关键代码（OSS 校验）**：`packages/core/src/libraries/jwt-customizer.ts:74-77`

```javascript
const result = await runScriptFunctionInLocalVm(data.script, 'getCustomJwtClaims', payload);
return z.record(z.unknown()).parse(result);
```

**关键代码（Cloud 校验）**：`packages/core/src/libraries/jwt-customizer.ts:309-312`

```javascript
const result = await got.post(/* ... */).json<unknown>();
const parsedResult = jsonObjectGuard.parse(result);
return parsedResult;
```

---

### 2.6 序列化问题

| 维度 | OSS 本地 VM | Cloud 远程执行 |
|------|------------|---------------|
| **触发条件** | 返回值包含不可序列化内容（函数、Symbol、循环引用等） | 远程服务返回值包含不可序列化内容，或 HTTP 响应体无法解析为 JSON |
| **OSS 链路检测点** | 无显式序列化校验 ✅（证实：未发现 `JSON.stringify` 尝试） | 远程服务内部的 JSON 序列化 ⚠️ |
| **Cloud 链路检测点** | - | `got.json<unknown>()` 尝试解析响应体 ✅（解析失败会抛出 ParseError） |
| **错误发生阶段** | 可能在 oidc-provider JWT 生成阶段 ⚠️ | 可能在远程服务序列化阶段，或 got 解析阶段 ⚠️ |
| **默认行为** | 推断：取决于 oidc-provider 行为，可能 fail-open 也可能抛出 | 若 got 解析失败，视为执行错误，默认 fail-open ✅ |
| **证据位置** | 无直接代码证据 | `jwt-customizer.ts:302-309` |
| **状态** | ⚠️ 推断 | ⚠️ 部分证实（HTTP 解析失败）/ ⚠️ 推断（远程序列化失败） |

**缺失证据说明**：
- 仓库内无测试用例覆盖返回不可序列化值的场景
- 无法确认 oidc-provider 在序列化失败时的具体行为
- **最小验证步骤（OSS）**：配置脚本返回 `{ func: () => {} }`，观察令牌是否签发成功
- **预期观测结果（OSS）**：可能抛出 JSON 序列化错误导致签发失败，也可能静默忽略函数字段
- **最小验证步骤（Cloud）**：配置脚本返回含循环引用的对象，观察 HTTP 响应
- **预期观测结果（Cloud）**：远程服务可能返回 500 错误，或 got 解析失败

---

### 2.7 网络错误（Cloud 特有）

| 维度 | OSS 本地 VM | Cloud 远程执行 |
|------|------------|---------------|
| **触发条件** | N/A（本地执行，无网络） | 网络中断、DNS 失败、远程服务不可用 |
| **错误类型** | N/A | got 抛出系统错误（如 ECONNREFUSED、ENOTFOUND） |
| **处理逻辑** | N/A | 错误未被 `ResponseError` 捕获，进入通用错误处理分支 |
| **默认行为** | N/A | fail-open，忽略错误，继续签发 ✅ |
| **dev 模式行为** | N/A | 抛出 `invalid_request`，阻止签发 ✅ |
| **证据位置** | N/A | `extra-token-claims.ts:361-363` |
| **状态** | ✅ 已证实 | ✅ 已证实 |

**关键代码**：`packages/core/src/oidc/extra-token-claims.ts:361-363`

```javascript
// 其他错误（非 ResponseError）同样根据配置决定
if (shouldBlockIssuanceOnError) {
  throwJwtCustomizerInvalidRequest(ctx, error.message);
}
```

---

## 3. 错误分流统一处理逻辑

### 3.1 错误处理核心流程图

```
脚本执行（本地 VM 或 Cloud 远程）
    ↓
成功？→ 是 → 返回声明对象 → 合并到 extraTokenClaims
    ↓ 否
错误类型判断
    ├─→ AccessDenied？→ 是 → 抛出 AccessDenied 错误 → 阻止签发 ✅
    └─→ 其他错误？
        ├─→ blockIssuanceOnError = true（dev）→ 抛出 invalid_request → 阻止签发 ✅
        └─→ blockIssuanceOnError = false（默认）→ return undefined → fail-open ✅
```

**证据**：`packages/core/src/oidc/extra-token-claims.ts:323-363`

### 3.2 功能标志保护

**结论**：`blockIssuanceOnError` 受 `isDevFeaturesEnabled` 功能标志保护  
**状态**：✅ 已证实  
**证据**：`packages/core/src/oidc/extra-token-claims.ts:213-214`

```javascript
const shouldBlockIssuanceOnError =
  EnvSet.values.isDevFeaturesEnabled && Boolean(blockIssuanceOnError);
```

**集成测试证据**：
- 开发模式生效：`packages/integration-tests/src/tests/api/oidc/client-credentials-grant.test.ts:294-325`
- 非开发模式强制 fail-open：同上文件 327-342

---

## 4. 声明可覆盖性（保留自 v3.0）

### 4.1 合并优先级

**结论**：自定义脚本声明 > 组织 API 资源声明 > Token Exchange 声明  
**状态**：✅ 已证实  
**证据**：`packages/core/src/oidc/init.ts:267-294`

### 4.2 可覆盖字段清单

**状态**：✅ 已证实  
**证据**：`packages/schemas/src/types/logto-config/oidc-provider.ts:11-38`

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

## 5. 证据缺口汇总与验证建议

### 5.1 已识别的证据缺口

| 待确认项 | 缺失证据说明 | 最小验证步骤 | 预期观测结果 |
|---------|-------------|-------------|-------------|
| Cloud 远程执行超时时间 | 未发现 Azure Function / Cloud Connection 的超时配置 | 在 Cloud 环境中配置一个执行 10 秒的脚本，观察实际超时时间 | HTTP 客户端应有默认超时（如 10-30 秒），或远程服务有执行时间限制 |
| Cloud 语法错误检测方式 | 未发现远程服务如何检测语法错误 | 配置语法错误的脚本，观察 Cloud 环境返回的错误响应格式 | 应返回包含错误信息的 JSON 响应，错误码为 `general` 或类似 |
| OSS 序列化失败行为 | 无测试验证返回不可序列化值后的具体行为 | 配置脚本返回 `{ func: () => {} }`，观察令牌是否签发成功 | 可能抛出 JSON 序列化错误，也可能静默忽略函数字段 |
| Cloud 序列化失败行为 | 未发现远程服务如何处理序列化失败 | 配置脚本返回含循环引用的对象，观察 HTTP 响应 | 远程服务可能返回 500 错误，或 got 解析失败 |
| 覆盖 `exp`/`iat`/`iss` 的实际效果 | 无测试验证脚本返回这些字段后的最终令牌内容 | 配置脚本返回 `{ exp: 9999999999 }`，解码验证最终令牌 | 这些字段可能被 oidc-provider 内部计算的值覆盖 |
| Cloud 网络错误处理 | 无测试验证网络不可用时的行为 | 模拟网络中断，观察令牌签发是否继续 | 默认 fail-open，dev 模式下阻止签发 |

### 5.2 审慎使用建议

对于标记为「推断」的结论，在生产环境使用前建议：
1. 通过实际测试验证行为（参考上表的最小验证步骤）
2. 避免依赖未证实的行为（如尝试覆盖 `exp`/`iat`/`iss`）
3. 确保返回值可 JSON 序列化，避免依赖隐式容错行为
4. Cloud 环境中增加对远程服务可用性的监控

---

## 6. 多模块协作关系

### 6.1 模块职责与证据矩阵

| 模块 | 文件路径 | 核心职责 | 可证实的关键行为 |
|------|---------|---------|----------------|
| **OIDC 初始化** | `packages/core/src/oidc/init.ts` | 配置 oidc-provider，注册 `extraTokenClaims` 钩子 | 声明合并顺序（267-294）✅ |
| **额外声明处理** | `packages/core/src/oidc/extra-token-claims.ts` | 实现三类声明源的获取逻辑 | 错误分流逻辑（323-363）✅<br>功能标志保护（213-214）✅<br>IN_PAYLOAD 字段提取（219-227）✅<br>链路选择逻辑（327-329）✅ |
| **JWT 自定义库** | `packages/core/src/libraries/jwt-customizer.ts` | 脚本执行、上下文构建 | OSS 返回值类型校验（74-77）✅<br>Cloud 远程调用（294-329）✅<br>Cloud 返回值类型校验（311）✅ |
| **本地 VM 工具** | `packages/core/src/utils/custom-jwt/local-vm.ts` | 安全沙箱执行环境 | 3 秒超时（56-61）✅<br>冻结全局上下文（40, 58）✅ |
| **自定义 JWT 工具** | `packages/core/src/utils/custom-jwt/index.ts` | 错误解析与转换 | AccessDenied 检测（67-72）✅<br>Azure 错误转换（82-107）✅ |
| **类型定义** | `packages/schemas/src/types/logto-config/oidc-provider.ts` | token payload 结构定义 | IN_PAYLOAD 字段清单（11-38）✅ |
| **集成测试** | `packages/integration-tests/src/tests/api/oidc/**` | 端到端行为验证 | 自定义声明出现在令牌中 ✅<br>功能标志行为验证 ✅ |

---

## 修订记录

- **v4.0（当前版本）**：Cloud/OSS 双链路对照版，新增 7 类错误的双链路行为对照矩阵，标注每格的证实状态和证据位置
- **v3.0**：证据分层收敛版，每条结论标注「已证实」或「推断」
- **v2.0**：证据化复核版，明确了可覆盖/不可覆盖字段清单和返回值约束
- **v1.0**：初始分析版本，提供整体框架
