# oidc-provider 结论与证据对应表 + 推断反例说明

> 本文档将现有文档中的关键结论逐一对应到具体的函数调用或代码语句，并补充反例说明证据不足的推断。

---

## 一、结论与证据对应表

### 1.1 回调地址校验相关

| 结论 | 证据类型 | 具体位置 | 代码语句 |
|------|---------|---------|---------|
| **redirect URI 注册时必须通过 validateRedirectUrl 校验** | ✅ 直接事实 | `packages/schemas/src/foundations/jsonb-types/oidc-module.ts:48-56` | `z.string().refine((url) => validateRedirectUrl(url, 'web') || validateRedirectUrl(url, 'mobile'))` |
| **Web 类型 redirect URI 协议只能是 http: 或 https:** | ✅ 直接事实 | `packages/toolkit/core-kit/src/regex.ts` + `packages/toolkit/core-kit/src/utils/url.ts:20-25` | `webRedirectUriProtocolRegEx = /^https?:$/` |
| **Mobile 类型 redirect URI 协议不能是 http/https** | ✅ 直接事实 | `packages/toolkit/core-kit/src/utils/url.ts:30-35` | `!protocol.match(webRedirectUriProtocolRegEx)` + custom scheme 正则 |
| **通配符 redirect URI 协议部分不允许出现 `*`** | ✅ 直接事实 | `packages/toolkit/core-kit/src/utils/url.ts:89-92` | `hasWildcardInScheme(url)` 检查抛出 `URL_SCHEME_HAS_WILDCARD` |
| **通配符 redirect URI 查询参数和 hash 不允许 `*`** | ✅ 直接事实 | `packages/toolkit/core-kit/src/utils/url.ts:93-96` | `hasWildcardInQueryOrHash(url)` 检查抛出 `URL_QUERY_OR_HASH_HAS_WILDCARD` |
| **通配符 hostname 必须包含至少一个 `.`** | ✅ 直接事实 | `packages/toolkit/core-kit/src/utils/url.ts:97-101` | `if (hostname.includes('*') && !hostname.includes('.'))` 抛出 `URL_WILDCARD_AUTHORITY_HAS_NO_DOT` |
| **通配符端口号部分不允许 `*`** | ✅ 直接事实 | `packages/toolkit/core-kit/src/utils/url.ts:102-105` | `if (port.includes('*'))` 抛出 `URL_PORT_HAS_WILDCARD` |
| **oidc-provider 配置中启用了 allowWildcardRedirectUris** | ✅ 直接事实 | `packages/core/src/oidc/init.ts:166` | `allowWildcardRedirectUris: true,` |
| **oidc-provider Client 元数据每次从数据库读取** | ✅ 直接事实 | `packages/core/src/oidc/adapter.ts:186-189` | `findApplicationById(id)` 每次调用 |
| **应用更新路由不触发 tenant.invalidateCache()** | ✅ 直接事实 | `packages/core/src/routes/applications/application.ts:337-458` | 整个函数体内无 `tenant.invalidateCache()` 调用 |
| **CORS 校验使用 isOriginAllowed 函数** | ✅ 直接事实 | `packages/core/src/oidc/init.ts:302-304` | `isOriginAllowed(origin, client.metadata(), client.redirectUris)` |
| **isOriginAllowed 优先检查 corsAllowedOrigins** | ✅ 直接事实 | `packages/core/src/oidc/utils.ts:126-128` | `if (corsAllowedOrigins.includes(origin)) { return true; }` |
| **非通配 redirect URI 做精确 origin 匹配** | ✅ 直接事实 | `packages/core/src/oidc/utils.ts:130-141` | `!uri.includes('*')` 时 `new URL(uri).origin === origin` |
| **通配 redirect URI 调用 matchesOriginAgainstRedirectUriPattern** | ✅ 直接事实 | `packages/core/src/oidc/utils.ts:143-145` | `if (matchesOriginAgainstRedirectUriPattern(origin, uri))` |
| **通配符 CORS 匹配只比较协议、端口、主机名** | ✅ 直接事实 | `packages/core/src/oidc/utils.ts:230-252` | `matchesOriginAgainstRedirectUriPattern` 内只比较 protocol/port/hostname |
| **CORS 通配符匹配完全忽略路径** | ✅ 直接事实 | `packages/core/src/oidc/utils.ts:201-228` | `parseRedirectUriOriginPattern` 中 `authority = rest.split(/[#/?]/)[0]`，路径被丢弃 |
| **通配符主机名匹配标签数量必须一致** | ✅ 直接事实 | `packages/core/src/oidc/utils.ts:188-194` | `if (patternLabels.length !== actualLabels.length) { return false; }` |
| **通配符 `*` 在单标签中匹配 [^.]+** | ✅ 直接事实 | `packages/core/src/oidc/utils.ts:173-186` | `new RegExp(\`^\${...}\`, 'i')` 中 `*` 被替换为 `[^.]+` |
| **通配符 `*` 不匹配空标签** | ✅ 直接事实 | `packages/core/src/oidc/utils.test.ts:233-244` | `*.example.com` 不匹配 `example.com` 的测试用例 |

---

### 1.2 签名密钥轮换相关

| 结论 | 证据类型 | 具体位置 | 代码语句 |
|------|---------|---------|---------|
| **密钥有 Next/Current/Previous 三态** | ✅ 直接事实 | `packages/schemas/src/types/logto-config/index.ts:48-52` | `enum OidcSigningKeyStatus { Next, Current, Previous }` |
| **Current 状态密钥恰好 1 把** | ✅ 直接事实 | `packages/schemas/src/utils/oidc-private-key.ts:51-53` | `if (currentKeys.length !== 1)` 抛出 `PRIVATE_KEY_NO_CURRENT` 或 `PRIVATE_KEY_MULTIPLE_CURRENTS` |
| **Next 状态密钥最多 1 把** | ✅ 直接事实 | `packages/schemas/src/utils/oidc-private-key.ts:55-57` | `if (nextKeys.length > 1)` 抛出 `PRIVATE_KEY_MULTIPLE_NEXTS` |
| **Previous 状态密钥最多 1 把** | ✅ 直接事实 | `packages/schemas/src/utils/oidc-private-key.ts:59-61` | `if (previousKeys.length > 1)` 抛出 `PRIVATE_KEY_MULTIPLE_PREVIOUS` |
| **即时轮换时若存在 Next 密钥则抛异常** | ✅ 直接事实 | `packages/schemas/src/utils/oidc-private-key.ts:131-135` | `if (normalizedPrivateKeys.some(({ status }) => status === OidcSigningKeyStatus.Next))` 抛错 |
| **即时轮换流程是 New→Current, Current→Previous, Previous→丢弃** | ✅ 直接事实 | `packages/schemas/src/utils/oidc-private-key.ts:136-144` | `[newKey→Current, current→Previous]`，previous 不在返回数组中 |
| **分阶段轮换时 getStagedRotatedOidcPrivateKeys 不检查已有 Next** | ✅ 直接事实 | `packages/schemas/src/utils/oidc-private-key.ts:154-169` | 函数体内无 Next 存在性检查 |
| **分阶段轮换流程是 New→Next, Current→Current, Previous→Previous** | ✅ 直接事实 | `packages/schemas/src/utils/oidc-private-key.ts:161-168` | `[newKey→Next, current→Current, ...(previousKey ? [previous→Previous] : [])]` |
| **分阶段轮换设置 signingKeyRotationAt = now + gracePeriod** | ✅ 直接事实 | `packages/core/src/libraries/oidc-private-key.ts:130` | `signingKeyRotationAt: Date.now() + rotationGracePeriod * 1000` |
| **分阶段轮换设置 tenantCacheExpiresAt = now** | ✅ 直接事实 | `packages/core/src/libraries/oidc-private-key.ts:129` | `tenantCacheExpiresAt: Date.now()` |
| **isTenantHealthy 检查 cacheInvalidated 和 stagedActivationDue** | ✅ 直接事实 | `packages/core/src/tenants/signing-key-rotation-state.ts:51-63` | `return !cacheInvalidated && !stagedActivationDue` |
| **stagedActivationDue 条件: now ≥ signingKeyRotationAt 且 tenant 创建时间 < 它** | ✅ 直接事实 | `packages/core/src/tenants/signing-key-rotation-state.ts:57-60` | `signingKeyRotationAt !== undefined && signingKeyRotationAt <= Date.now() && createdAt < signingKeyRotationAt` |
| **promoteScheduledSigningKeyRotation 使用 SELECT ... FOR UPDATE 锁定** | ✅ 直接事实 | `packages/core/src/libraries/logto-config.ts:211-212` | `lockPrivateSigningKeysAndRotationState()` |
| **密钥 kid 由密钥参数 SHA-256 哈希计算** | ✅ 直接事实 | `packages/core/src/utils/jwks.ts:40-44` | `createHash('sha256').update(JSON.stringify(components))` |
| **所有状态密钥都导出到 JWKS** | ✅ 直接事实 | `packages/core/src/env-set/oidc.ts:14-42` | `oidcProviderPrivateKeyOrder` 排序后全部导出 |
| **只能删除 Previous 状态密钥** | ✅ 直接事实 | `packages/core/src/libraries/oidc-private-key.ts:67-72` | `if (deletingKey.status !== OidcSigningKeyStatus.Previous)` 抛 422 |
| **至少保留 1 把密钥** | ✅ 直接事实 | `packages/core/src/libraries/oidc-private-key.ts:64-66` | `if (privateKeys.length <= 1)` 抛 422 |

---

### 1.3 第三方应用 Token Exchange 相关

| 结论 | 证据类型 | 具体位置 | 代码语句 |
|------|---------|---------|---------|
| **第三方应用创建/更新时 allowTokenExchange=true 会被拒绝** | ✅ 直接事实 | `packages/core/src/routes/applications/application.ts:46-56` | `if (isThirdParty && allowTokenExchange === true)` 抛 422 |
| **getConstantClientMetadata 根据 allowTokenExchange 条件注入 grant_type** | ✅ 直接事实 | `packages/core/src/oidc/utils.ts:40` | `const optionalGrantTypes = condArray(options?.allowTokenExchange && GrantType.TokenExchange)` |
| **allowTokenExchange=false 时 grant_types 不包含 TokenExchange** | ✅ 直接事实 | `packages/core/src/oidc/utils.test.ts:71-77` | 测试用例验证 |
| **allowTokenExchange=true 时 grant_types 包含 TokenExchange** | ✅ 直接事实 | `packages/core/src/oidc/utils.test.ts:55-69` | 测试用例验证 |
| **transpileClient 调用 getConstantClientMetadata** | ✅ 直接事实 | `packages/core/src/oidc/adapter.ts:165` | `...getConstantClientMetadata(envSet, type, customClientMetadata),` |
| **oidc-provider 会在 grant handler 执行前做 grantTypeAllowed 检查** | ✅ 直接事实 | `packages/core/src/oidc/utils.ts:30-32` | 注释明确声明：`oidc-provider will enforce client.grantTypeAllowed(type) before invoking any grant handler` |
| **Token Exchange grant handler 不做额外的 grant type 检查** | ✅ 直接事实 | `packages/core/src/oidc/grants/token-exchange/index.ts` | handler 内无 grant type 校验逻辑 |
| **第三方应用 scope 限制为 openid/offline_access + 用户授权的 scope** | ✅ 直接事实 | `packages/core/src/oidc/adapter.ts:115-126` | `getThirdPartyClientScopes` 返回 `['openid', 'offline_access', ...availableUserScopes]` |
| **第三方应用 resource scopes 在 resource server fetch 中过滤** | ✅ 直接事实 | `packages/core/src/oidc/adapter.ts:124` | 注释：`Resource scopes will be filtered in the resource server's scopes fetching method` |
| **filterResourceScopesForTheThirdPartyApplication 过滤 API scope** | ✅ 直接事实 | `packages/core/src/oidc/resource.ts:124-129` | 函数定义 + 调用链 |

---

## 二、证据不足的推断 + 反例说明

### 2.1 推断 1：oidc-provider 的 `*` 匹配任意非空路径段

**原结论**（标记为事实 A4）：
> `*` 匹配任意非空路径段（不含 `/`）

**证据状态**：⚠️ **证据不足，仅为推断**

**现有证据链的薄弱点**：
1. Logto 代码中只配置了 `allowWildcardRedirectUris: true`（`init.ts:166`），但**没有直接测试或验证 oidc-provider 内部 `*` 的匹配规则**。
2. Logto 的注册时校验（A3）限制了 `*` 只能出现在主机名和路径，但这是 Logto 层面的约束，不是 oidc-provider 层面的行为。
3. Logto 使用的是 fork 版本 (`github:logto-io/node-oidc-provider#5570006785b44e0f125ee4cb6bf540338721b1f3`)，**没有办法直接验证 fork 中这部分逻辑是否与上游一致**。

**反例说明（如果证据不足就当作事实的风险）**：

| 假设场景 | 风险 |
|---------|------|
| 上游 `client.js` 中 `*` 实际匹配的是 `.*`（含 `/`）而不是 `[^/]+` | 如果 Logto 配置了 `https://example.com/*/callback`，而 oidc-provider 实际允许 `https://example.com/a/b/callback` 绕过路径校验 |
| fork 版本修改了通配符匹配逻辑 | Logto 的安全假设可能不成立 |
| oidc-provider 对路径通配和主机名通配使用不同规则 | 我们的统一描述可能不准确 |

**验证建议**：
- 编写集成测试，使用不同的通配符 redirect URI 模式调用 `/authorize` 端点，验证 oidc-provider 的实际匹配行为
- 或直接查阅 fork 版本的 `client.js` 源码

---

### 2.2 推断 2：oidc-provider 不缓存 Client 元数据

**原结论**（事实 A5）：
> oidc-provider 每次需要 Client 元数据时，**不做本地缓存**

**证据状态**：❌ **错误描述，与上游源码不符**

**上游证据**（`panva/node-oidc-provider commit 890b7226`）：
- `client.js:531-568` 的 `Client.find()` 方法实现了**两级缓存**：
  - 静态客户端缓存在 `instance(provider).staticClients` Map 中
  - 动态客户端（来自 adapter）缓存在 `instance(provider).dynamicClients` Map 中，key 为属性 SHA-256 哈希

**Logto 代码中的事实**：
- ✅ Logto 的 `postgresAdapter.find()` 本身不做缓存（`adapter.ts:186-189`）
- ⚠️ 但我们**没有验证** oidc-provider 的 `Client.find()` 方法是否在 Logto fork 中做了缓存

**反例说明（错误描述的影响）**：

| 错误假设 | 实际影响 |
|---------|---------|
| "回调地址变更即时生效" | 实际上生效延迟取决于 oidc-provider 缓存的刷新时机。由于缓存 key 是属性哈希，当数据库中属性变化时，哈希变化，缓存会在**下一次 `Client.find()` 调用时**刷新，但不是"即时" |
| "可以高频率修改 redirectUris 不影响性能" | 每次 `Client.find()` 都查数据库，高频调用可能有性能影响 |

---

### 2.3 推断 3：oidc-provider 的 redirect_uri 校验是完整 URL 级别

**原结论**（推断 2）：
> redirect_uri 授权校验是完整 URL 级别（含路径）

**证据状态**：⚠️ **部分证据，需谨慎**

**现有证据**：
1. ✅ Logto 的 CORS 校验明确忽略路径（`utils.ts:230-252`）
2. ⚠️ 上游 `client.js` 的 `redirectUriAllowed()` 方法签名接收完整 URI，但**我们没有直接验证它对路径部分的匹配规则**

**反例说明（可能的理解偏差）**：

| 场景 | 可能的理解偏差 |
|------|-------------|
| redirect URI 注册为 `https://example.com/callback` | 我们假设 `https://example.com/callback?extra=param` 会被拒绝，但 oidc-provider 实际行为可能是允许查询参数差异（OIDC 规范允许授权请求在 redirect_uri 中添加查询参数） |
| redirect URI 注册为 `https://example.com/path/*` | 我们假设 `*` 只匹配单路径段，但 oidc-provider 可能允许跨多段 |

**验证建议**：
- 查阅 OIDC 规范中 redirect_uri 匹配的具体要求
- 或编写集成测试验证各种路径模式

---

### 2.4 推断 4：分阶段轮换过渡期 Current 继续签名所有 token

**原结论**（推断 7）：
> 过渡期 Current 密钥继续签名所有 token

**证据状态**：⚠️ **间接证据，需谨慎**

**现有证据**：
1. ✅ `oidcProviderPrivateKeyOrder` 将 Current 排首位（`packages/schemas/src/utils/oidc-private-key.ts:29-33`）
2. ✅ 所有状态密钥都导出到 JWKS（`env-set/oidc.ts:14-42`）

**薄弱点**：
- 我们**没有直接验证** oidc-provider 实际选择哪把密钥签名
- oidc-provider 可能有自己的密钥选择逻辑（如 kid 轮询、算法偏好等）

**反例说明**：

| 假设 oidc-provider 的行为 | 影响 |
|------------------------|------|
| 按 kid 字母序选择签名密钥 | Next 密钥 kid 可能排在 Current 前面，过渡期就开始用 Next 签名 |
| 随机选择可用密钥 | 过渡期可能混合使用 Current 和 Next 签名 |

---

### 2.5 推断 5：被覆盖的 Next 密钥从未用于签名

**原结论**（推断 5）：
> 被覆盖丢弃的旧 Next 密钥不影响 token 验证安全，因为它从未用于签名

**证据状态**：⚠️ **间接证据，依赖推断 4**

**依赖链**：
- 推断 5 成立 ⇨ 推断 4 成立（Current 是唯一签名密钥）

**如果推断 4 不成立（oidc-provider 可能用 Next 签名）**：
- 被覆盖的旧 Next 密钥可能在短时间内用于签名
- 这些 token 在旧 Next 被丢弃后无法验证
- 造成用户体验问题（token 突然失效）

---

## 三、关键调用链可视化

### 3.1 回调地址变更生效流程

```
PATCH /applications/:id
    ↓
[application.ts:337-458]
    ├─ 写入数据库（无 tenant.invalidateCache()）
    └─ 返回成功

下次 OIDC 请求到达
    ↓
oidc-provider Client.find(client_id)
    ↓
[adapter.ts:175-196] postgresAdapter.find()
    ├─ 检查 demo/account-center/device-demo 静态 ID
    └─ findApplicationById(id) 数据库查询
        ↓
    transpileClient(application)
        └─ getConstantClientMetadata() + 其他元数据
            ↓
    返回最新的 redirectUris / corsAllowedOrigins
```

**关键点**：生效延迟为**一次 Client.find() 调用**，不是"即时"。

---

### 3.2 CORS Origin 校验流程

```
浏览器发起跨域请求（带 Origin 头）
    ↓
oidc-provider CORS 中间件
    ↓
[init.ts:302-304] clientBasedCORS 回调
    ↓
[utils.ts:121-149] isOriginAllowed(origin, metadata, redirectUris)
    ├─ Step 1: corsAllowedOrigins.includes(origin)?
    │       ├─ YES → ✅ 允许
    │       └─ NO → 继续
    └─ Step 2: 遍历 redirectUris
            ├─ 非通配 URI: new URL(uri).origin === origin?
            │       ├─ YES → ✅ 允许
            │       └─ NO → 下一个
            └─ 通配 URI: matchesOriginAgainstRedirectUriPattern(origin, uri)
                    ├─ parseRedirectUriOriginPattern(pattern)
                    │       └─ 只提取 protocol/hostname/port，**丢弃路径**
                    ├─ 比较 protocol
                    ├─ 比较 port（含默认端口推断）
                    └─ matchHostnamePattern()
                            └─ 逐标签匹配，* → [^.]+
```

---

### 3.3 第三方应用 Token Exchange 三层防护

```
第一层：路由校验（写入时拦截）
    [application.ts:46-56] assertThirdPartyApplicationTokenExchangeDisabled()
        ↓ isThirdParty && allowTokenExchange === true → 422 拒绝
    保证：数据库中第三方应用的 allowTokenExchange 永远是 false

            ↓
第二层：Metadata 构建（运行时不注入）
    [adapter.ts:165] transpileClient()
        → [utils.ts:40] getConstantClientMetadata()
            → condArray(false && GrantType.TokenExchange) → []
    保证：grant_types 数组中不含 token-exchange

            ↓
第三层：Grant 执行（oidc-provider 前置校验）
    oidc-provider token 端点
        → client.grantTypeAllowed('urn:ietf:params:oauth:grant-type:token-exchange')
            → grant_types.includes(...) → false
    保证：即使绕过前两层，handler 也不会被调用
```

---

## 四、证据等级总结

| 证据等级 | 定义 | 结论数量 | 示例 |
|---------|------|---------|------|
| ✅ **直接事实** | Logto 源码中可直接定位到函数/语句 | 约 35 条 | `allowWildcardRedirectUris: true`、`isOriginAllowed` 实现 |
| ⚠️ **间接证据** | 由多个直接事实推导，但缺少关键环节的直接验证 | 约 5 条 | "Current 是唯一签名密钥"、"oidc-provider `*` 匹配规则" |
| ❌ **错误描述** | 与上游源码或行为不符 | 1 条 | "oidc-provider 不缓存 Client 元数据" |

**建议**：将所有 ⚠️ 间接证据的结论在文档中明确标记为"推断"，并说明验证方法。
