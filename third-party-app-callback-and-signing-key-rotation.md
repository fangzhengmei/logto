# 第三方应用接入：回调地址校验与签名密钥滚动 — 源码关联分析

> 本文档将所有结论按「源码直接事实」与「基于事实的推断」分层呈现。
> 每条推断均标注其所依据的事实编号，便于溯源核对。

---

## 一、回调地址校验 — 源码直接事实

### 事实 A1：注册阶段 redirect URI 格式校验

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
});
```

每条 URI 必须通过 `validateRedirectUrl()` 的 `web` 或 `mobile` 校验之一。校验在应用创建/更新时通过 Zod guard 执行。

### 事实 A2：validateRedirectUrl 精确匹配路径规则

**源码位置**：`packages/toolkit/core-kit/src/utils/url.ts:3-47`

1. 检查 URL 是否包含 dot-segment（`/./`、`/../`、`/%2e`、`/%2e%2e`），如有则拒绝。
2. 使用 `new URL(url)` 解析，提取 `protocol`。
3. **Web 类型**：协议必须是 `http:` 或 `https:`（`webRedirectUriProtocolRegEx = /^https?:$/`，定义于 `packages/toolkit/core-kit/src/regex.ts`）。
4. **Mobile 类型**：协议不能是 http/https，须符合自定义 scheme 规则 `^(?!http(s)?:)[a-z][\d+_a-z-]*(\.[\d+_a-z-]+)*:$`。

### 事实 A3：validateRedirectUrl 通配符匹配路径规则

**源码位置**：`packages/toolkit/core-kit/src/utils/url.ts`，`validateWildcardWebRedirectUrl()`

当 `type === 'web'` 且 URL 包含 `*` 时进入，执行 5 步校验：

| 步骤 | 函数 | 规则 |
|------|------|------|
| 1 | `hasWildcardInScheme` | 协议部分不允许出现 `*` |
| 2 | `hasWildcardInQueryOrHash` | 查询参数和 hash 部分不允许出现 `*` |
| 3 | `isAuthorityAllowedForWildcardWebRedirect` | authority 部分校验（见下） |
| 4 | `hasDotSegmentsInAbsoluteUrlPath` | 路径不允许 dot-segment |
| 5 | `isUrlProtocolAllowedAfterWildcardReplacement` | 将 `*` 替换为 `wildcard` 后须为合法 http/https URL |

`isAuthorityAllowedForWildcardWebRedirect`（`url.ts:89-110`）：
- 不允许包含 `@`（禁止 userinfo）。
- 不允许 IPv6 地址字面量（`[` 开头）。
- hostname 中含 `*` 时，**必须包含至少一个 `.`**（`https://*/callback` 被拒绝）。
- 端口号部分不允许包含 `*`。

### 事实 A4：oidc-provider 启用通配符 redirect_uri 匹配

**源码位置**：`packages/core/src/oidc/init.ts:166`

```ts
const oidc = new Provider(envSet.oidc.issuer, {
  allowWildcardRedirectUris: true,
  // ...
});
```

oidc-provider 在授权流程中校验 `redirect_uri` 时支持通配符模式匹配。`*` 匹配任意非空路径段（不含 `/`），通配仅出现在 URI 的路径和主机名部分（已由 A3 保证）。

### 事实 A5：Client 元数据由 oidc-provider 实时从数据库读取

**源码位置**：`packages/core/src/oidc/adapter.ts:128-203`

```ts
if (modelName === 'Client') {
  return {
    find: async (id) => {
      const application = await tryThat(
        findApplicationById(id),
        new errors.InvalidClient(`invalid client ${id}`)
      );
      return transpileClient(application);
    },
    // ...
  };
}
```

oidc-provider 每次需要 Client 元数据（校验 `redirect_uri`、获取 `corsAllowedOrigins` 等）时，通过 `postgresAdapter.find()` 从数据库实时读取，**不做本地缓存**。

### 事实 A6：应用 PATCH 路由不触发租户缓存失效

**源码位置**：`packages/core/src/routes/applications/application.ts:337-458`

`PATCH /applications/:id` 处理函数中，更新 `oidcClientMetadata.redirectUris` 等字段时：
1. 直接调用 `queries.applications.updateApplicationById(id, rest, 'replace')` 写入数据库。
2. **没有**调用 `tenant.invalidateCache()`。

### 事实 A7：CORS 校验入口与 isOriginAllowed 签名

**源码位置**：`packages/core/src/oidc/init.ts:302-304` 与 `packages/core/src/oidc/utils.ts:121-149`

```ts
// init.ts — 注册回调
clientBasedCORS: (ctx, origin, client) =>
  ctx.request.origin === origin ||
  isOriginAllowed(origin, client.metadata(), client.redirectUris),
```

```ts
// utils.ts — 函数签名
export const isOriginAllowed = (
  origin: string,
  { corsAllowedOrigins = [] }: CustomClientMetadata,
  redirectUris: string[] = []
) => { ... };
```

`isOriginAllowed` 接收的第一个参数 `origin` 是浏览器 CORS 语义的 origin（协议+主机+端口），**不含路径**。匹配优先级：
1. `corsAllowedOrigins` 列表精确匹配。
2. 对不含 `*` 的 redirectUri，提取 `URL.origin` 后精确比对。
3. 对含 `*` 的 redirectUri，调用 `matchesOriginAgainstRedirectUriPattern()` 做主机名模式匹配。

### 事实 A8：CORS 通配符匹配完全忽略路径

**源码位置**：`packages/core/src/oidc/utils.ts:171-253`

CORS 通配符匹配函数链：

```
isOriginAllowed
  → matchesOriginAgainstRedirectUriPattern
    → parseRedirectUriOriginPattern   (解析协议、主机名模式、端口)
    → matchHostnamePattern            (逐标签比对主机名)
      → matchHostnameLabel            (单标签通配匹配)
```

`matchesOriginAgainstRedirectUriPattern`（`utils.ts:230-253`）：
- 比较**协议**（必须一致）。
- 比较**端口**（含默认端口推断，必须一致）。
- 调用 `matchHostnamePattern` 比较**主机名**。
- **不读取、不比较、不传递路径信息**。

`parseRedirectUriOriginPattern`（`utils.ts:201-228`）：
- 从通配符 redirect URI 中只提取协议、主机名模式、端口。
- 路径部分在解析时被丢弃。

`matchHostnameLabel`（`utils.ts:173-186`）：
- 不含 `*` 的标签：精确字符串比对。
- 含 `*` 的标签：将 `*` 替换为正则 `[^.]+`，大小写不敏感。
- `*` 不匹配空标签（测试用例 `utils.test.ts:233-244`：`*.example.com` 匹配 `pr-123.example.com` 但不匹配 `example.com`）。

`matchHostnamePattern`（`utils.ts:188-199`）：
- 按 `.` 分割标签，**标签数量必须完全一致**。
- 逐标签调用 `matchHostnameLabel`。

---

## 二、签名密钥轮换 — 源码直接事实

### 事实 B1：密钥三态模型与约束

**源码位置**：`packages/schemas/src/types/logto-config/index.ts:48-52` 与 `packages/schemas/src/utils/oidc-private-key.ts:38-65`

```ts
export enum OidcSigningKeyStatus {
  Next = 'Next',
  Current = 'Current',
  Previous = 'Previous',
}
```

`normalizeOidcPrivateKeys()` 约束：
- `Current`：**恰好 1 把**。
- `Next`：**最多 1 把**。
- `Previous`：**最多 1 把**。
- 合计最多 3 把密钥。

旧版兼容（无 `status` 字段）：索引 0 → Current，索引 1 → Previous。

### 事实 B2：即时轮换流程（rotationGracePeriod = 0）

**源码位置**：`packages/core/src/libraries/oidc-private-key.ts:84-109` 与 `packages/schemas/src/utils/oidc-private-key.ts:128-146`

```ts
export const getImmediatelyRotatedOidcPrivateKeys = (
  privateKeys, newPrivateKey
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

流程：
1. 事务中锁定 `PrivateKeys` 行（`SELECT ... FOR UPDATE`）。
2. **检查不存在 Next 状态密钥**，否则抛异常。
3. 新密钥 → Current，原 Current → Previous，原 Previous → **丢弃**。
4. 写入数据库。
5. `tenant.invalidateCache()` → 设置 `tenantCacheExpiresAt = now`。

### 事实 B3：分阶段轮换流程（rotationGracePeriod > 0）

**源码位置**：`packages/core/src/libraries/oidc-private-key.ts:112-145` 与 `packages/schemas/src/utils/oidc-private-key.ts:154-169`

```ts
export const getStagedRotatedOidcPrivateKeys = (
  privateKeys, newPrivateKey
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

流程：
1. 事务中锁定 `PrivateKeys` + `SigningKeyRotationState` 行。
2. 新密钥 → Next，原 Current 保持 Current，原 Previous 保持 Previous。
3. `signingKeyRotationAt = now + rotationGracePeriod * 1000`。
4. `tenantCacheExpiresAt = now`。
5. 写入数据库，同步 wellKnownCache。

### 事实 B4：getStagedRotatedOidcPrivateKeys 不检查已有 Next 密钥

**源码位置**：`packages/schemas/src/utils/oidc-private-key.ts:154-169`

函数体内**没有**检查 `normalizedPrivateKeys` 中是否已存在 `Next` 状态密钥。它只取 `currentKey` 和 `previousKey`，然后用新密钥覆盖 Next 位置。

对比 B2：`getImmediatelyRotatedOidcPrivateKeys` **显式检查**并拒绝已有 Next 的场景。

### 事实 B5：SigningKeyRotationState 数据结构

**源码位置**：`packages/schemas/src/types/logto-config/index.ts:159-163`

```ts
export const signingKeyRotationStateGuard = z.object({
  tenantCacheExpiresAt: z.number().optional(),
  signingKeyRotationAt: z.number().optional(),
});
```

| 字段 | 类型 | 含义 |
|------|------|------|
| `tenantCacheExpiresAt` | `number?` | 缓存失效时间戳，早于此时间创建的租户实例需重建 |
| `signingKeyRotationAt` | `number?` | 计划的 Next→Current 激活时间戳 |

### 事实 B6：租户健康检查逻辑

**源码位置**：`packages/core/src/tenants/signing-key-rotation-state.ts:51-63`

```ts
export const isTenantHealthy = (
  createdAt: number,
  signingKeyRotationState?: SigningKeyRotationState
) => {
  const { tenantCacheExpiresAt, signingKeyRotationAt } = signingKeyRotationState ?? {};
  const cacheInvalidated =
    tenantCacheExpiresAt !== undefined && createdAt <= tenantCacheExpiresAt;
  const stagedActivationDue =
    signingKeyRotationAt !== undefined &&
    signingKeyRotationAt <= Date.now() &&
    createdAt < signingKeyRotationAt;

  return !cacheInvalidated && !stagedActivationDue;
};
```

租户实例不健康（需重建）的两个独立条件：
1. `cacheInvalidated`：租户创建时间 ≤ `tenantCacheExpiresAt`。
2. `stagedActivationDue`：当前时间 ≥ `signingKeyRotationAt`，且租户创建时间 < `signingKeyRotationAt`。

### 事实 B7：密钥激活 promoteScheduledSigningKeyRotation

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

在 `EnvSet.load()` 中、加载 OIDC 配置之前调用（`env-set/index.ts:103`）。使用 `SELECT ... FOR UPDATE` 保证并发安全。如果没有 Next 密钥则跳过（幂等）。

`rotateOidcPrivateKeyStatuses`（`packages/schemas/src/utils/oidc-private-key.ts:177-197`）：Next → Current，Current → Previous，旧 Previous 丢弃。若无 Next 密钥则返回原数组引用（`===` 判断跳过写入）。

### 事实 B8：密钥颁发与 kid 计算

**源码位置**：`packages/core/src/utils/jwks.ts:40-44`

```ts
const calculateKid = (jwk: JWK) => {
  const components = getCalculateKidComponents(jwk);
  return createHash('sha256').update(JSON.stringify(components)).digest().toString('base64url');
};
```

kid 由密钥密码学参数的 SHA-256 哈希决定，与 status 字段无关。

OIDC Provider 消费（`env-set/oidc.ts:14-42`）：所有状态（Next/Current/Previous）的私钥均导出为 JWK 并传给 oidc-provider 的 `jwks` 配置项，Current 排首位（`oidcProviderPrivateKeyOrder`）。

### 事实 B9：Previous 密钥的删除约束

**源码位置**：`packages/core/src/libraries/oidc-private-key.ts:50-82`

```ts
if (privateKeys.length <= 1) {
  throw new RequestError({ code: 'oidc.key_required', status: 422 });
}
if (deletingKey.status !== OidcSigningKeyStatus.Previous) {
  throw new RequestError({ code: 'oidc.only_previous_key_can_be_deleted', status: 422 });
}
```

只允许删除 Previous 状态密钥，至少保留 1 把。删除后调用 `tenant.invalidateCache()`。

### 事实 B10：签名密钥轮换触发租户缓存失效

**源码位置**：`packages/core/src/libraries/oidc-private-key.ts:84-145`

- 即时轮换：B2 步骤 5 调用 `tenant.invalidateCache()`。
- 分阶段轮换：B3 步骤 4 设置 `tenantCacheExpiresAt = now`，并通过 `syncSigningKeyRotationStateCache` 同步到 wellKnownCache。

---

## 三、第三方应用特有约束 — 源码直接事实

### 事实 C1：第三方应用识别与 scope 限制

**源码位置**：`packages/core/src/oidc/resource.ts:124-129` 与 `packages/core/src/oidc/adapter.ts:99-126`

```ts
export const isThirdPartyApplication = async ({ applications }, applicationId) => {
  const application = await trySafe(async () => applications.findApplicationById(applicationId));
  return application?.isThirdParty ?? false;
};
```

第三方客户端在 OIDC 流程中的约束：
- OP scope 限制为 `openid`、`offline_access` 和应用级别启用的 user scope。
- `filterResourceScopesForTheThirdPartyApplication()` 过滤出应用明确授权的 API resource scope 和 organization scope。
- `allowTokenExchange` 对第三方应用始终无效。

---

## 四、基于事实的推断

### 推断 1：回调地址变更不依赖租户缓存失效机制

**推断内容**：回调地址（redirectUris / corsAllowedOrigins）变更后即时生效，不需要等待租户实例重建。

**事实依据**：
- **A5**：oidc-provider 通过 `postgresAdapter.find()` 每次从数据库实时读取 Client 元数据，不做本地缓存。
- **A6**：`PATCH /applications/:id` 路由不调用 `tenant.invalidateCache()`。
- 对比 **B10**：签名密钥轮换才触发 `tenant.invalidateCache()`。

**生效机制差异总结**：

| 配置类型 | 触发缓存失效 | 生效方式 | 生效延迟 |
|---------|-------------|---------|---------|
| redirectUris | ❌（依据 A6） | 数据库实时读取（依据 A5） | 下一次数据库查询 |
| corsAllowedOrigins | ❌（依据 A6） | 数据库实时读取（依据 A5） | 下一次数据库查询 |
| 签名密钥 | ✅（依据 B10） | 重建租户实例重新加载 | 下一次请求（需重建） |

---

### 推断 2：CORS origin 校验与 redirect_uri 授权校验的匹配粒度不同

**推断内容**：CORS 校验仅匹配 origin 级别（协议+主机+端口），不涉及路径；redirect_uri 授权校验是完整 URL 级别（含路径），两者不应混淆。

**事实依据**：
- **A7**：`isOriginAllowed` 的第一个参数 `origin` 由浏览器 CORS 机制提供，按规范只含协议+主机+端口，不含路径。
- **A8**：`matchesOriginAgainstRedirectUriPattern` 只比较协议、端口、主机名，`parseRedirectUriOriginPattern` 在解析时丢弃路径部分。
- **A4**：oidc-provider 的 redirect_uri 校验（由 `allowWildcardRedirectUris: true` 启用）在授权端点对完整 URL 做匹配，路径参与校验。

**粒度差异对照表**：

| 维度 | CORS Origin 校验 | redirect_uri 授权校验 |
|-----|-----------------|---------------------|
| 匹配单位 | origin（协议+主机+端口） | 完整 URL（含路径） |
| 路径参与 | ❌ 完全忽略（依据 A8） | ✅ 必须精确匹配（依据 A4） |
| 通配范围 | 仅主机名支持通配（依据 A8） | 主机名和路径都支持通配（依据 A3+A4） |
| 使用场景 | 浏览器跨域请求预检 | OIDC 授权重定向安全校验 |
| 安全目的 | 防止 CSRF/XSS 跨域 | 防止授权码被窃取重放 |

**具体示例**：注册 redirect URI = `https://*.example.com/callback`
- CORS 校验只检查 `https://*.example.com`（协议+通配主机名），路径 `/callback` 被忽略（依据 A8）。
- redirect_uri 授权校验要求完整 URL 匹配，`/callback` 必须一致（依据 A4）。
- 因此 `https://pr-1.example.com/other-path` 能通过 CORS 校验但**不能**通过 redirect_uri 授权校验。

**安全含义**：CORS 通过只表示"该来源允许发跨域请求"，redirect_uri 校验是"该回跳地址已登记"的授权确认，两者安全目标不同，不能互相替代。

---

### 推断 3：灰度切换期间再次分阶段轮换会覆盖旧 Next 密钥

**推断内容**：灰度切换期间（已有 Next 密钥尚未激活），再次发起分阶段轮换时，新的 Next 密钥直接替换旧的 Next 密钥，旧 Next 密钥被丢弃且从未用于签名。

**事实依据**：
- **B4**：`getStagedRotatedOidcPrivateKeys` 不检查是否已存在 Next 密钥，只取 `currentKey` 和 `previousKey`，然后返回 `[newKey→Next, currentKey→Current, previousKey→Previous]`，旧的 Next 密钥不在此返回数组中。
- **B1**：`normalizeOidcPrivateKeys` 约束 Next 最多 1 把，因此写入数据库时旧的 Next 必然被覆盖。
- **B3**：`signingKeyRotationAt` 被重置为 `now + rotationGracePeriod`，以新请求时间为准。

**时序示例**：

```
T0: 发起分阶段轮换 (grace = 4h)
    → [Next=KeyA, Current=KeyB, Previous=KeyC]
    → signingKeyRotationAt = T0 + 4h

T1 (T1 < T0+4h): 再次发起分阶段轮换 (grace = 2h)
    → [Next=KeyD, Current=KeyB, Previous=KeyC]   ← KeyA 被丢弃（依据 B4）
    → signingKeyRotationAt = T1 + 2h              ← 激活时间重置（依据 B3）

T1+2h: 激活
    → [Current=KeyD, Previous=KeyB]               ← KeyC 被丢弃
    → KeyA 从未用于签名
```

---

### 推断 4：灰度切换期间不能发起即时轮换

**推断内容**：灰度切换期间（已有 Next 密钥），发起即时轮换会被拒绝。

**事实依据**：
- **B2**：`getImmediatelyRotatedOidcPrivateKeys` 显式检查 `some(({ status }) => status === OidcSigningKeyStatus.Next)`，若存在则抛异常。

**重入行为总结**：

| 轮换类型 | 已有 Next 时的行为 | 事实依据 |
|---------|------------------|---------|
| 分阶段 → 分阶段 | ✅ 允许，新 Next 覆盖旧 Next | B4 |
| 分阶段 → 即时 | ❌ 拒绝，抛 422 | B2 |
| 即时 → 分阶段 | ✅ 无 Next，正常添加 | B3 |
| 即时 → 即时 | ✅ 无 Next，正常轮换 | B2 |

---

### 推断 5：被覆盖的 Next 密钥不会造成安全风险

**推断内容**：被覆盖丢弃的旧 Next 密钥不影响 token 验证安全。

**事实依据**：
- **B8**：oidc-provider 签名时按 `oidcProviderPrivateKeyOrder` 排序，Current 排首位并优先使用。Next 状态密钥不会被用于签名。
- **B1**：密钥状态模型中 Next 的含义是"待生效"，签名始终使用 Current。
- 因此旧 Next 密钥从未签发过 token，被丢弃后不存在需要用它验证的 token。

但需注意：旧 Next 密钥的公钥曾出现在 JWKS 端点（B3 步骤 4 设置 `tenantCacheExpiresAt = now` 导致租户重建，Next 公钥被导出到 JWKS）。这只是增加了 JWKS 中曾出现但从未用于验证的公钥记录，不构成安全风险。

---

### 推断 6：回调地址变更与签名密钥轮换的缓存失效界限

**推断内容**：回调地址变更是应用级配置，即时生效，不触发租户缓存失效；签名密钥轮换是租户级配置，需通过租户缓存失效触发重建才能生效。两者独立、互不依赖。

**事实依据**：
- **A5 + A6**：回调地址通过数据库实时读取生效，不触发缓存失效。
- **B10**：签名密钥轮换显式触发 `tenant.invalidateCache()`。
- **B6**：`isTenantHealthy` 的两个判定条件（`cacheInvalidated`、`stagedActivationDue`）都与签名密钥轮换状态相关，与回调地址无关。

**界限对照**：

| 维度 | 回调地址 / 应用元数据 | 签名密钥 / 租户 OIDC 配置 |
|-----|----------------------|--------------------------|
| 配置级别 | 应用级（每个应用独立） | 租户级（全局） |
| 读取方式 | 数据库实时读取（A5） | 租户初始化时加载到内存（B8） |
| 缓存失效触发 | ❌ 不触发（A6） | ✅ 触发（B10） |
| 生效延迟 | 几乎即时 | 需等待租户实例重建 |
| 影响范围 | 单个应用 | 租户下所有应用 |

---

### 推断 7：分阶段轮换过渡期的安全窗口设计

**推断内容**：分阶段轮换的过渡期确保第三方应用在密钥切换前完成公钥预热，且旧密钥签发的 token 在切换后仍可验证。

**事实依据**：
- **B3**：分阶段轮换时 `tenantCacheExpiresAt = now`，立即触发租户重建，JWKS 端点将包含 Next 公钥（B8 将所有状态密钥导出到 JWKS）。
- **B7**：激活时 `rotateOidcPrivateKeyStatuses` 将 Next→Current、Current→Previous，旧 Previous 丢弃。
- **B8**：激活后 Previous 公钥仍在 JWKS 中，旧 Current 签发的 token 在其 TTL 内仍可验证。

**完整时序**：

```
T0: 发起分阶段轮换 (grace = 4h)
    ├─ 新密钥设为 Next，Current/Previous 不变（B3）
    ├─ signingKeyRotationAt = T0 + 4h（B3）
    ├─ tenantCacheExpiresAt = T0（B3）
    └─ JWKS 包含 Next 公钥（B8 + B3 触发重建）

T0 ~ T0+4h: 过渡期
    ├─ Current 密钥继续签名所有 token（B8 排序保证）
    ├─ Next 公钥在 JWKS 中，第三方可预缓存
    └─ Previous 公钥仍在 JWKS，旧 token 可验证

T0+4h: 激活
    ├─ isTenantHealthy() 返回 false（B6: stagedActivationDue）
    ├─ promoteScheduledSigningKeyRotation() 执行状态晋升（B7）
    └─ 重建后的 oidc-provider 使用新 Current 签名

T0+4h 之后:
    ├─ 新 Current 签发所有新 token
    ├─ 旧 Current（现 Previous）公钥仍在 JWKS
    └─ 旧 token 在 TTL 内仍可通过 Previous 公钥验证
```

---

### 推断 8：JWKS 端点与通配符回调地址的协同关系

**推断内容**：通配符回调地址支持多子域名部署，这些子域名共享同一个 JWKS 端点。分阶段轮换确保 JWKS 在过渡期同时包含新旧公钥，避免因 DNS/CDN 缓存导致验证失败。

**事实依据**：
- **A3**：通配符回调地址如 `https://*.tenant.app/callback` 允许任意子域名发起授权。
- **B3 + B8**：JWKS 端点是租户级全局端点，分阶段轮换时 JWKS 同时包含 Next 和 Current 公钥。
- **B6**：租户缓存失效和密钥激活的判定逻辑确保 JWKS 端点内容随状态变化及时更新。

---

## 五、关键文件索引

| 文件 | 事实编号 | 职责 |
|------|---------|------|
| `packages/toolkit/core-kit/src/utils/url.ts` | A2, A3 | redirect URI 格式校验（精确 + 通配符） |
| `packages/toolkit/core-kit/src/regex.ts` | A2 | 协议正则定义 |
| `packages/schemas/src/foundations/jsonb-types/oidc-module.ts` | A1 | OIDC 客户端元数据 guard |
| `packages/core/src/oidc/utils.ts` | A7, A8 | isOriginAllowed、通配符主机名匹配 |
| `packages/core/src/oidc/init.ts` | A4, A7 | oidc-provider 初始化、clientBasedCORS 注册 |
| `packages/core/src/oidc/adapter.ts` | A5, C1 | Client 适配器（实时读取 + 第三方 scope 限制） |
| `packages/core/src/routes/applications/application.ts` | A6 | 应用 PATCH 路由（不触发缓存失效） |
| `packages/schemas/src/types/logto-config/index.ts` | B1, B5 | OidcSigningKeyStatus 枚举、SigningKeyRotationState 类型 |
| `packages/schemas/src/utils/oidc-private-key.ts` | B1, B2, B3, B4, B7 | 密钥归一化、排序、轮换状态转换纯函数 |
| `packages/core/src/utils/jwks.ts` | B8 | JWK 导出与 kid 计算 |
| `packages/core/src/env-set/oidc.ts` | B8 | OIDC 配置加载（密钥→JWKS→签名算法） |
| `packages/core/src/libraries/oidc-private-key.ts` | B2, B3, B9, B10 | OidcPrivateKeyLibrary（轮换/删除事务） |
| `packages/core/src/libraries/logto-config.ts` | B7 | promoteScheduledSigningKeyRotation |
| `packages/core/src/queries/logto-config.ts` | B7 | 数据库查询（锁定行、读写 RotationState） |
| `packages/core/src/tenants/signing-key-rotation-state.ts` | B6 | isTenantHealthy |
| `packages/core/src/tenants/Tenant.ts` | B10 | 租户生命周期（invalidateCache） |
| `packages/core/src/oidc/resource.ts` | C1 | 第三方应用识别与资源 scope 过滤 |
