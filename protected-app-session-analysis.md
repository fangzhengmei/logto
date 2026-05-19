# 受保护应用（Protected App）会话建立路径分析

## 重要说明

本文档严格区分**代码可证据部分**与**架构推断部分**：

- ✅ **可证据**：仓库内存在对应代码，可直接阅读验证
- ❓ **推断**：仓库内无对应实现，基于配置结构、API 设计和架构文档推断

---

## 一、整体架构与边界

```
┌─────────────────────────────────────────────────────────────┐
│                     控制面（Control Plane）                  │
│  ✅ 仓库内有完整实现                                    │
│  - 应用配置管理                                          │
│  - 域名生命周期管理                                    │
│  - 配置下发到 Cloudflare KV                            │
│  - 刷新令牌 Grant 实现（/oidc/token 接口）        │
└────────────────────────────────┬────────────────────────────┘
                                 │
                                 │ 配置同步（Cloudflare API）
                                 ▼
┌─────────────────────────────────────────────────────────────┐
│                     数据面（Data Plane）                     │
│  ❓ 仓库内无实现，独立部署的 Cloudflare Worker                │
│  - 反向代理握手                                              │
│  - Cookie 会话管理                                              │
│  - 令牌自动刷新                                              │
│  - 请求转发到上游应用                                          │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、控制面（✅ 仓库内完整实现）

### 2.1 核心职责

控制面负责受保护应用的**配置管理**和**生命周期管理**，所有代码均在仓库内可查。

### 2.2 受保护应用的 OIDC 配置约束

**应用类型映射**（✅ 可证据）

```typescript
// packages/core/src/oidc/utils.ts:33-97
export const getConstantClientMetadata = (envSet, type, options) => {
  // ...
  // Protected 类型属于 Interactive applications，走默认分支
  return {
    ...constantMetadata,
    grant_types: [GrantType.AuthorizationCode, GrantType.RefreshToken, ...optionalGrantTypes],
  };
};
```

**受保护应用的 OIDC 客户端属性**（✅ 可证据）：

| 属性 | 值 | 说明 |
|------|----|------|
| `application_type` | `web` | Web 应用类型 |
| `token_endpoint_auth_method` | `client_secret_basic` | 机密客户端，使用 client_secret 认证 |
| `grant_types` | `authorization_code, refresh_token` | 支持授权码和刷新令牌 |
| `refreshTokenTtlInDays` | 14（默认） | 刷新令牌 TTL |
| `rotateRefreshToken` | true（默认） | 启用令牌轮换 |

### 2.3 刷新令牌颁发条件**（✅ 可证据）

**核心逻辑**：`packages/core/src/oidc/init.ts:212-221`

```typescript
// packages/core/src/oidc/init.ts:212-221 ✅ 可证据
issueRefreshToken: (_, client, code) => {
  if (!client.grantTypeAllowed('refresh_token')) {
    return false;
  }

  return (
    code.scopes.has('offline_access') ||
    (client.applicationType === 'web' && Boolean(client.metadata().alwaysIssueRefreshToken))
  );
};
```

**刷新令牌颁发的前置条件**（✅ 可证据）：

1. **必须条件**：客户端必须允许 `refresh_token` grant type（Protected 应用默认允许）

2. **二选一条件**（满足其一即可）：
   - **选项 A**：授权请求中包含 `offline_access` scope
   - **选项 B**：应用是 web 类型且 `alwaysIssueRefreshToken = true`

**受保护应用的实际情况**（✅ 可证据 + ❓ 推断结合）：
- ✅ 代码中未看到 Protected 应用默认设置 `alwaysIssueRefreshToken: true`
- ✅ 仅 `customClientMetadataDefault` 中无此配置（`packages/schemas/src/consts/oidc.ts:14-18`）
- ❓ 因此**数据面必须在授权请求中包含 `offline_access` scope 才能获取 refresh_token

### 2.4 刷新令牌 TTL 与轮换策略

**TTL 策略**（✅ 可证据）：

```typescript
// packages/core/src/oidc/defaults.ts:8-20 ✅ 可证据
const refreshTokenTtl = (ctx, token, client) => {
  if (
    ctx.oidc.entities.RotatedRefreshToken &&
    client.applicationType === 'web' &&
    client.clientAuthMethod === 'none' &&
    !token.isSenderConstrained()
  ) {
    // 公共客户端非 sender-constrained 的 refresh token 不无限续期
    return ctx.oidc.entities.RotatedRefreshToken.remainingTTL;
  }
  // 对于机密客户端（Protected 应用），返回 undefined 使用默认 TTL（由 `refreshTokenTtlInDays` 决定）
};
```

**令牌轮换策略**（✅ 可证据）：

```typescript
// packages/core/src/oidc/defaults.ts:23-41 ✅ 可证据
const rotateRefreshToken = (ctx) => {
  const { RefreshToken: refreshToken, Client: client } = ctx.oidc.entities;

  if (!refreshToken || !client) {
    return false;
  }

  // 最长轮换 1 年
  if (refreshToken.totalLifetime() >= 365.25 * 24 * 60 * 60) {
    return false;
  }
  
  // 公共客户端非 sender-constrained 始终轮换
  if (client.clientAuthMethod === 'none' && !refreshToken.isSenderConstrained()) {
    return true;
  }
  
  // 机密客户端（Protected 应用）：超过 70% TTL 时轮换
  return refreshToken.ttlPercentagePassed() >= 70;
};
```

**受保护应用的轮换行为**（✅ 可证据）：
- ✅ Protected 应用是机密客户端（`client_secret_basic`）
- ✅ 超过 70% TTL 时才轮换 refresh_token
- ✅ 最长可轮换 1 年

### 2.5 配置下发（Configuration Sync）

**核心文件**：`packages/core/src/libraries/protected-app.ts`

**关键函数**：`syncAppConfigsToRemote()`

```typescript
// packages/core/src/libraries/protected-app.ts:154-196 ✅ 可证据
const syncAppConfigsToRemote = async (applicationId: string): Promise<void> => {
  const { protectedAppMetadata, id, secret, tenantId } = await findApplicationById(applicationId);
  
  const siteConfigs = {
    ...protectedAppMetadata,
    sdkConfig: {
      appId: id,           // 应用 ID，作为 OIDC client_id
      appSecret: secret,     // 应用密钥，用于 token endpoint 认证
      endpoint: getTenantEndpoint(tenantId, EnvSet.values).origin,  // Logto 端点
    },
  };
  
  // 写入 Cloudflare KV
  await updateProtectedAppSiteConfigs(
    protectedAppConfigProviderConfig,
    protectedAppMetadata.host,
    siteConfigs
  );
  
  // 同步配置到所有自定义域名
  if (customDomains && customDomains.length > 0) {
    await Promise.all(
      customDomains.map(async ({ domain }) => {
        await updateProtectedAppSiteConfigs(protectedAppConfigProviderConfig, domain, {
          ...siteConfigs,
          host: domain,
        });
      })
    );
  }
};
```

**配置结构**（KV 中存储的数据）：

```typescript
// packages/core/src/utils/cloudflare/types.ts:21-31 ✅ 可证据
type SiteConfigs = ProtectedAppMetadata & {
  sdkConfig: {
    appId: string;      // OIDC client_id
    appSecret: string;  // OIDC client_secret
    endpoint: string;   // Logto OIDC 服务地址
  };
};
```

**元数据结构**：

```typescript
// packages/schemas/src/foundations/jsonb-types/applications.ts:22-37 ✅ 可证据
type ProtectedAppMetadata = {
  host: string;                    // 应用域名（系统分配或自定义）
  origin: string;                  // 上游应用源地址（代理目标）
  sessionDuration: number;         // 会话时长（秒），默认 14 天
  pageRules: Array<{ path: string }>;  // 页面访问规则（正则路径）
  customDomains?: CustomDomain[];  // 自定义域名列表
};
```

**KV 存储键格式**：`${keyName}:${host}`

### 2.6 域名管理（Domain Management）

**核心文件**：`packages/core/src/utils/cloudflare/index.ts`

**功能**：
1. 创建自定义域名（Cloudflare Custom Hostnames）
2. 查询域名状态（SSL 证书签发进度）
3. 删除自定义域名

```typescript
// packages/core/src/utils/cloudflare/index.ts:57-82 ✅ 可证据
const createCustomHostname = async (auth: HostnameProviderData, hostname: string) => {
  return got.post(`/zones/${auth.zoneId}/custom_hostnames`, {
    json: {
      hostname,
      ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' },
    },
  });
};
```

**路由 API**（管理后台使用）：`packages/core/src/routes/applications/application-protected-app-metadata.ts`

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/applications/:id/protected-app-metadata/custom-domains | 查询自定义域名列表及状态 |
| POST | `/applications/:id/protected-app-metadata/custom-domains | 添加自定义域名 |
| DELETE | `/applications/:id/protected-app-metadata/custom-domains/:domain | 删除自定义域名 |

### 2.7 OIDC 客户端配置

**回调 URL**：`packages/core/src/constants/index.ts` ✅ 可证据

```typescript
export const protectedAppSignInCallbackUrl = 'sign-in-callback';
```

**自动生成的 redirectUris**：

```
https://<host>/sign-in-callback
https://<custom-domain>/sign-in-callback
```

**自动生成的 postLogoutRedirectUris**：

```
https://<host>
https://<custom-domain>
```

### 2.8 刷新令牌 Grant（Refresh Token Grant）

**核心文件**：`packages/core/src/oidc/grants/refresh-token.ts` ✅ 可证据

这是标准 OIDC 刷新令牌流程的实现。

```typescript
// packages/core/src/oidc/grants/refresh-token.ts:90-127 ✅ 可证据
if (!refreshToken) throw new InvalidGrant('refresh token not found');
if (refreshToken.clientId !== client.clientId) throw new InvalidGrant('client mismatch');
if (refreshToken.isExpired) throw new InvalidGrant('refresh token is expired');
if (refreshToken.consumed) {
  // 安全机制：已消费的 refresh_token 立即销毁并撤销整个 grant
  await Promise.all([refreshToken.destroy(), revoke(ctx, refreshToken.grantId)];
  throw new InvalidGrant('refresh token already used');
}
```

---

## 三、数据面（❓ 仓库内无实现，架构推断）

> **重要提示**：以下内容基于控制面下发的配置结构、OIDC 协议规范和架构文档推断，仓库内无对应实现代码。

### 3.1 数据面的角色

数据面是独立部署的 **Cloudflare Worker**，作为反向代理运行在用户请求与上游应用之间。

**推断依据**（✅ 可证据的间接证据）：

1. ✅ 控制台文档链接描述：`/integrate-logto/protected-app`
2. ✅ 配置中包含完整的 OIDC client 凭据（appId + appSecret）
3. ✅ 预定义了 `/sign-in-callback` 路径
4. ✅ 配置了 sessionDuration（会话时长）
5. ✅ 控制台 UI 显示了认证路由列表：`/register`, `/sign-in`, `/sign-in-callback`, `/sign-out`
6. ✅ 受保护应用配置了 `refresh_token` grant type
7. ✅ 配置下发到 Cloudflare KV，供 Worker 读取

### 3.2 反向代理握手流程推断

```
用户浏览器 → Cloudflare Worker（数据面） → Logto OIDC（控制面）
                                      ↓
                              上游应用（Origin）
```

**阶段 1：首次访问（无会话）❓ 推断**：

```
1. 用户 → https://app.example.com/protected
   ↓
2. Worker 检查 Cookie（不存在或无效）
   ↓
3. 生成 OIDC 授权请求，重定向到 Logto
   https://logto.example.com/oidc/auth
     ?client_id=<appId>
     &redirect_uri=https://app.example.com/sign-in-callback
     &response_type=code
     &scope=openid profile offline_access  # ❓ 推断：必须包含 offline_access
     &state=<随机值>
     &nonce=<随机值>
   ↓
4. 用户完成登录
   ↓
5. Logto → 重定向回 https://app.example.com/sign-in-callback?code=<授权码>&state=<state>
```

**为什么必须包含 `offline_access` scope**（✅ 可证据的推断链）：

- ✅ 受保护应用未设置 `alwaysIssueRefreshToken: true
- ✅ 刷新令牌颁发条件要求 `offline_access` scope 或 `alwaysIssueRefreshToken: true
- ❓ 因此数据面必须在授权请求中包含 `offline_access` scope

**阶段 2：登录回调 ❓ 推断**：

```
6. Worker 接收 /sign-in-callback 请求
   - 验证 state 参数
   - 提取授权码 code
   ↓
7. Worker 调用 Logto Token 端点（使用 appId + appSecret 进行 Basic Auth）
   POST https://logto.example.com/oidc/token
   Authorization: Basic <base64(appId:appSecret)>
   Content-Type: application/x-www-form-urlencoded
   
   grant_type=authorization_code
   &code=<授权码>
   &redirect_uri=https://app.example.com/sign-in-callback
   ↓
8. Logto 返回令牌响应 ✅ 可证据（标准 OIDC 流程）
   {
     access_token: "<access_token>",
     refresh_token: "<refresh_token>",
     id_token: "<id_token>",
     expires_in: 3600,
     token_type: "Bearer"
   }
   ↓
9. Worker 验证 id_token，提取用户信息
   ↓
10. Worker 将会话信息加密后写入 Cookie
    ↓
11. 重定向到用户原始请求的页面
```

### 3.3 Cookie 策略

**✅ 可证据部分**（Logto 自身 OIDC Cookie 配置）：

```typescript
// packages/core/src/oidc/init.ts:84-89 ✅ 可证据
const cookieConfig = Object.freeze({
  sameSite: 'lax',
  path: '/',
  signed: true,
  overwrite: true,
} as const);
```

**❓ 推断部分**（数据面对用户会话 Cookie 策略）：

| 属性 | 推断值 | 推断依据 |
|------|---------|-----------|
| Secure | ✅ | 仅 HTTPS 传输 | 安全最佳实践 |
| HttpOnly | ✅ | 禁止 JavaScript 访问，防止 XSS | 安全最佳实践 |
| SameSite | Lax | 防止 CSRF，同时允许外部跳转 | 安全最佳实践 |
| Path | / | 整个域名有效 | 标准做法 |
| Max-Age | sessionDuration | 与会话时长一致 | ✅ 可证据：配置了 sessionDuration |
| Domain | 应用域名 | 作用域限制 | 标准做法 |

**Cookie 内容推断**（加密存储）❓ 推断：

- access_token（短期，通常 1 小时）
- refresh_token（长期，与会话时长一致）
- id_token（用于获取用户信息）
- 令牌过期时间戳
- 用户标识（sub）

### 3.4 刷新令牌续期机制

**数据面会调用刷新接口**❓ 推断，依据如下**：

1. ✅ 受保护应用配置了 `refresh_token` grant type
2. ✅ 配置了 `sessionDuration`（默认 14 天），远长于 access_token 有效期（通常 1 小时）
3. ✅ 控制面实现了完整的 `refresh_token` Grant
4. ✅ 配置下发了完整的 OIDC client 凭据（appId + appSecret），可用于 token endpoint 认证
5. ❓ 因此数据面必然会在 access_token 过期时调用刷新接口续期

**阶段 3：已认证访问 ❓ 推断**：

```
1. 用户 → https://app.example.com/protected（携带会话 Cookie）
   ↓
2. Worker 解密 Cookie，检查 access_token 是否过期
   ├─ 未过期 → 转发请求到上游应用
   └─ 已过期 → 进入刷新流程
   ↓
3. 上游应用返回响应 → Worker 转发给用户
```

**阶段 4：令牌刷新 ❓ 推断**：

```
4. Worker 检测到 access_token 已过期
   ↓
5. 调用 Logto Token 端点使用 refresh_token 续期
   POST https://logto.example.com/oidc/token
   Authorization: Basic <base64(appId:appSecret)>
   
   grant_type=refresh_token
   &refresh_token=<refresh_token>
   &scope=openid profile offline_access
   ↓
6. Logto 验证并返回新令牌对 ✅ 可证据（refresh-token.ts）
   ↓
7. Worker 更新 Cookie 中的会话信息
   ↓
8. 继续转发原始请求到上游应用
```

**刷新失败场景** ❓ 推断：

- refresh_token 已过期 → 清除 Cookie，重定向到登录页
- refresh_token 已被消费 → 清除 Cookie，重定向到登录页（安全机制 ✅ 可证据）
- 用户被禁用 → 清除 Cookie，重定向到登录页

### 3.5 请求转发推断

**Worker 转发给上游应用的请求可能包含** ❓ 推断**：

```http
GET /protected HTTP/1.1
Host: <上游应用域名>
X-Forwarded-For: <用户真实IP>
X-Forwarded-Proto: https
Authorization: Bearer <access_token>  // 可选
X-Logto-User-Sub: <user_id>           // 可选，从 id_token 提取
X-Logto-User-Email: <email>           // 可选
```

---

## 四、控制面与数据面交互时序

```
管理员操作（控制台）
    │
    ▼
┌─────────────┐
│  应用创建    │  ✅ 可证据：application.ts
│  配置域名    │
│  设置会话时长│
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 配置持久化   │  ✅ 可证据：写入 applications 表
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 同步到 KV   │  ✅ 可证据：syncAppConfigsToRemote()
│ (Cloudflare │
│  Workers &  │
│  Pages KV)  │
└──────┬──────┘
       │
       │ 配置数据
       ▼
┌─────────────────────────────────────┐
│  Cloudflare Worker（数据面）         │  ❓ 推断
│  - 读取 KV 配置                     │
│  - 监听用户请求                     │
│  - 执行 OAuth 流程                  │
│  - 管理 Cookie 会话                 │
│  - 自动刷新令牌                     │
│  - 转发请求到上游应用               │
└─────────────────────────────────────┘
```

---

## 五、代码位置索引

### 控制面（✅ 可证据）

| 功能模块 | 文件路径 | 关键行号 |
|---------|---------|---------|
| 受保护应用核心库 | `packages/core/src/libraries/protected-app.ts` | 149-279 |
| 受保护应用测试 | `packages/core/src/libraries/protected-app.test.ts` | 1-221 |
| Cloudflare KV 配置读写 | `packages/core/src/utils/cloudflare/kv.ts` | 19-78 |
| Cloudflare 域名 API | `packages/core/src/utils/cloudflare/index.ts` | 30-134 |
| Cloudflare 类型定义 | `packages/core/src/utils/cloudflare/types.ts` | 1-31 |
| 受保护应用元数据路由 | `packages/core/src/routes/applications/application-protected-app-metadata.ts` | 11-169 |
| 受保护应用元数据路由测试 | `packages/core/src/routes/applications/application-protected-app-metadata.test.ts` | 1-181 |
| 受保护应用元数据结构 | `packages/schemas/src/foundations/jsonb-types/applications.ts` | 22-37 |
| Cloudflare 系统配置 | `packages/schemas/src/types/system.ts` | 152-213 |
| 刷新令牌颁发条件 | `packages/core/src/oidc/init.ts` | 212-221 |
| 刷新令牌 TTL 策略 | `packages/core/src/oidc/defaults.ts` | 8-20 |
| 令牌轮换策略 | `packages/core/src/oidc/defaults.ts` | 23-41 |
| 刷新令牌 Grant | `packages/core/src/oidc/grants/refresh-token.ts` | 67-324 |
| OIDC 客户端元数据默认值 | `packages/schemas/src/consts/oidc.ts` | 14-18 |
| 登录回调 URL 常量 | `packages/core/src/constants/index.ts` | 7 |
| 默认会话时长 | `packages/core/src/routes/applications/constants.ts` | 3-4 |
| 应用类型校验 | `packages/core/src/libraries/application.ts` | 280-291 |
| 控制台设置页面 | `packages/console/src/pages/ApplicationDetails/ApplicationDetailsContent/ProtectedAppSettings/index.tsx` | 1-300 |
| 会话时长表单 | `packages/console/src/pages/ApplicationDetails/ApplicationDetailsContent/ProtectedAppSettings/components/SessionForm.tsx` | 1-78 |

### 数据面（❓ 无实现）

| 功能模块 | 状态 | 说明 |
|---------|------|------|
| Cloudflare Worker 入口 | 无 | 独立部署，不在此仓库 |
| 反向代理逻辑 | 无 | 独立部署，不在此仓库 |
| Cookie 会话管理 | 无 | 独立部署，不在此仓库 |
| 令牌刷新逻辑 | 无 | 独立部署，不在此仓库 |
| 登录回调处理 | 无 | 独立部署，不在此仓库 |

---

## 六、可证据 vs 推断 对比表

| 功能点 | 可证据（✅） | 推断（❓） | 依据 |
|--------|-------------|-----------|------|
| 应用配置存储 | ✅ | | protected-app.ts |
| 配置下发到 KV | ✅ | | syncAppConfigsToRemote() |
| 自定义域名管理 | ✅ | | cloudflare/index.ts |
| 刷新令牌 Grant 实现 | ✅ | | refresh-token.ts |
| 登录回调 URL 定义 | ✅ | | constants/index.ts |
| 会话时长配置 | ✅ | | SessionForm.tsx |
| 刷新令牌颁发条件 | ✅ | | oidc/init.ts:212-221 |
| 令牌轮换策略 | ✅ | | oidc/defaults.ts |
| OIDC Cookie 配置 | ✅ | | oidc/init.ts:84-89 |
| 受保护应用 grant types | ✅ | | oidc/utils.ts |
| Cloudflare Worker 代码 | | ❓ | 无对应文件 |
| 反向代理握手逻辑 | | ❓ | 基于 OIDC 规范 + 配置结构 |
| 数据面 Cookie 策略 | | ❓ | 基于安全最佳实践 |
| 数据面令牌自动刷新逻辑 | | ❓ | 基于 refresh_token grant 存在 + sessionDuration 配置 |
| 请求转发规则 | | ❓ | 基于 origin 配置 |
| 授权请求包含 offline_access | | ❓ | 基于刷新令牌颁发条件推导 |

---

## 七、已知限制与架构权衡

### 已知事实（✅ 可证据）
1. **强依赖 Cloudflare**：必须使用 Cloudflare 生态（KV + Custom Hostnames）
2. **单域名限制**：每个受保护应用仅支持一个自定义域名（代码校验）
3. **配置同步延迟**：KV 写入后可能有秒级延迟
4. **应用密钥暴露**：appSecret 存储在 Cloudflare KV 中
5. **刷新令牌条件**：必须包含 `offline_access` scope（推导）
6. **令牌轮换时机**：机密客户端超过 70% TTL 时轮换

### 推断限制（❓）
1. **冷启动延迟**：Cloudflare Worker 冷启动可能增加首次请求延迟
2. **调试困难**：数据面问题需要在 Cloudflare 侧排查
3. **定制能力有限**：数据面逻辑不可在本仓库修改

### 适用场景
- ✅ 遗留系统快速接入认证
- ✅ 静态网站保护
- ✅ 第三方 SaaS 应用统一入口
- ❌ 需要深度定制认证逻辑的场景
