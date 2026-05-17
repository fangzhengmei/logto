# JWT 自定义脚本声明合并行为分析（最终版）

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

#### 📋 推断条目补全（Cloud 超时）

- **缺失证据**：
  1. 仓库内未发现 Azure Function 调用（got 客户端）的超时配置
  2. 未发现 Cloud Connection（withtyped 客户端）的超时配置
  3. 未发现远程服务（Azure Function / Cloudflare Workers）的执行时间限制配置

- **最小验证步骤**：
  1. 准备一个包含 `await new Promise(resolve => setTimeout(resolve, 10000))` 的脚本，配置到 Cloud 环境
  2. 调用令牌签发接口，记录从请求发起到收到响应的时间
  3. 检查响应中是否包含自定义声明
  4. 检查日志中是否有超时相关的错误信息

- **预期观测结果**：
  - 可能结果 A（HTTP 客户端超时）：请求在 10-30 秒内返回，令牌不包含自定义声明，日志记录超时错误
  - 可能结果 B（远程服务超时）：远程服务在执行时间限制（如 5 秒）后返回错误响应
  - 可能结果 C（无超时）：请求在 10 秒后成功返回，令牌包含自定义声明

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

#### 📋 推断条目补全（Cloud 语法错误检测）

- **缺失证据**：
  1. 未发现远程服务（Azure Function / Cloudflare Workers）如何检测和处理语法错误
  2. 未发现远程服务返回的语法错误响应格式的明确定义
  3. 未发现远程服务是否会在语法错误时返回 stack trace

- **最小验证步骤**：
  1. 配置包含语法错误的脚本（如 `const x = ;`）到 Cloud 环境
  2. 调用令牌签发接口
  3. 捕获并检查 HTTP 响应的状态码和响应体
  4. 检查最终令牌是否签发成功

- **预期观测结果**：
  - HTTP 响应状态码应为 400 或 500
  - 响应体应为 JSON 格式，包含 `message` 字段描述语法错误
  - 可能包含 `error.code` 字段，值为 `general` 或 `syntax_error`
  - 默认模式下令牌应签发成功（fail-open），不包含自定义声明
  - dev 模式下应返回 `invalid_request` 错误

---

### 2.4 运行时异常

| 维度 | OSS 本地 VM | Cloud 远程执行 |
|------|------------|---------------|
| **触发条件** | 脚本执行中抛出 Error（如 `throw new Error("oops")` | 远程服务执行脚本时抛出异常 |
| **错误传播** | 异常直接从 `runInNewContext` 抛出 ✅ | 远程服务捕获异常并返回错误响应 ⚠️ |
| **错误信息** | 原始 Error 对象，包含 stack trace | 经过序列化的错误消息，可能丢失 stack trace |
| **默认行为** | fail-open，忽略错误，继续签发 ✅ | fail-open，忽略错误，继续签发 ✅ |
| **dev 模式行为** | 抛出 `invalid_request`，阻止签发 ✅ | 抛出 `invalid_request`，阻止签发 ✅ |
| **证据位置** | `extra-token-claims.ts:323-363` | `extra-token-claims.ts:323-363` |
| **状态** | ✅ 已证实 | ⚠️ 推断（远端异常捕获与序列化方式） |

#### 📋 推断条目补全（Cloud 运行时异常处理）

- **缺失证据**：
  1. 未发现远程服务如何捕获脚本执行中的异常
  2. 未发现远程服务是否会保留原始异常的 stack trace
  3. 未发现远程服务是否会对异常信息进行脱敏处理

- **最小验证步骤**：
  1. 配置脚本 `throw new Error("test-runtime-error")` 到 Cloud 环境
  2. 调用令牌签发接口
  3. 捕获并检查 HTTP 响应体
  4. 检查日志中的错误记录

- **预期观测结果**：
  - HTTP 响应状态码应为 500
  - 响应体包含 `message` 字段，值为 `"test-runtime-error"`
  - 可能包含 `error` 字段，包含异常详情
  - stack trace 可能被截断或省略
  - 默认模式下令牌应签发成功（fail-open）
  - dev 模式下应返回 `invalid_request` 错误

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

#### 📋 推断条目补全（Cloud Connection 返回值校验）

- **缺失证据**：
  1. 未发现 Cloud Connection（withtyped 客户端）对返回值的类型校验逻辑
  2. 未发现 withtyped 客户端在类型不匹配时的错误处理方式
  3. 未发现 Cloud Connection 路径的实际使用场景（何时使用区域 Azure Function，何时使用 Cloud Connection）

- **最小验证步骤**：
  1. 配置脚本返回字符串 `"not-an-object"` 到 Cloud 环境（确保走 Cloud Connection 路径）
  2. 调用令牌签发接口
  3. 检查响应状态码和响应体
  4. 检查最终令牌是否签发成功

- **预期观测结果**：
  - withtyped 客户端应抛出类型错误
  - 错误被 `ResponseError` 捕获
  - 默认模式下令牌应签发成功（fail-open）
  - dev 模式下应返回 `invalid_request` 错误

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

#### 📋 推断条目补全（OSS 序列化失败行为）

- **缺失证据**：
  1. 仓库内无测试用例覆盖返回不可序列化值的场景
  2. 无法确认 oidc-provider 在序列化失败时的具体行为
  3. 未发现 oidc-provider 对 extraTokenClaims 返回值进行 JSON 序列化的代码

- **最小验证步骤**：
  1. 配置脚本返回 `{ func: () => {}, regularField: "value" }`
  2. 调用令牌签发接口
  3. 检查令牌是否签发成功
  4. 若签发成功，解码令牌检查 payload 内容

- **预期观测结果**：
  - 可能结果 A（静默忽略）：令牌签发成功，payload 中 `func` 字段被忽略，`regularField` 存在
  - 可能结果 B（抛出错误）：令牌签发失败，返回 JSON 序列化错误
  - 可能结果 C（部分成功）：令牌签发成功，但 `func` 字段被序列化为 `undefined` 或空对象

#### 📋 推断条目补全（Cloud 序列化失败行为）

- **缺失证据**：
  1. 未发现远程服务如何处理序列化失败
  2. 未发现 `got.json<unknown>()` 解析失败后的错误类型
  3. 未发现 got 解析失败是否会被 `ResponseError` 捕获

- **最小验证步骤**：
  1. 配置脚本返回含循环引用的对象：`const obj = {}; obj.self = obj; return obj;`
  2. 调用令牌签发接口
  3. 检查 HTTP 响应状态码和响应体
  4. 检查最终令牌是否签发成功

- **预期观测结果**：
  - 可能结果 A（远程序列化失败）：远程服务返回 500 错误，错误信息包含 "Converting circular structure to JSON"
  - 可能结果 B（got 解析失败）：远程服务返回非 JSON 响应，got 抛出 ParseError
  - 可能结果 C（静默忽略）：远程服务静默忽略循环引用，返回截断的 JSON
  - 默认模式下，若错误被捕获，令牌应签发成功（fail-open）
  - dev 模式下应返回 `invalid_request` 错误

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

## 4. 声明可覆盖性

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

#### 📋 推断条目补全（oidc-provider 字段覆盖性）

- **缺失证据**：
  1. 仓库内未包含 oidc-provider 的 JWT 生成源码
  2. 无集成测试验证脚本返回 `exp`/`iat`/`iss` 后的实际行为
  3. 无法在仓库内直接核对 oidc-provider 的内部合并逻辑

- **最小验证步骤**：
  1. 配置脚本返回 `{ exp: 9999999999, iat: 0, iss: "https://fake-issuer.com" }`
  2. 调用令牌签发接口
  3. 解码返回的令牌，检查 payload 中的 `exp`/`iat`/`iss` 字段值

- **预期观测结果**：
  - 可能结果 A（被覆盖）：`exp`/`iat`/`iss` 字段值与脚本返回值一致
  - 可能结果 B（被忽略）：`exp`/`iat`/`iss` 字段值为 oidc-provider 内部计算值，脚本返回值被忽略
  - 可能结果 C（部分覆盖）：部分字段被覆盖，部分字段被忽略

---

## 5. 所有推断条目汇总表

| 推断条目 | 所属章节 | 缺失证据 | 最小验证步骤 | 预期观测结果 |
|---------|---------|-----------|-------------|-------------|
| Cloud 远程执行超时时间 | 2.2 | Azure Function / Cloud Connection 超时配置未发现 | 配置执行 10 秒的脚本，观察实际超时时间 | HTTP 客户端默认超时 10-30 秒，或远程服务有执行时间限制 |
| Cloud 语法错误检测方式 | 2.3 | 远程服务语法错误检测和响应格式未发现 | 配置语法错误的脚本，观察 Cloud 环境错误响应格式 | 返回包含错误信息的 JSON 响应，错误码为 `general` 或类似 |
| Cloud 运行时异常处理 | 2.4 | 远程服务异常捕获与序列化方式未发现 | 配置 `throw new Error("test")` 的脚本，观察响应格式 | 返回包含错误消息的 JSON 响应，可能丢失 stack trace |
| Cloud Connection 返回值校验 | 2.5 | withtyped 客户端类型校验逻辑未发现 | 配置返回字符串的脚本，观察 Cloud Connection 路径的错误处理 | withtyped 客户端抛出类型错误，被 ResponseError 捕获 |
| OSS 序列化失败行为 | 2.6 | oidc-provider 序列化失败行为未发现 | 配置返回 `{ func: () => {} }` 的脚本，观察令牌是否签发成功 | 可能抛出 JSON 序列化错误，也可能静默忽略函数字段 |
| Cloud 序列化失败行为 | 2.6 | 远程服务序列化失败处理未发现 | 配置返回含循环引用对象的脚本，观察 HTTP 响应 | 远程服务可能返回 500 错误，或 got 解析失败 |
| oidc-provider 字段覆盖性 | 4.2 | oidc-provider JWT 生成源码未包含 | 配置返回 `{ exp: 9999999999 }` 的脚本，解码验证最终令牌 | 这些字段可能被 oidc-provider 内部计算的值覆盖 |

---

## 6. 审慎使用建议

对于标记为「推断」的结论，在生产环境使用前强烈建议：

1. **通过实际测试验证行为**（参考上表的最小验证步骤）
2. **避免依赖未证实的行为**（如尝试覆盖 `exp`/`iat`/`iss`）
3. **确保返回值可 JSON 序列化**，避免依赖隐式容错行为
4. **Cloud 环境中增加对远程服务可用性的监控**
5. **不要假设错误处理行为**：在脚本内部做好异常捕获，避免依赖系统级别的错误处理
6. **关键业务逻辑不要放在自定义脚本中**：自定义脚本失败可能因为各种原因被静默忽略

---

## 7. 多模块协作关系

### 7.1 模块职责与证据矩阵

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

- **v5.0（最终版）**：系统整理所有推断条目，为每条补全缺失证据、最小验证步骤、预期观测结果，新增「所有推断条目汇总表」
- **v4.0**：Cloud/OSS 双链路对照版，新增 7 类错误的双链路行为对照矩阵
- **v3.0**：证据分层收敛版，每条结论标注「已证实」或「推断」
- **v2.0**：证据化复核版，明确了可覆盖/不可覆盖字段清单和返回值约束
- **v1.0**：初始分析版本，提供整体框架
