# Logto Webhook 签名生成与事件投递机制分析

## 一、签名生成机制

### 1.1 签名算法与拼接方式

**核心代码位置**: `packages/core/src/utils/sign.ts:1-8`

```typescript
export const sign = (signingKey: string, payload: Record<string, unknown>) => {
  const hmac = createHmac('sha256', signingKey);
  const payloadString = JSON.stringify(payload);
  hmac.update(payloadString);
  return hmac.digest('hex');
};
```

**签名拼接规则**:
- **算法**: HMAC-SHA256
- **密钥**: 用户配置的 `signingKey`（Hook 表中存储）
- **消息体**: 完整的 payload 对象经过 `JSON.stringify()` 后的字符串
- **输出格式**: 十六进制字符串 (hex digest)

**请求头传输**:
在 `packages/core/src/libraries/hook/utils.ts:43` 中，签名通过 HTTP 头发送：
```
logto-signature-sha-256: <hmac_hex_digest>
```

### 1.2 Payload 结构组成

**交互类 Hook (Interaction Hook)**:
- `event`: 事件类型（如 `PostSignIn`, `PostRegister`）
- `interactionEvent`: 交互事件（如 `SignIn`, `Register`）
- `createdAt`: ISO 格式时间戳
- `sessionId`: 会话 ID
- `userId`: 用户 ID
- `userIp`: 用户 IP
- `userAgent`: 用户代理
- `user`: 用户信息对象
- `application`: 应用信息对象
- `hookId`: Webhook ID

**数据类 Hook (Data Hook)**:
- `event`: 事件类型（如 `Role.Created`）
- `createdAt`: ISO 格式时间戳
- `path`: API 路径
- `method`: HTTP 方法
- `status`: 响应状态码
- `params`: 请求参数
- `data`: 响应数据
- `hookId`: Webhook ID

---

## 二、事件投递队列与并发控制

### 2.1 并发控制策略

**核心代码位置**: `packages/core/src/libraries/hook/index.ts:92-98`

```typescript
const sendWebhooks = async <T extends HookEventPayloadWithoutHookId>(
  webhooks: Array<{ hook: Hook; payload: T }>,
  consoleLog: ConsoleLog
) =>
  pMap(webhooks, async ({ hook, payload }) => sendWebhook(hook, payload, consoleLog), {
    concurrency: 10,
  });
```

**队列特性**:
- **并发库**: `p-map`
- **最大并发数**: 10
- **处理模式**: 并行异步处理，非阻塞
- **触发时机**: 业务流程结束后异步触发，不阻塞主请求

### 2.2 Hook 触发流程

1. **上下文收集阶段**:
   - `HookContextManager` 收集请求生命周期内的所有 Hook 事件
   - 交互类 Hook 在交互流程结束时触发
   - 数据类 Hook 在 Management API 调用后批量触发

2. **Hook 匹配阶段**:
   - 从数据库查询所有启用的 Hook (`findAllHooks`)
   - 根据 `event` 字段匹配对应的 Hook 配置
   - 支持单事件多 Hook（一个事件可以触发多个配置的 Webhook）

3. **用户/应用信息装配**:
   - 批量查询用户信息（去重优化）
   - 查询应用信息（如果有 `applicationId`）
   - 组装完整 payload

4. **并发投递**:
   - 通过 `pMap` 以 10 并发发送
   - 每个 Webhook 独立失败，互不影响

---

## 三、重试退避策略

### 3.1 HTTP 客户端重试配置

**核心代码位置**: `packages/core/src/libraries/hook/utils.ts:32-49`

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

### 3.2 Ky 库默认重试行为

**默认重试配置**（基于 ky ^1.2.3）:

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `limit` | 3（可配置） | 最大重试次数 |
| `methods` | `get`, `put`, `head`, `options`, `delete`, `trace` | **注意**: POST 默认不在重试列表中 |
| `statusCodes` | `408`, `413`, `429`, `500-599` | 触发重试的 HTTP 状态码 |
| `errorCodes` | 网络错误类 | `ETIMEDOUT`, `ECONNRESET`, `EADDRINUSE`, `ECONNREFUSED`, `EPIPE`, `ENOTFOUND`, `ENETUNREACH`, `EAI_AGAIN` |

### 3.3 指数退避算法

**默认延迟计算公式**:
```
delay = 0.3 * (2 ** (attemptCount - 1)) * 1000  ms
```

**重试延迟示例**（默认配置）:

| 重试次数 | 延迟时间 | 累计等待 |
|---------|---------|---------|
| 第 1 次重试 | 300ms | 300ms |
| 第 2 次重试 | 600ms | 900ms |
| 第 3 次重试 | 1200ms | 2100ms |

**总最大等待**: ~2.1 秒（不含请求本身耗时）

### 3.4 超时设置

- **单次请求超时**: 10 秒
- **最坏情况耗时**: 10s * 4 次（1 次初始 + 3 次重试）= 40 秒
- **含退避总耗时**: 约 42 秒

---

## 四、关键设计考量

### 4.1 POST 方法重试的特殊性

⚠️ **重要注意**: Ky 默认**不会**对 POST 请求进行重试！

**原因**:
- POST 通常是非幂等操作
- 重复投递可能导致业务侧重复处理

**Logto 的处理**:
- 直接使用 `ky.post()`，依赖 Ky 默认行为
- 即：网络错误会重试，但 5xx 响应**不会**重试 POST

### 4.2 投递保证等级

**At-Least-Once 语义**:
- 由于网络分区等问题，存在重复投递可能性
- 接收方应实现幂等处理
- 建议使用 `hookId + event + createdAt` 作为幂等键

### 4.3 失败处理机制

**审计日志**:
- 每次 Webhook 触发都会写入日志表 (`logs`)
- 记录请求 payload、响应状态、错误信息
- 可通过管理后台查看执行历史

**无死信队列**:
- 当前版本无内置死信队列（DLQ）
- 失败后不会重新入队
- 依赖人工排查和重试

---

## 五、签名验证示例（接收方实现）

### Node.js 验证示例

```javascript
import { createHmac } from 'node:crypto';

function verifyWebhookSignature(payload, signatureHeader, signingKey) {
  const hmac = createHmac('sha256', signingKey);
  // 注意：必须使用原始请求体，不能是解析后再序列化的
  const payloadString = JSON.stringify(payload); 
  hmac.update(payloadString);
  const expectedSignature = hmac.digest('hex');
  
  // 使用时间安全的比较方式
  return crypto.timingSafeEqual(
    Buffer.from(signatureHeader),
    Buffer.from(expectedSignature)
  );
}
```

### 验证注意事项

1. **原始请求体**: 必须使用接收到的原始字节，不能使用 JSON.parse 后再 stringify（键顺序可能变化）
2. **时间安全比较**: 使用 `timingSafeEqual` 防止时序攻击
3. **签名头**: 读取 `logto-signature-sha-256` 请求头
4. **重放防护**: 可选校验 `createdAt` 时间戳（如 5 分钟内有效）

---

## 六、代码引用清单

| 功能模块 | 文件路径 | 行号 |
|---------|---------|------|
| 签名算法 | `packages/core/src/utils/sign.ts` | 1-8 |
| Webhook 请求发送 | `packages/core/src/libraries/hook/utils.ts` | 32-49 |
| 并发投递控制 | `packages/core/src/libraries/hook/index.ts` | 92-98 |
| 交互 Hook 触发逻辑 | `packages/core/src/libraries/hook/index.ts` | 118-185 |
| 数据 Hook 触发逻辑 | `packages/core/src/libraries/hook/index.ts` | 190-199 |
| 审计日志记录 | `packages/core/src/libraries/hook/index.ts` | 46-87 |
