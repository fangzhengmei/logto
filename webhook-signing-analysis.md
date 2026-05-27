# Logto Webhook 签名生成与事件投递机制分析

---

## 一、签名拼接：HMAC-SHA256 对完整 Payload 签名

### 1.1 算法与输入

**核心代码**: `packages/core/src/utils/sign.ts:3-8`

```typescript
export const sign = (signingKey: string, payload: Record<string, unknown>) => {
  const hmac = createHmac('sha256', signingKey);
  const payloadString = JSON.stringify(payload);
  hmac.update(payloadString);
  return hmac.digest('hex');
};
```

**签名输入**:
- 算法: `HMAC-SHA256`
- 密钥: 用户在创建 Webhook 时配置的 `signingKey`（存储在 `hooks.signing_key` 字段）
- 消息: `JSON.stringify(payload)` 的完整字符串

**签名输出**:
- 64 字符十六进制字符串
- 通过 `logto-signature-sha-256` 请求头传输

### 1.2 Payload 结构

签名覆盖完整的 payload 对象，包含以下字段：

| 字段 | 交互类 Hook | 数据类 Hook | 说明 |
|------|:-----------:|:-----------:|------|
| `hookId` | ✅ | ✅ | Webhook ID |
| `event` | ✅ | ✅ | 事件类型 (如 `PostSignIn`, `Role.Created`) |
| `createdAt` | ✅ | ✅ | ISO 8601 时间戳 |
| `interactionEvent` | ✅ | ❌ | 交互事件 (如 `SignIn`, `Register`) |
| `sessionId` | ✅ | ❌ | 会话 ID |
| `userId` | ✅ | ❌ | 用户 ID |
| `userIp` | ✅ | ❌ | 用户 IP |
| `userAgent` | ✅ | ✅ | User-Agent |
| `user` | ✅ | ❌ | 用户信息对象 |
| `application` | ✅ | 可选 | 应用信息对象 |
| `path` | ❌ | ✅ | API 路径 |
| `method` | ❌ | ✅ | HTTP 方法 |
| `status` | ❌ | ✅ | 响应状态码 |
| `params` | ❌ | ✅ | 请求参数 |
| `data` | ❌ | ✅ | 响应数据 |

---

## 二、POST 重试的真相：配置与实际行为的落差

### 2.1 `retries` 配置的来源与生命周期

**Schema 定义**: `packages/schemas/src/foundations/jsonb-types/hooks.ts:100-114`

```typescript
export const hookConfigGuard = z.object({
  url: z.string(),
  headers: z.record(z.string()).optional(),
  /**
   * @deprecated
   * Retry times when hook response status >= 500.
   * Now the retry times is fixed to 3.
   * Keep for backward compatibility.
   */
  retries: z.number().gte(0).lte(3).optional(),
});
```

**配置来源**:
- 存储在 `hooks.config` JSONB 字段中
- 用户通过 Console UI 或 Management API 设置
- 值域: `0-3`，默认为 `3`
- **状态**: 已标记 `@deprecated`，注释明确说明"现在固定为 3"

### 2.2 实际发送代码

**核心代码**: `packages/core/src/libraries/hook/utils.ts:32-49`

```typescript
export const sendWebhookRequest = async ({
  hookConfig,
  payload,
  signingKey,
}: SendWebhookRequest) => {
  const { url, headers, retries } = hookConfig;

  return ky.post(url, {
    headers: {
      'user-agent': 'Logto (https://logto.io/)',
      ...headers,
      ...conditional(signingKey && { 'logto-signature-sha-256': sign(signingKey, payload) }),
    },
    json: payload,
    retry: { limit: retries ?? 3 },
    timeout: 10_000,
  });
};
```

**关键观察**: 代码只设置了 `retry: { limit: retries ?? 3 }`，**没有覆盖 `methods` 字段**。

### 2.3 Ky 默认重试配置（ky ^1.2.3）

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `limit` | `2` | 被 Logto 覆盖为 `3` |
| `methods` | `get`, `put`, `head`, `delete`, `options`, `trace` | **POST 不在其中** |
| `statusCodes` | `408`, `413`, `429`, `500-599` | 触发重试的状态码 |
| `delay` | `0.3 * (2^(attempt-1)) * 1000` ms | 指数退避 |
| `retryOnTimeout` | `false` | 超时不重试 |

### 2.4 核心结论：POST Webhook 实际不重试

由于 ky 的 `methods` 配置不包含 `POST`，Logto Webhook 的 POST 请求在以下场景**都不会重试**：

| 失败场景 | 是否重试 | 原因 |
|---------|:--------:|------|
| 接收方返回 5xx | ❌ | POST 不在 `methods` 中 |
| 接收方返回 429 | ❌ | POST 不在 `methods` 中 |
| 网络连接失败 (DNS/连接拒绝) | ❌ | 网络错误仅对 retriable methods 重试 |
| 请求超时 (10s) | ❌ | `retryOnTimeout` 默认为 `false` |

**`retries` 配置实质上对 POST Webhook 无效**。它仅控制了 `limit` 参数，但由于 `methods` 不包含 POST，整个重试机制对 POST 请求被禁用。

---

## 三、退避策略：理论存在但实际不生效

### 3.1 指数退避公式

Ky 的默认退避算法（仅在 GET/PUT 等 retriable methods 生效）：

```
delay(attempt) = 0.3 × 2^(attempt - 1) × 1000  ms
```

### 3.2 退避时间线（假设 POST 能重试）

| 阶段 | 时间点 | 事件 |
|------|--------|------|
| T=0 | 初始请求发出 | 第一次尝试 |
| T=10s | 请求超时或收到响应 | 等待超时/响应 |
| T=10.3s | 第 1 次重试 | 等待 300ms 后重发 |
| T=20.3s | 第 1 次重试超时 | 等待超时 |
| T=20.9s | 第 2 次重试 | 等待 600ms 后重发 |
| T=30.9s | 第 2 次重试超时 | 等待超时 |
| T=32.1s | 第 3 次重试 | 等待 1200ms 后重发 |
| T=42.1s | 最终失败 | 所有重试耗尽，抛出错误 |

**总耗时**: 约 42 秒（3 次重试 + 10s 超时 + 2.1s 退避）

### 3.3 实际时间线（POST Webhook 真实行为）

| 阶段 | 时间点 | 事件 |
|------|--------|------|
| T=0 | 初始请求发出 | 唯一的一次尝试 |
| T=10s | 请求超时或收到响应 | 无重试，直接失败或成功 |

**总耗时**: 最多 10 秒，**一次失败即终局**。

---

## 四、投递队列与并发控制

### 4.1 并发策略

**核心代码**: `packages/core/src/libraries/hook/index.ts:92-98`

```typescript
const sendWebhooks = async <T extends HookEventPayloadWithoutHookId>(
  webhooks: Array<{ hook: Hook; payload: T }>,
  consoleLog: ConsoleLog
) =>
  pMap(webhooks, async ({ hook, payload }) => sendWebhook(hook, payload, consoleLog), {
    concurrency: 10,
  });
```

| 参数 | 值 | 说明 |
|------|-----|------|
| 并发库 | `p-map` | 支持并发控制的 Promise 映射 |
| 最大并发数 | `10` | 同时最多 10 个 Webhook 在途 |
| 失败隔离 | ✅ | 单个失败不影响其他 |
| 阻塞主请求 | ❌ | 异步投递，不阻塞 API 响应 |

### 4.2 触发流程

```
业务请求
  │
  ├─→ HookContextManager 收集事件（交互/数据/异常）
  │
  └─→ 业务处理完成后
        │
        ├─ 1. 查询所有启用的 Hook (findAllHooks)
        ├─ 2. 按 event 匹配 Hook 配置
        ├─ 3. 批量查询用户/应用信息
        ├─ 4. 组装完整 payload
        └─ 5. pMap(concurrency=10) 并发发送
              │
              ├─ 成功 → 写 Success 日志
              └─ 失败 → 写 Error 日志（无重试）
```

---

## 五、失败处理与审计

### 5.1 审计日志

**核心代码**: `packages/core/src/libraries/hook/index.ts:46-87`

每次 Webhook 触发都会写入 `logs` 表：

```typescript
logEntry.append({
  hookId: id,
  hookRequest: { body: json },      // 请求 payload
  result: LogResult.Success | Error, // 成功或失败
  response: { statusCode, body },   // 响应状态和内容
  error: String(normalizeError(error)), // 错误信息
});
```

**日志 Key 格式**: `TriggerHook.<EventName>`

### 5.2 无死信队列

- 当前实现**没有内置死信队列（DLQ）**
- 失败的 Webhook 不会自动重新入队
- 只能通过管理后台手动"重新发送测试"来触发
- 依赖运维人员监控日志告警

---

## 六、接收方签名验证

### 6.1 Node.js 验证示例

```javascript
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyLogtoWebhook(rawBody, signatureHeader, signingKey) {
  const hmac = createHmac('sha256', signingKey);
  hmac.update(rawBody);
  const expectedSignature = hmac.digest('hex');

  return timingSafeEqual(
    Buffer.from(signatureHeader),
    Buffer.from(expectedSignature)
  );
}
```

### 6.2 关键注意事项

1. **必须使用原始请求体**：不能用 `JSON.parse()` 后再 `stringify()`，键顺序可能不同
2. **时间安全比较**：使用 `timingSafeEqual` 防止时序攻击
3. **重放防护**：可选校验 `createdAt` 时间戳（如 5 分钟内有效）
4. **幂等处理**：由于一次投递可能重复（网络层面），建议用 `hookId + event + createdAt` 作为幂等键

---

## 七、总结

| 维度 | 实际情况 |
|------|---------|
| **签名算法** | HMAC-SHA256，签名覆盖完整 JSON payload |
| **retries 配置** | 已弃用（@deprecated），名义上固定为 3 |
| **POST 5xx 重试** | ❌ 不重试（ky 默认 methods 不含 POST） |
| **POST 网络错误重试** | ❌ 不重试（仅 retriable methods 生效） |
| **POST 超时重试** | ❌ 不重试（`retryOnTimeout` 默认为 false） |
| **退避策略** | 理论存在（指数退避），但对 POST 无效 |
| **并发控制** | p-map，最大 10 并发 |
| **失败处理** | 写审计日志，无死信队列 |

---

## 八、代码引用清单

| 功能模块 | 文件路径 | 行号 |
|---------|---------|------|
| 签名算法 | `packages/core/src/utils/sign.ts` | 3-8 |
| Webhook 请求发送 | `packages/core/src/libraries/hook/utils.ts` | 32-49 |
| 并发投递控制 | `packages/core/src/libraries/hook/index.ts` | 92-98 |
| 审计日志记录 | `packages/core/src/libraries/hook/index.ts` | 46-87 |
| 交互 Hook 触发 | `packages/core/src/libraries/hook/index.ts` | 118-185 |
| 数据 Hook 触发 | `packages/core/src/libraries/hook/index.ts` | 190-199 |
| HookConfig Schema | `packages/schemas/src/foundations/jsonb-types/hooks.ts` | 100-114 |
