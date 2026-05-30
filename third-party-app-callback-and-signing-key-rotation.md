# 第三方应用接入：回调地址校验与签名密钥滚动源码关联分析

## 一、回调地址合法性校验

### 1.1 注册阶段：redirect URI 写入校验

应用创建/更新时，`redirectUris` 和 `postLogoutRedirectUris` 通过 Zod guard 做格式校验：

**源码位置**：`packages/schemas/src/foundations/jsonb-types/oidc-module.ts:48-56`

```ts
export const oidcClientMetadataGuard = z.object({
  redirectUris: z
    .string()
    .refine((url) => validateRedirectUrl(url, 'web') || validateRedirectUrl(url, 'mobile'))
    .array(),
  postLogoutRedirectUris: z
    .string()
    .refine((url) => validateRedirectUrl(url, 'web') || validateRedirectUrl(url, 'mobile'))
    .array(),
  // ...
});
```

每条 URI 必须通过 `validateRedirectUrl()` 的 `web` 或 `mobile` 校验之一。

### 1.2 validateRedirectUrl 格式校验详解

**源码位置**：`packages/toolkit/core-kit/src/utils/url.ts:3-47`

#### 精确匹配路径（无通配符）

1. 检查 URL 是否包含 dot-segment（`/./`、`/../`、`/%2e`、`/%2e%2e`），如有则拒绝，防止路径遍历攻击。
2. 使用 `new URL(url)` 解析，提取 `protocol`。
3. **Web 类型**：协议必须是 `http:` 或 `https:`（`webRedirectUriProtocolRegEx = /^https?:$/`）。
4. **Mobile 类型**：协议不能是 http/https，须符合自定义 scheme 规则 `^(?!http(s)?:)[a-z][\d+_a-z-]*(\.[\d+_a-z-]+)*:$`（如 `com.example://`、`io.logto://`）。

#### 通配符匹配路径（含 `*`）

当 `type === 'web'` 且 URL 包含 `*` 时，进入 `validateWildcardWebRedirectUrl()` 分支，执行以下 5 步校验：

| 步骤 | 函数 | 规则 | 示例 |
|------|------|------|------|
| 1 | `hasWildcardInScheme` | 协议部分不允许出现 `*` | ❌ `ht*ps://example.com` |
| 2 | `hasWildcardInQueryOrHash` | 查询参数和 hash 部分不允许出现 `*` | ❌ `https://example.com?x=*` |
| 3 | `isAuthorityAllowedForWildcardWebRedirect` | authority 部分校验（见下） | — |
| 4 | `hasDotSegmentsInAbsoluteUrlPath` | 路径不允许 dot-segment | ❌ `https://*.com/../admin` |
| 5 | `isUrlProtocolAllowedAfterWildcardReplacement` | 将 `*` 替换为 `wildcard` 后须为合法 http/https URL | ❌ `ws://*.com/cb` |

**authority 部分详细规则**（`isAuthorityAllowedForWildcardWebRedirect`，`url.ts:89-110`）：

- 不允许包含 `@`（禁止 userinfo 部分）。
- 不允许 IPv6 地址字面量（`[` 开头）。
- hostname 中含 `*` 时，**必须包含至少一个 `.`**，防止过于宽泛的模式（如 `https://*/callback` 被拒绝）。
- 端口号部分不允许包含 `*`（如 `https://example.com:*` 被拒绝）。

**有效通配符示例**：
- `https://*.example.com/callback` ✅
- `https://pr-*-myapp.vercel.app/callback` ✅（主机名多段通配）
- `https://example.com/callback/*` ✅（路径通配，oidc-provider 原生支持）

**无效通配符示例**：
- `https://*/callback` ❌（hostname 无 dot）
- `https://example.com:*/*` ❌（端口通配）
- `https://example.com/callback?x=*` ❌（query 通配）

### 1.3 运行时校验：oidc-provider 的 redirect_uri 匹配

**源码位置**：`packages/core/src/oidc/init.ts:166`

```ts
const oidc = new Provider(envSet.oidc.issuer, {
  allowWildcardRedirectUris: true,
  // ...
});
```

Logto 在初始化 `oidc-provider` 时显式启用 `allowWildcardRedirectUris: true`，这使得 oidc-provider 在授权流程中校验 `redirect_uri` 时支持通配符模式匹配。

oidc-provider 内部对通配符 redirect_uri 的匹配逻辑：
- `*` 匹配任意非空路径段（不含 `/`）。
- 通配仅出现在 URI 的路径和主机名部分（已由注册时校验保证）。

### 1.4 回调地址变更的生效机制

**源码位置**：`packages/core/src/routes/applications/application.ts:337-458`

**关键发现**：回调地址变更**不依赖**租户缓存失效机制。

当通过 `PATCH /applications/:id` 更新应用的 `oidcClientMetadata.redirectUris` 时：
1. 直接调用 `queries.applications.updateApplicationById(id, rest, 'replace')` 写入数据库。
2. **没有**调用 `tenant.invalidateCache()` 触发租户实例重建。

#### Client 元数据的动态读取机制

**源码位置**：`packages/core/src/oidc/adapter.ts:128-203`

```ts
export default function postgresAdapter(
  envSet: EnvSet,
  queries: Queries,
  modelName: string
) {
  if (modelName === 'Client') {
    return {
      // ...
      find: async (id) => {
        // ...
        const application = await tryThat(
          findApplicationById(id),
          new errors.InvalidClient(`invalid client ${id}`)
        );
        return transpileClient(application);
      },
      // ...
    };
  }
  // ...
}
```

oidc-provider 通过 `postgresAdapter` 的 `find` 方法获取 Client 元数据：
- **每次**需要校验 `redirect_uri`、检查 CORS origin、获取客户端配置时，都会从数据库**实时读取**应用数据。
- 因此，`redirectUris`、`corsAllowedOrigins` 等应用级配置变更**即时生效**，无需等待租户缓存失效。

#### 生效时机对比

| 配置类型 | 触发缓存失效 | 生效方式 | 生效延迟 |
|---------|-------------|---------|---------|
| **redirectUris** | ❌ 不触发 | oidc-provider 实时读取 | 下一次数据库查询 |
| **corsAllowedOrigins** | ❌ 不触发 | oidc-provider 实时读取 | 下一次数据库查询 |
| **签名密钥** | ✅ 触发 `tenant.invalidateCache()` | 重建租户实例重新加载 | 下一次请求（需重建） |
| **OIDC Session TTL** | ✅ 触发 `tenant.invalidateCache()` | 重建租户实例重新加载 | 下一次请求（需重建） |

### 1.5 CORS Origin 匹配与 redirect_uri 校验的粒度差异

#### CORS Origin 校验：仅匹配 origin 级别的粒度

**源码位置**：`packages/core/src/oidc/utils.ts:121-149`

CORS 校验的核心函数 `isOriginAllowed()` 接收参数为 `origin` 字符串（如 `https://example.com:8080`），仅包含：
- **协议**（`https:`）
- **主机名**（`example.com`）
- **端口号**（`:8080`，如显式指定）

**不包含**：路径、查询参数、哈希片段

匹配规则：
1. `corsAllowedOrigins` 列表：精确字符串匹配 origin。
2. redirectUris 精确匹配：从完整 redirect URI 中**提取** `URL.origin` 后比对。
3. redirectUris 通配符匹配：通过 `matchesOriginAgainstRedirectUriPattern()` 做主机名模式匹配，但**完全忽略路径部分**。

```ts
// 示例：注册的 redirect URI = https://*.example.com/callback
// CORS 校验只检查这部分: https://*.example.com
// 路径 /callback 在 CORS 校验中被完全忽略！
```

#### redirect_uri 授权校验：完整 URL 级别的粒度

在 oidc-provider 的 `/authorize` 端点，`redirect_uri` 参数校验是**完整 URL 匹配**：
- 必须与注册的某条 redirect URI 完全一致（或通配符模式匹配）。
- 路径部分必须完全匹配。
- 查询参数在 OIDC 授权流程中也参与校验。

#### 粒度差异总结

| 维度 | CORS Origin 校验 | redirect_uri 授权校验 |
|-----|-----------------|---------------------|
| **匹配单位** | origin（协议+主机+端口） | 完整 URL（含路径） |
| **路径参与** | ❌ 完全忽略路径 | ✅ 路径必须精确匹配 |
| **通配范围** | 仅主机名支持通配 | 主机名和路径都支持通配 |
| **使用场景** | 浏览器跨域请求预检 | OIDC 授权重定向安全校验 |
| **安全目的** | 防止 CSRF / XSS 跨域 | 防止授权码被窃取重放 |

**重要注意**：不要误认为 CORS 校验通过就意味着 redirect_uri 也合法。CORS 通过只表示"该来源允许发请求"，而 redirect_uri 校验是 OIDC 协议层面的"该回跳地址已登记"的授权确认，两者安全目标不同。

### 1.6 CORS Origin 校验与 redirect URI 的关联

**源码位置**：`packages/core/src/oidc/utils.ts:121-149`

```ts
export const isOriginAllowed = (
  origin: string,
  { corsAllowedOrigins = [] }: CustomClientMetadata,
  redirectUris: string[] = []
) => { ... };
```

在 `clientBasedCORS` 回调中使用（`init.ts:302-304`）：

```ts
clientBasedCORS: (ctx, origin, client) =>
  ctx.request.origin === origin ||
  isOriginAllowed(origin, client.metadata(), client.redirectUris),
```

**匹配优先级**：

1. **精确 CORS 白名单**：检查 `corsAllowedOrigins`（CustomClientMetadata）中是否包含该 origin（精确匹配）。
2. **精确 redirect URI 提取 origin**：对于不含 `*` 的 redirectUri，提取其 `URL.origin` 进行精确比对。
3. **通配符 redirect URI 模式匹配**：对于含 `*` 的 redirectUri，调用 `matchesOriginAgainstRedirectUriPattern()` 做模式匹配。

### 1.5 通配符主机名匹配的运行时逻辑

**源码位置**：`packages/core/src/oidc/utils.ts:171-253`

#### 核心函数链

```
isOriginAllowed
  → matchesOriginAgainstRedirectUriPattern
    → parseRedirectUriOriginPattern  (解析模式 URI 的协议、主机名模式、端口)
    → matchHostnamePattern           (逐标签比对主机名)
      → matchHostnameLabel           (单标签通配匹配)
```

#### `matchHostnameLabel`（`utils.ts:173-186`）

- 不含 `*` 的标签：精确字符串比对。
- 含 `*` 的标签：将 `*` 替换为正则 `[^.]+`（匹配一个或多个非点号字符），大小写不敏感。
- **关键约束**：`*` 不匹配空标签。例如 `*.example.com` 匹配 `pr-123.example.com` 但不匹配 `example.com`（测试用例 `utils.test.ts:233-244`）。

#### `matchHostnamePattern`（`utils.ts:188-199`）

- 将 pattern 和实际 hostname 按 `.` 分割为标签数组。
- **标签数量必须完全一致**才能匹配（`patternLabels.length !== actualLabels.length` 直接返回 false）。
- 逐标签调用 `matchHostnameLabel`。

#### `parseRedirectUriOriginPattern`（`utils.ts:201-228`）

- 解析通配符 redirect URI 的协议、主机名模式和端口。
- 先将 `*` 替换为 `wildcard` 验证 URL 基本合法性。
- 不允许 authority 包含 `@` 或 `[`（IPv6）。
- 正确处理默认端口（http=80，https=443）。

#### `matchesOriginAgainstRedirectUriPattern`（`utils.ts:230-253`）

- 协议必须完全一致。
- 有效端口（含默认端口推断）必须一致。
- 调用 `matchHostnamePattern` 进行主机名模式匹配。

---

## 二、签名密钥滚动机制

### 2.1 密钥状态模型

**源码位置**：`packages/schemas/src/types/logto-config/index.ts:48-52`

```ts
export enum OidcSigningKeyStatus {
  Next = 'Next',
  Current = 'Current',
  Previous = 'Previous',
}
```

三条密钥构成一个完整的状态机：

```
Next ──(激活)──→ Current ──(降级)──→ Previous ──(删除)──→ 丢弃
```

**约束**（`packages/schemas/src/utils/oidc-private-key.ts:38-65`，`normalizeOidcPrivateKeys`）：

- `Current`：**恰好 1 把**。
- `Next`：**最多 1 把**。
- `Previous`：**最多 1 把**。
- 合计最多 3 把密钥。

**旧版兼容**（无 `status` 字段的 legacy 密钥）：
- 第一个（索引 0）→ `Current`。
- 第二个（索引 1）→ `Previous`。

### 2.2 排序规则

**源码位置**：`packages/schemas/src/utils/oidc-private-key.ts:12-22`

```ts
const oidcPrivateKeyStatusOrder: Record<OidcSigningKeyStatus, number> = {
  [OidcSigningKeyStatus.Next]: 0,
  [OidcSigningKeyStatus.Current]: 1,
  [OidcSigningKeyStatus.Previous]: 2,
};

const oidcProviderPrivateKeyOrder: Record<OidcSigningKeyStatus, number> = {
  [OidcSigningKeyStatus.Current]: 0,
  [OidcSigningKeyStatus.Next]: 1,
  [OidcSigningKeyStatus.Previous]: 2,
};
```

- **业务存储序**（`oidcPrivateKeyStatusOrder`）：`Next → Current → Previous`。
- **oidc-provider 消费序**（`oidcProviderPrivateKeyOrder`）：`Current → Next → Previous`。

`getOidcProviderPrivateKeys()` 使用 oidc-provider 序返回密钥列表，确保当前签名密钥排在首位，JWKS 端点和 JWT 签名都优先使用 `Current`。

### 2.3 密钥颁发流程

**源码位置**：`packages/core/src/utils/jwks.ts` 和 `packages/core/src/env-set/oidc.ts`

```
数据库存储 (OidcPrivateKey.value = PEM)
  → crypto.createPrivateKey(PEM)
  → crypto.createPublicKey(privateKey)
  → exportJWK(key)  // 从 node-oidc-provider 移植的 kid 计算算法
```

**kid 计算**（`jwks.ts:40-44`）：

```ts
const calculateKid = (jwk: JWK) => {
  const components = getCalculateKidComponents(jwk); // 按 kty 提取关键组件
  return createHash('sha256').update(JSON.stringify(components)).digest().toString('base64url');
};
```

kid 由密钥的密码学参数（RSA 的 n/e、EC 的 crv/x/y、OKP 的 crv/x）的 SHA-256 哈希决定，与 status 无关。

**OIDC Provider 消费**（`env-set/oidc.ts:14-42`）：

```ts
const privateKeys = getOidcProviderPrivateKeys(configs[...PrivateKeys])
  .map(({ value }) => crypto.createPrivateKey(value));
const publicKeys = privateKeys.map((key) => crypto.createPublicKey(key));
const privateJwks = await Promise.all(privateKeys.map(async (key) => exportJWK(key)));
const publicJwks = await Promise.all(publicKeys.map(async (key) => exportJWK(key)));
```

oidc-provider 初始化时接收 `jwks: { keys: privateJwks }`，同时 `publicJwks` 用于构建本地 JWKS 验证集。

**签名算法选择**（`env-set/oidc.ts:31`）：

```ts
const jwkSigningAlg = conditional(currentPrivateJwk.kty === 'EC' && 'ES384');
```

- EC 密钥 → ES384。
- RSA 密钥 → 使用 oidc-provider 默认值（PS256/RS256 等）。

### 2.4 两种轮换模式

#### 即时轮换（rotationGracePeriod = 0）

**源码位置**：`packages/core/src/libraries/oidc-private-key.ts:84-109` 和 `packages/schemas/src/utils/oidc-private-key.ts:128-146`

```
调用: POST /api/configs/oidc/private-keys/rotate  (body 无 rotationGracePeriod 或为 0)
```

流程：
1. 事务中锁定 `PrivateKeys` 行（`SELECT ... FOR UPDATE`）。
2. 检查不存在 `Next` 状态密钥（否则抛 422 错误）。
3. `getImmediatelyRotatedOidcPrivateKeys()`：
   - 新密钥 → `Current`。
   - 原 `Current` → `Previous`。
   - 原 `Previous` → **丢弃**。
4. 写入数据库。
5. `tenant.invalidateCache()` → 设置 `tenantCacheExpiresAt = now` → 下次请求重建租户实例。

#### 分阶段轮换（rotationGracePeriod > 0）

**源码位置**：`packages/core/src/libraries/oidc-private-key.ts:112-145` 和 `packages/schemas/src/utils/oidc-private-key.ts:154-169`

```
调用: POST /api/configs/oidc/private-keys/rotate  (body.rotationGracePeriod > 0)
环境默认值: PRIVATE_KEY_ROTATION_GRACE_PERIOD 环境变量（秒），默认 0
```

流程：
1. 事务中同时锁定 `PrivateKeys` 和 `SigningKeyRotationState` 行。
2. `getStagedRotatedOidcPrivateKeys()`：
   - 新密钥 → `Next`（预发布，不立即签名）。
   - 原 `Current` → 保持 `Current`（继续签名）。
   - 原 `Previous` → 保持 `Previous`。
3. `getRotationStateForStagedRotation()`：
   - `tenantCacheExpiresAt = now`（立即使租户缓存失效，让 JWKS 包含 Next 公钥）。
   - `signingKeyRotationAt = now + rotationGracePeriod * 1000`（计划激活时间）。
4. 写入数据库（密钥 + 轮换状态）。
5. 同步到 wellKnownCache。

### 2.5 灰度切换期间再次轮换：待生效密钥的覆盖规则

#### 分阶段轮换的重入行为

**源码位置**：`packages/schemas/src/utils/oidc-private-key.ts:154-169` 和 `packages/core/src/libraries/oidc-private-key.ts:112-145`

```ts
export const getStagedRotatedOidcPrivateKeys = (
  privateKeys: LogtoOidcConfigType['oidc.privateKeys'],
  newPrivateKey: OidcPrivateKey
): OidcPrivateKey[] => {
  const normalizedPrivateKeys = normalizeOidcPrivateKeys(privateKeys);
  const currentKey = getCurrentOidcPrivateKey(normalizedPrivateKeys);
  const previousKey = normalizedPrivateKeys.find(
    ({ status }) => status === OidcSigningKeyStatus.Previous
  );

  return [
    { ...newPrivateKey, status: OidcSigningKeyStatus.Next },
    { ...currentKey, status: OidcSigningKeyStatus.Current },
    ...(previousKey ? [{ ...previousKey, status: OidcSigningKeyStatus.Previous }] : []),
  ];
};
```

**关键行为**：`getStagedRotatedOidcPrivateKeys()` **不检查**是否已存在 Next 密钥。

如果灰度切换期间（已有 Next 密钥但尚未激活）再次发起分阶段轮换：
- **新的 Next 密钥覆盖旧的 Next 密钥**：旧的 Next 密钥被直接丢弃，不会降级为 Previous 或进入其他状态。
- **Current 和 Previous 保持不变**：正在签名的 Current 密钥和旧的 Previous 密钥不受影响。
- **激活时间被重置**：`signingKeyRotationAt` 被设置为 `now + rotationGracePeriod`，以新的轮换请求时间为准重新计算激活时间。

```
T0: 发起分阶段轮换 (grace = 4h)
    → [Next=KeyA, Current=KeyB, Previous=KeyC]
    → signingKeyRotationAt = T0 + 4h

T1 (T1 < T0+4h): 再次发起分阶段轮换 (grace = 2h)
    → [Next=KeyD, Current=KeyB, Previous=KeyC]  ← KeyA 被丢弃！
    → signingKeyRotationAt = T1 + 2h            ← 激活时间重置

T1+2h: 激活
    → [Current=KeyD, Previous=KeyB]            ← KeyC 被丢弃
    → KeyA 从未用于签名，也未出现在 Previous
```

#### 即时轮换的重入行为

**源码位置**：`packages/schemas/src/utils/oidc-private-key.ts:134-146`

```ts
export const getImmediatelyRotatedOidcPrivateKeys = (
  privateKeys: LogtoOidcConfigType['oidc.privateKeys'],
  newPrivateKey: OidcPrivateKey
): OidcPrivateKey[] => {
  const normalizedPrivateKeys = normalizeOidcPrivateKeys(privateKeys);
  if (normalizedPrivateKeys.some(({ status }) => status === OidcSigningKeyStatus.Next)) {
    throw new Error(
      'Immediate OIDC private key rotation is not allowed when a Next key exists'
    );
  }
  // ...
};
```

如果灰度切换期间（已有 Next 密钥）发起**即时**轮换：
- **直接报错 422**：`oidc.invalid_request`
- 原因：即时轮换的语义是"立即切换到新密钥"，如果存在 Next 密钥意味着有尚未完成的分阶段轮换，两者语义冲突。

#### 重入行为总结表

| 轮换类型 | 已有 Next 时的行为 | Next 密钥去向 | 激活时间 |
|---------|------------------|-------------|---------|
| **分阶段 → 分阶段** | ✅ 允许，新 Next 覆盖旧 Next | 旧 Next 被丢弃 | 以新请求时间重置 |
| **分阶段 → 即时** | ❌ 拒绝，抛 422 错误 | — | — |
| **即时 → 分阶段** | ✅ 无 Next，正常添加 | — | now + gracePeriod |
| **即时 → 即时** | ✅ 无 Next，正常轮换 | — | 立即生效 |

#### 被覆盖的 Next 密钥的安全边界

被丢弃的旧 Next 密钥：
- **从未用于签名**：因为它始终处于 Next 状态，而签名始终使用 Current 状态密钥。
- **公钥曾在 JWKS 中发布**：在旧 Next 存在的时间窗口内，JWKS 端点返回过它的公钥。
- **无法用于验证**：由于它从未签名过任何 token，被丢弃后不会影响现有 token 的验证。
- **无旧 token 验证风险**：因为它从未签发过 token。

---

### 2.6 SigningKeyRotationState 数据结构

**源码位置**：`packages/schemas/src/types/logto-config/index.ts:159-163`

```ts
export const signingKeyRotationStateGuard = z.object({
  tenantCacheExpiresAt: z.number().optional(),
  signingKeyRotationAt: z.number().optional(),
});
```

| 字段 | 类型 | 含义 |
|------|------|------|
| `tenantCacheExpiresAt` | `number?` | 租户实例缓存失效的时间戳，早于此时间创建的租户实例需重建 |
| `signingKeyRotationAt` | `number?` | 计划的 Next→Current 激活时间戳 |

---

## 三、灰度切换时旧凭据的处理

### 3.1 租户健康检查与缓存失效

**源码位置**：`packages/core/src/tenants/signing-key-rotation-state.ts:51-63`

```ts
export const isTenantHealthy = (
  createdAt: number,
  signingKeyRotationState?: SigningKeyRotationState
) => {
  const { tenantCacheExpiresAt, signingKeyRotationAt } = signingKeyRotationState ?? {};
  const cacheInvalidated = tenantCacheExpiresAt !== undefined && createdAt <= tenantCacheExpiresAt;
  const stagedActivationDue =
    signingKeyRotationAt !== undefined &&
    signingKeyRotationAt <= Date.now() &&
    createdAt < signingKeyRotationAt;

  return !cacheInvalidated && !stagedActivationDue;
};
```

租户实例被判定为「不健康」（需重建）的两个条件：

1. **缓存失效**：租户创建时间 ≤ `tenantCacheExpiresAt`。
2. **计划激活到期**：当前时间 ≥ `signingKeyRotationAt`，且租户创建时间 < `signingKeyRotationAt`。

### 3.2 分阶段激活的完整时序

```
T0: 调用 rotate API (rotationGracePeriod = 14400, 即 4 小时)
    ├─ 新密钥设为 Next，Current/Previous 不变
    ├─ signingKeyRotationAt = T0 + 4h
    ├─ tenantCacheExpiresAt = T0
    └─ JWKS 端点已包含 Next 公钥（第三方可预缓存）

T0 ~ T0+4h: 过渡期
    ├─ 旧 Current 密钥继续签名所有 token
    ├─ Next 公钥出现在 JWKS 中，第三方应用可提前获取并缓存
    ├─ 仍持有旧 Previous 公钥签发的 token 的客户端可通过 JWKS 验证
    └─ 租户实例在 T0 后首次请求时重建（cacheInvalidated）

T0+4h: 激活时间到达
    ├─ isTenantHealthy() 返回 false (stagedActivationDue = true)
    ├─ 租户实例重建前，EnvSet.load() 调用 promoteScheduledSigningKeyRotation()
    │   ├─ 事务中锁定 PrivateKeys + RotationState
    │   ├─ 检查 signingKeyRotationAt <= Date.now()
    │   ├─ rotateOidcPrivateKeyStatuses(): Next → Current, Current → Previous
    │   └─ 旧 Previous 被丢弃
    └─ 重建后的 oidc-provider 使用新 Current 签名

T0+4h 之后:
    ├─ 新 Current 密钥签名所有新 token
    ├─ 旧 Current（现 Previous）公钥仍在 JWKS 中
    └─ 在旧 Current 签名的 token TTL 内，第三方仍可验证
```

### 3.3 promoteScheduledSigningKeyRotation

**源码位置**：`packages/core/src/libraries/logto-config.ts:208-229`

```ts
const promoteScheduledSigningKeyRotation = async () => {
  await pool.transaction(async (connection) => {
    const transactionalQueries = createLogtoConfigQueries(connection, wellKnownCache);
    await transactionalQueries.lockPrivateSigningKeysAndRotationState();

    const rotationState = await transactionalQueries.getSigningKeyRotationState();
    if (!rotationState?.signingKeyRotationAt || rotationState.signingKeyRotationAt > Date.now()) {
      return;
    }

    const privateKeys = await transactionalQueries.getPrivateSigningKeys();
    const updatedPrivateKeys = rotateOidcPrivateKeyStatuses(privateKeys);

    if (updatedPrivateKeys === privateKeys) {
      return;
    }

    await transactionalQueries.upsertPrivateSigningKeys(updatedPrivateKeys);
  });
};
```

关键设计：
- 在 `EnvSet.load()` 中、加载 OIDC 配置之前调用（`env-set/index.ts:103`）。
- 使用 `SELECT ... FOR UPDATE` 保证并发安全。
- 如果没有待激活的 Next 密钥，跳过写入（幂等）。

### 3.4 旧凭据的处理范围

| 凭据类型 | 过渡期行为 | 激活后行为 | 完全失效时间 |
|----------|-----------|-----------|-------------|
| **Current 签发的 ID Token** | 正常验证 | Previous 公钥仍在 JWKS，可验证 | token 自然过期 + Previous 被手动删除 |
| **Current 签发的 Access Token (JWT)** | 正常验证 | 同上 | 同上 |
| **Previous 签发的 token** | Previous 公钥在 JWKS，可验证 | Previous 被丢弃后不再可验证 | 激活时刻（即时轮换）或 Previous 被删除 |
| **Next 公钥** | 出现在 JWKS，供预缓存 | 升级为 Current，用于签名 | — |
| **Cookie Keys** | 不受签名密钥轮换影响 | 同上 | — |
| **client_secret** | 不受签名密钥轮换影响 | 同上 | — |

### 3.5 Previous 密钥的删除

**源码位置**：`packages/core/src/libraries/oidc-private-key.ts:50-82`

```ts
async deletePrivateSigningKey(keyId: string): Promise<OidcPrivateKey[]> {
  // ...
  if (privateKeys.length <= 1) {
    throw new RequestError({ code: 'oidc.key_required', status: 422 });
  }
  if (deletingKey.status !== OidcSigningKeyStatus.Previous) {
    throw new RequestError({ code: 'oidc.only_previous_key_can_be_deleted', status: 422 });
  }
  // ...
}
```

- 只允许删除 `Previous` 状态的密钥。
- 至少保留一把密钥（不允许删除到 0 把）。
- 删除后调用 `tenant.invalidateCache()` 刷新租户实例。

---

## 四、回调地址校验与签名密钥的关联

### 4.1 第三方应用的特有处理

**源码位置**：`packages/core/src/oidc/resource.ts:124-129`

```ts
export const isThirdPartyApplication = async ({ applications }: Queries, applicationId: string) => {
  const application = await trySafe(async () => applications.findApplicationById(applicationId));
  return application?.isThirdParty ?? false;
};
```

第三方应用在 OIDC 流程中的特殊约束（`adapter.ts:99-126`）：

- **Scope 限制**：第三方客户端的 OP scope 被限制为 `openid`、`offline_access` 和应用级别启用的 user scope。
- **资源 Scope 过滤**：`filterResourceScopesForTheThirdPartyApplication()` 进一步过滤出应用明确授权的 API resource scope 和 organization scope。
- **Token Exchange 禁止**：`allowTokenExchange` 仅对第一方应用生效，第三方应用始终不允许。

### 4.2 缓存失效机制的界限：应用配置 vs 租户配置

回调地址与签名密钥轮换在逻辑上分属 OIDC 协议的不同层面，两者的缓存失效机制有明确界限：

| 维度 | 回调地址 / 应用元数据变更 | 签名密钥 / 租户 OIDC 配置 |
|-----|------------------------|------------------------|
| **配置级别** | 应用级（每个应用独立 | 租户级（全局） |
| **读取方式** | oidc-provider 每次从数据库实时读取 | 租户初始化时加载，缓存到内存 |
| **缓存失效触发** | ❌ 不触发 `tenant.invalidateCache() | ✅ 触发 `tenant.invalidateCache()` |
| **生效延迟** | 几乎即时（下一次数据库查询 | 需等待租户实例重建（下一次请求） |
| **影响范围** | 单个应用 | 租户下所有应用 |

#### 协同机制

1. **JWKS 端点一致性**：通配符回调地址支持多子域名部署（如 `https://*.tenant.app/callback`），而这些子域名共享同一个 JWKS 端点。分阶段密钥轮换确保 JWKS 端点在过渡期同时包含新旧公钥，避免因 DNS/CDN 缓存导致的验证失败。

2. **CORS 与 JWKS 的协调**：通配符回调地址的 origin 校验（`isOriginAllowed`）确保只有合法来源的跨域请求可以访问 OIDC 端点；而 JWKS 中 Next 公钥的提前发布确保第三方在密钥切换前已完成公钥缓存预热。

3. **Client 元数据动态读取**：由于 oidc-provider 每次从数据库读取 Client 元数据，意味着：
   - 回调地址更新后，新的授权请求立即使用新地址校验
   - 但密钥轮换后签发的 token 仍使用旧密钥签名，直到租户实例重建
   - 两者独立生效，互不依赖

---

## 五、关键文件索引

| 文件 | 职责 |
|------|------|
| `packages/toolkit/core-kit/src/utils/url.ts` | redirect URI 格式校验（精确 + 通配符） |
| `packages/toolkit/core-kit/src/regex.ts` | 协议正则定义（web: `https?:`，mobile: 自定义 scheme） |
| `packages/schemas/src/foundations/jsonb-types/oidc-module.ts` | OIDC 客户端元数据 guard、CustomClientMetadata 定义 |
| `packages/schemas/src/types/logto-config/index.ts` | OidcSigningKeyStatus 枚举、SigningKeyRotationState 类型 |
| `packages/schemas/src/utils/oidc-private-key.ts` | 密钥归一化、排序、轮换状态转换纯函数 |
| `packages/core/src/oidc/utils.ts` | isOriginAllowed、通配符主机名匹配运行时逻辑 |
| `packages/core/src/oidc/init.ts` | oidc-provider 初始化（allowWildcardRedirectUris、clientBasedCORS） |
| `packages/core/src/oidc/adapter.ts` | Client 适配器（第三方 scope 限制、redirectUris 透传） |
| `packages/core/src/oidc/resource.ts` | 第三方应用识别与资源 scope 过滤 |
| `packages/core/src/utils/jwks.ts` | JWK 导出与 kid 计算 |
| `packages/core/src/env-set/oidc.ts` | OIDC 配置加载（密钥→JWKS→签名算法） |
| `packages/core/src/libraries/oidc-private-key.ts` | OidcPrivateKeyLibrary（删除 Previous、轮换密钥事务） |
| `packages/core/src/libraries/logto-config.ts` | promoteScheduledSigningKeyRotation、getRedactedOidcKeyResponse |
| `packages/core/src/queries/logto-config.ts` | 数据库查询（锁定行、读写 RotationState） |
| `packages/core/src/tenants/signing-key-rotation-state.ts` | isTenantHealthy、缓存同步 |
| `packages/core/src/tenants/Tenant.ts` | 租户生命周期（invalidateCache、scheduleSigningKeyRotation、checkHealth） |
| `packages/core/src/routes/logto-config/index.ts` | 管理 API 路由（rotate、delete 端点） |
| `packages/shared/src/node/env/GlobalValues.ts` | privateKeyRotationGracePeriod 环境变量 |
