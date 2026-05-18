# 受保护应用（Protected App）会话建立路径分析

## 概述

受保护应用是 Logto 提供的一种**无 SDK 集成方案**，基于 Cloudflare Workers 实现反向代理层，在不修改上游应用代码的前提下提供身份认证保护。

```
用户浏览器 → Cloudflare Worker（反向代理） → Logto OIDC 服务
                                      ↓
                              上游应用（Origin）
```

---

## 一、三方职责拆解

### 1. 代理层（Cloudflare Worker）

**核心职责**：作为反向代理，处理所有请求的认证检查、会话管理和令牌刷新。

**关键代码**：
- `packages/core/src/libraries/protected-app.ts` - 配置管理与同步
- `packages/core/src/utils/cloudflare/kv.ts` - KV 存储配置读写

**具体工作**：

1. **请求拦截**：所有访问受保护应用域名的请求先经过 Worker
2. **会话检查**：验证请求中是否携带有效会话 Cookie
3. **未登录处理**：无有效会话时重定向到 Logto 登录页
4. **登录回调**：处理 `/sign-in-callback` 路径的授权码回调
5. **令牌交换**：使用授权码向 Logto 换取 access_token 和 refresh_token
6. **Cookie 设置**：将会话信息写入安全 Cookie
7. **令牌刷新**：access_token 过期时自动使用 refresh_token 续期
8. **请求转发**：认证通过后将请求转发到上游应用

**配置同步机制**：
```typescript
// packages/core/src/libraries/protected-app.ts:154-196
const syncAppConfigsToRemote = async (applicationId: string): Promise<void> => {
  const siteConfigs = {
    ...protectedAppMetadata,
    sdkConfig: {
      appId: id,           // 应用ID
      appSecret: secret,   // 应用密钥
      endpoint: getTenantEndpoint(tenantId, EnvSet.values).origin,  // Logto端点
    },
  };
  
  // 将配置写入 Cloudflare KV
  await updateProtectedAppSiteConfigs(
    protectedAppConfigProviderConfig,
    protectedAppMetadata.host,
    siteConfigs
  );
};
```

---

### 2. 会话存储

**核心职责**：安全存储用户会话状态和令牌信息。

#### 2.1 服务器端配置存储（Cloudflare KV）

**存储内容**：
```typescript
// packages/core/src/utils/cloudflare/types.ts:21-31
type SiteConfigs = ProtectedAppMetadata & {
  sdkConfig: {
    appId: string;      // 应用客户端ID
    appSecret: string;  // 应用客户端密钥
    endpoint: string;   // Logto 服务端点
  };
};
```

**存储位置**：Cloudflare KV Namespace，键格式为 `${keyName}:${host}`

**元数据结构**：
```typescript
// packages/schemas/src/foundations/jsonb-types/applications.ts:22-37
type ProtectedAppMetadata = {
  host: string;                    // 应用域名
  origin: string;                  // 上游应用源地址
  sessionDuration: number;         // 会话时长（秒），默认14天
  pageRules: Array<{ path: string }>;  // 页面访问规则
  customDomains?: CustomDomain[];  // 自定义域名
};
```

#### 2.2 客户端会话存储（Browser Cookie）

**Cookie 策略**：
- **名称**：由 Cloudflare Worker 管理，使用安全 Cookie
- **属性**：
  - `Secure`：仅 HTTPS 传输
  - `HttpOnly`：禁止 JavaScript 访问（防止 XSS）
  - `SameSite`：Lax 或 Strict（防止 CSRF）
  - `Max-Age`：与 `sessionDuration` 一致，默认 14 天
- **作用域**：受保护应用的域名

**会话内容**（Worker 内部维护）：
- access_token（短期，通常 1 小时）
- refresh_token（长期，与会话时长一致）
- id_token（用户身份信息）
- 令牌过期时间戳

---

### 3. 上游应用（Origin）

**核心职责**：只处理业务逻辑，不感知认证流程。

**特点**：
- **零代码侵入**：无需修改上游应用代码
- **透明代理**：Worker 转发请求时附带用户身份信息（可通过 HTTP Header 传递）
- **无状态**：上游应用本身不维护会话状态

**接收的请求**：
```
GET /api/resource HTTP/1.1
Host: protected-app.example.com
Authorization: Bearer <access_token>  // 可选，由 Worker 注入
X-Logto-User-Sub: <user_id>           // 可选，用户ID
X-Logto-User-Email: <email>           // 可选，用户邮箱
```

---

## 二、会话建立完整流程

### 阶段 1：首次访问（无会话）

```
1. 用户 → https://app.example.com/protected
   ↓
2. Cloudflare Worker 检查 Cookie：无有效会话
   ↓
3. 重定向 → Logto 授权端点
   https://logto.example.com/oidc/auth
     ?client_id=<appId>
     &redirect_uri=https://app.example.com/sign-in-callback
     &response_type=code
     &scope=openid profile offline_access
   ↓
4. 用户登录 Logto（输入账号密码 / 社交登录）
   ↓
5. Logto → 重定向回 https://app.example.com/sign-in-callback?code=<授权码>
```

### 阶段 2：登录回调（授权码换令牌）

```
6. Worker 接收 /sign-in-callback 请求，提取授权码
   ↓
7. Worker → Logto Token 端点（使用 appId + appSecret 认证）
   POST /oidc/token
   {
     grant_type: "authorization_code",
     code: "<授权码>",
     redirect_uri: "https://app.example.com/sign-in-callback"
   }
   ↓
8. Logto 返回令牌响应：
   {
     access_token: "<access_token>",
     refresh_token: "<refresh_token>",
     id_token: "<id_token>",
     expires_in: 3600
   }
   ↓
9. Worker 将会话信息写入安全 Cookie
   ↓
10. 重定向 → 用户原始请求的页面
```

### 阶段 3：已认证访问

```
11. 用户 → https://app.example.com/protected（携带会话 Cookie）
    ↓
12. Worker 验证 Cookie，检查 access_token 是否有效
    ├─ 有效 → 转发请求到上游应用
    └─ 过期 → 进入刷新流程（阶段4）
    ↓
13. 上游应用处理请求，返回响应
    ↓
14. Worker 将响应返回给用户
```

### 阶段 4：令牌刷新（access_token 过期）

**刷新令牌核心逻辑**：`packages/core/src/oidc/grants/refresh-token.ts`

```
15. Worker 检测到 access_token 已过期
    ↓
16. Worker → Logto Token 端点
    POST /oidc/token
    {
      grant_type: "refresh_token",
      refresh_token: "<refresh_token>",
      scope: "openid profile offline_access"
    }
    ↓
17. Logto 验证 refresh_token：
    - 检查令牌是否存在且未过期
    - 检查 clientId 是否匹配
    - 检查是否已被消费（防止重放攻击）
    ↓
18. Logto 返回新的令牌对（可选轮换 refresh_token）
    ↓
19. Worker 更新 Cookie 中的会话信息
    ↓
20. 继续转发原始请求到上游应用
```

**刷新令牌关键校验点**：
```typescript
// packages/core/src/oidc/grants/refresh-token.ts:90-127
if (!refreshToken) throw new InvalidGrant('refresh token not found');
if (refreshToken.clientId !== client.clientId) throw new InvalidGrant('client mismatch');
if (refreshToken.isExpired) throw new InvalidGrant('refresh token is expired');
if (refreshToken.consumed) {
  // 已消费的 refresh_token，立即销毁并撤销整个 grant
  await Promise.all([refreshToken.destroy(), revoke(ctx, refreshToken.grantId)]);
  throw new InvalidGrant('refresh token already used');
}
```

---

## 三、关键技术细节

### 3.1 Cookie 安全策略

**核心原则**：最小权限 + 深度防御

1. **HttpOnly**：防止 XSS 攻击窃取令牌
2. **Secure**：仅在 HTTPS 连接中传输
3. **SameSite=Lax**：防止 CSRF 攻击，同时允许从外部链接跳转登录
4. **Path=/`**：整个域名有效
5. **独立作用域**：每个受保护应用的 Cookie 相互隔离

### 3.2 令牌安全存储

- **access_token**：内存中短期持有，过期即换
- **refresh_token**：加密存储在 Cookie 中，仅用于令牌刷新
- **id_token**：用于获取用户信息，不用于 API 认证

### 3.3 会话过期机制

1. **access_token 过期**：静默刷新，用户无感知
2. **refresh_token 过期**：需要重新登录（会话时长控制）
3. **主动登出**：清除 Cookie，撤销 refresh_token

### 3.4 域名与 SSL 管理

**自定义域名配置**：
- 通过 Cloudflare Custom Hostnames API 配置
- 自动申请和续期 SSL 证书
- 支持 CNAME 指向 Cloudflare 回退源地址

```typescript
// packages/core/src/utils/cloudflare/index.ts:57-82
const createCustomHostname = async (auth: HostnameProviderData, hostname: string) => {
  return got.post('/zones/{zoneId}/custom_hostnames', {
    json: {
      hostname,
      ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } },
    },
  });
};
```

---

## 四、代码位置索引

| 功能模块 | 文件路径 | 关键行号 |
|---------|---------|---------|
| 受保护应用核心逻辑 | `packages/core/src/libraries/protected-app.ts` | 149-279 |
| Cloudflare KV 配置读写 | `packages/core/src/utils/cloudflare/kv.ts` | 19-78 |
| 刷新令牌 Grant | `packages/core/src/oidc/grants/refresh-token.ts` | 67-324 |
| 受保护应用元数据结构 | `packages/schemas/src/foundations/jsonb-types/applications.ts` | 22-37 |
| Cloudflare 系统配置 | `packages/schemas/src/types/system.ts` | 152-213 |
| 站点配置类型定义 | `packages/core/src/utils/cloudflare/types.ts` | 21-31 |
| 自定义域名 API | `packages/core/src/utils/cloudflare/index.ts` | 30-134 |
| 登录回调 URL 常量 | `packages/core/src/constants/index.ts` | 7 |
| 默认会话时长 | `packages/core/src/routes/applications/constants.ts` | 3-4 |
| 受保护应用元数据路由 | `packages/core/src/routes/applications/application-protected-app-metadata.ts` | 11-169 |

---

## 五、架构优势与权衡

### 优势
1. **零侵入**：上游应用无需任何修改
2. **统一安全策略**：所有应用共享相同的认证安全标准
3. **开发体验**：业务开发者无需关注认证细节
4. **快速上线**：只需配置域名和上游源地址

### 权衡
1. **额外延迟**：每个请求多一跳 Worker 处理
2. **Cloudflare 绑定**：强依赖 Cloudflare 生态
3. **调试难度**：问题排查需要理解多层架构
4. **成本**：Cloudflare Worker 和 KV 可能产生额外费用

### 适用场景
- 遗留系统快速接入认证
- 第三方静态网站保护
- 多应用统一认证入口
- 快速原型验证
