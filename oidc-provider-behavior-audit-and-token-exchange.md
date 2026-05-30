# oidc-provider 行为核查与第三方应用 Token Exchange 一致性证据

> 本文档基于 Logto 使用的 oidc-provider fork 版本（`github:logto-io/node-oidc-provider#5570006785b44e0f125ee4cb6bf540338721b1f3`），
> 对照上游源码（`panva/node-oidc-provider`，主分支 commit `890b7226`，对应 npm v9.x）和官方文档，
> 核查先前文档中将推断当作事实的描述，并补充第三方应用 token exchange 在三层防护中的一致性证据。

---

## 一、oidc-provider 行为核查：可直接证实 vs 推断

### 1.1 allowWildcardRedirectUris 的行为

#### 先前描述（事实 A4）

> oidc-provider 在授权流程中校验 `redirect_uri` 时支持通配符模式匹配。`*` 匹配任意非空路径段（不含 `/`），通配仅出现在 URI 的路径和主机名部分（已由 A3 保证）。

#### 核查结果

| 描述 | 分类 | 证据 |
|------|------|------|
| `allowWildcardRedirectUris: true` 启用了通配符支持 | ✅ **可直接证实** | Logto 源码 `init.ts:166` 显式设置 |
| oidc-provider 内置 `allowWildcardRedirectUris` 配置项 | ✅ **可直接证实** | Logto 类型声明 `packages/core/src/include.d/oidc-provider/index.d.ts:7` 声明了 `allowWildcardRedirectUris?: boolean` |
| `*` 匹配任意非空路径段（不含 `/`） | ⚠️ **推断** | 此行为来自上游 `client_schema.js` 的 `redirectUris()` 验证方法和 `client.js` 的 `redirectUriAllowed()` 方法。上游源码中 `redirectUriAllowed` 使用 `String.prototype.match` 做通配匹配，将 `*` 转为正则 `.+`。但 Logto 使用的是自己的 fork，**未直接验证 fork 中此逻辑是否完全一致** |
| 通配仅出现在 URI 的路径和主机名部分 | ⚠️ **推断** | 这是基于 Logto 注册时校验（A3）保证的推论，而非 oidc-provider 自身的运行时限制。oidc-provider 的 `redirectUriAllowed()` 方法在 `allowWildcardRedirectUris: true` 时不限制 `*` 出现的位置，**依赖注册时校验来约束** |

#### 修正

将事实 A4 中的「`*` 匹配任意非空路径段」和「通配仅出现在 URI 的路径和主机名部分」从「事实」降级为「推断」，因为：
1. 这些行为描述的是上游 oidc-provider 内部实现细节，Logto 代码中没有直接对应的实现或测试
2. Logto 使用的是 fork 版本，上游 `890b7226` 的行为可能不完全等同于 fork 中的行为

---

### 1.2 Client.find 的缓存行为

#### 先前描述（事实 A5）

> oidc-provider 每次需要 Client 元数据时，通过 `postgresAdapter.find()` 从数据库实时读取，**不做本地缓存**。

#### 核查结果

| 描述 | 分类 | 证据 |
|------|------|------|
| Logto 的 `postgresAdapter.find()` 每次调用 `findApplicationById(id)` 从数据库读取 | ✅ **可直接证实** | `adapter.ts:186-196` 源码明确 |
| oidc-provider **不会**缓存 Client 元数据 | ⚠️ **推断，存在错误** | 上游源码 `client.js:531-568`（`Client.find()`）实现了**两级缓存**：静态客户端缓存在 `instance(provider).staticClients` Map 中；动态客户端（来自 adapter）缓存在 `instance(provider).dynamicClients` Map 中，以属性 SHA-256 哈希为 key。当属性不变时命中缓存 |

#### 修正

事实 A5 的「**不做本地缓存**」是**错误描述**。正确事实是：

1. **Logto 的 `postgresAdapter.find()` 本身不做缓存**——每次调用都执行数据库查询。
2. **但 oidc-provider 的 `Client.find()` 方法会对 adapter 返回值做缓存**——上游 `client.js:531-568` 实现了基于属性哈希的动态客户端缓存。
3. 因此，第三方应用（动态客户端）的元数据更新后，oidc-provider 可能返回缓存中的旧数据，直到缓存失效。

**这意味着推断 1（回调地址变更即时生效）需要修正**：回调地址变更后，oidc-provider 的 `Client.find()` 缓存可能导致短期内仍使用旧数据，直到属性哈希变化触发缓存刷新。但由于 Logto 每次查询都返回最新数据（adapter 不缓存），属性哈希会随数据库更新而变化，因此缓存会在**下一次 `Client.find()` 调用时**被刷新。

---

### 1.3 grantTypeAllowed 的行为

#### 先前描述（推断 4 注释）

> `getConstantClientMetadata` 注释：oidc-provider will enforce `client.grantTypeAllowed(type)` before invoking any grant handler, so there's no need for additional runtime access checks in individual grant handlers.

#### 核查结果

| 描述 | 分类 | 证据 |
|------|------|------|
| `client.grantTypeAllowed(type)` 在 grant handler 执行前被调用 | ✅ **可直接证实** | 上游 `client.js:434-436`：`grantTypeAllowed(type) { return this.grant_types.includes(type); }`。上游 `token.js` 在路由处理中调用此方法做前置校验 |
| grant handler 内部不需要再次检查 grant type | ✅ **可直接证实** | Logto 源码 `utils.ts:30-32` 注释明确声明，且 token exchange grant handler 实现中未做额外 grant type 检查 |

---

### 1.4 redirect_uri 校验的粒度

#### 先前描述（推断 2）

> redirect_uri 授权校验是完整 URL 级别（含路径），路径参与校验。

#### 核查结果

| 描述 | 分类 | 证据 |
|------|------|------|
| oidc-provider 的 `redirectUriAllowed()` 对完整 URL 做匹配 | ✅ **可直接证实** | 上游 `client.js` 的 `redirectUriAllowed(uri)` 方法比较完整的 redirect_uri 字符串，包括路径、查询参数等 |
| CORS 校验不涉及路径 | ✅ **可直接证实** | Logto 源码 `utils.ts:230-253` 中 `matchesOriginAgainstRedirectUriPattern` 只比较协议、端口、主机名 |

---

### 1.5 clientBasedCORS 回调的调用时机

#### 先前描述（事实 A7）

> `clientBasedCORS` 注册为 oidc-provider 配置回调

#### 核查结果

| 描述 | 分类 | 证据 |
|------|------|------|
| `clientBasedCORS` 在 CORS 预检请求时被调用 | ✅ **可直接证实** | 上游 `initialize_app.js:22-47`：当 `features.cors.clientBased = true` 时，CORS 中间件调用 `clientBasedCORS(ctx, origin, client)` |
| `origin` 参数仅含协议+主机+端口 | ✅ **可直接证实** | 这是浏览器 CORS 规范定义的，origin 由浏览器自动提供 |

---

## 二、第三方应用 Token Exchange 一致性证据

第三方应用被禁止使用 token exchange，这一约束通过三层防护一致实现：

### 2.1 第一层：路由校验 — 写入时拦截

**源码位置**：`packages/core/src/routes/applications/application.ts:46-56`

```ts
const assertThirdPartyApplicationTokenExchangeDisabled = (
  isThirdParty: boolean,
  allowTokenExchange?: boolean
) => {
  if (isThirdParty && allowTokenExchange === true) {
    throw new RequestError({
      code: 'application.third_party_application_cannot_enable_token_exchange',
      status: 422,
    });
  }
};
```

此函数在两个位置被调用：
1. **创建应用**（`application.ts:249-252`）：`POST /applications` 时校验。
2. **更新应用**（`application.ts:365-367`）：`PATCH /applications/:id` 时校验。

**效果**：第三方应用无法在管理 API 层面将 `allowTokenExchange` 设为 `true`，从源头阻断配置写入。

### 2.2 第二层：Metadata 构建 — 运行时不注入 grant_type

**源码位置**：`packages/core/src/oidc/utils.ts:33-40`

```ts
export const getConstantClientMetadata = (
  envSet: EnvSet,
  type: ApplicationType,
  options?: Pick<CustomClientMetadata, 'allowTokenExchange' | 'isDeviceFlow'>
): AllClientMetadata => {
  const optionalGrantTypes = condArray(options?.allowTokenExchange && GrantType.TokenExchange);
  // ...
};
```

**源码位置**：`packages/core/src/oidc/adapter.ts:151-171`

```ts
const transpileClient = (
  { id: client_id, secret: client_secret, name: client_name,
    type, oidcClientMetadata, customClientMetadata }: CreateApplication,
  clientScopes?: string[]
): AllClientMetadata => ({
  client_id,
  client_secret,
  client_name,
  ...getConstantClientMetadata(envSet, type, customClientMetadata),
  ...transpileMetadata(client_id, snakecaseKeys(oidcClientMetadata)),
  ...customClientMetadata,
  ...conditional(clientScopes && { scope: clientScopes.join(' ') }),
});
```

**效果**：当 `customClientMetadata.allowTokenExchange` 为 `false`（第三方应用的默认值且无法改为 `true`）时，`condArray()` 返回空数组，`grant_types` 中不包含 `urn:ietf:params:oauth:grant-type:token-exchange`。

**测试证据**（`utils.test.ts:71-75`）：

```ts
it('should not include TokenExchange grant type when allowTokenExchange is false', () => {
  expect(
    getConstantClientMetadata(mockEnvSet, ApplicationType.SPA, { allowTokenExchange: false })
  ).not.toContain(GrantType.TokenExchange);
});
```

### 2.3 第三层：Grant 执行 — oidc-provider grantTypeAllowed 拦截

**源码位置**：`packages/core/src/oidc/grants/index.ts:37-41`

```ts
oidc.registerGrantType(
  GrantType.TokenExchange,
  tokenExchange.buildHandler(envSet, queries),
  ...getParameterConfig(tokenExchange.parameters)
);
```

**上游行为**（`client.js:434-436`）：

```ts
grantTypeAllowed(type) {
  return this.grant_types.includes(type);
}
```

**效果**：即使第三方应用直接调用 `/oidc/token` 端点并传入 `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`，oidc-provider 会在执行 grant handler 前调用 `client.grantTypeAllowed(type)`，由于第三方应用的 `grant_types` 不包含此值，请求被拒绝。

### 2.4 三层一致性总结

| 防护层 | 位置 | 机制 | 效果 |
|--------|------|------|------|
| **路由校验** | `application.ts:46-56` | 写入时断言 `isThirdParty && allowTokenExchange === true` | 第三方应用无法将 `allowTokenExchange` 设为 `true` |
| **Metadata 构建** | `utils.ts:40` + `adapter.ts:165` | `condArray(options?.allowTokenExchange && GrantType.TokenExchange)` | `grant_types` 不包含 token exchange |
| **Grant 执行** | 上游 `client.js:434-436` | `client.grantTypeAllowed(type)` 前置校验 | 即使绕过前两层，grant handler 不会被调用 |

**Schema 注释证据**（`oidc-module.ts:84-90`）：

```ts
/**
 * Whether the application is allowed to initiate token exchange requests.
 *
 * Only first-party applications can use token exchange. Third-party applications are always
 * forbidden.
 *
 * Defaults to `false` for all new applications. Users must explicitly enable it.
 */
AllowTokenExchange = 'allowTokenExchange',
```

**数据库迁移证据**（`1.36.0-1767193412-allow-token-exchange.ts`）：
- 为现有第一方非 M2M 应用设置 `allowTokenExchange: true`（向后兼容）
- M2M 应用此前不支持 token exchange，迁移中不设置
- Admin Console 保持禁用

---

## 三、核查结论：先前文档中需修正的描述

### 3.1 事实 A4 修正

**原描述**（标记为事实）：
> `*` 匹配任意非空路径段（不含 `/`），通配仅出现在 URI 的路径和主机名部分（已由 A3 保证）。

**修正为推断**：
> 上游 oidc-provider 在 `allowWildcardRedirectUris: true` 时，`redirectUriAllowed()` 方法将 `*` 视为通配符进行模式匹配。根据上游源码（`client.js`），`*` 被转换为正则表达式进行匹配。通配仅出现在路径和主机名部分这一约束，**不是由 oidc-provider 运行时保证的，而是由 Logto 注册时校验（A3）保证的**——如果注册校验被绕过，oidc-provider 不会限制 `*` 出现的位置。

**依据**：
- 上游 `client.js` 的 `redirectUriAllowed()` 方法（`client_schema.js:579-630`）在 `allowWildcardRedirectUris: true` 时使用 `String.prototype.match` 做通配匹配，不限制 `*` 位置
- 上游 `client_schema.js:579-630` 的 `redirectUris()` 验证方法在 schema 层面对通配符做约束，但这是注册时校验

### 3.2 事实 A5 修正

**原描述**（标记为事实）：
> oidc-provider 每次需要 Client 元数据时，通过 `postgresAdapter.find()` 从数据库实时读取，**不做本地缓存**。

**修正**：
> Logto 的 `postgresAdapter.find()` 每次调用都执行 `findApplicationById(id)` 数据库查询，adapter 层不做缓存。**但上游 oidc-provider 的 `Client.find()` 方法对动态客户端实现了基于属性哈希的缓存**（`client.js:531-568`），缓存 key 为属性 SHA-256 哈希。当 adapter 返回的属性发生变化时，哈希变化触发缓存刷新。

### 3.3 推断 1 修正

**原推断**：
> 回调地址变更后即时生效

**修正为**：
> 回调地址变更后，**在下次 `Client.find()` 调用时生效**。由于 adapter 返回的属性哈希随数据库更新而变化，oidc-provider 的动态客户端缓存会在属性变化时自动刷新，因此实际生效延迟为一次 `Client.find()` 调用。

---

## 四、oidc-provider 版本与源码参照

| 信息 | 值 |
|------|---|
| Logto 使用的 fork | `github:logto-io/node-oidc-provider#5570006785b44e0f125ee4cb6bf540338721b1f3` |
| 上游参照版本 | `panva/node-oidc-provider` 主分支 commit `890b7226`（约 npm v9.x） |
| 关键上游文件 | `lib/models/client.js`（Client 类、grantTypeAllowed、redirectUriAllowed、find） |
| 关键上游文件 | `lib/helpers/client_schema.js`（Client Schema 验证、redirectUris 验证） |
| 关键上游文件 | `lib/helpers/initialize_app.js`（CORS 中间件注册、clientBasedCORS 调用） |
| 关键上游文件 | `lib/actions/token.js`（token 端点路由、grantTypeAllowed 前置校验） |
| 关键上游文件 | `lib/consts/client_attributes.js`（RECOGNIZED_METADATA、DEFAULTS 常量） |

---

## 五、关键文件索引（补充）

| 文件 | 本章事实编号 | 职责 |
|------|------------|------|
| `packages/core/src/oidc/utils.ts:33-40` | 2.2 | `getConstantClientMetadata` — 根据 `allowTokenExchange` 条件注入 grant_type |
| `packages/core/src/oidc/adapter.ts:151-171` | 2.2 | `transpileClient` — 将应用数据转为 oidc-provider Client 元数据 |
| `packages/core/src/oidc/grants/index.ts:37-41` | 2.3 | Token Exchange grant 注册 |
| `packages/core/src/routes/applications/application.ts:46-56` | 2.1 | 第三方应用 token exchange 写入拦截 |
| `packages/schemas/src/foundations/jsonb-types/oidc-module.ts:84-91` | 2.4 | `allowTokenExchange` 字段定义与注释 |
| `packages/schemas/src/types/oidc-config.ts:15` | 2.3 | `GrantType.TokenExchange = 'urn:ietf:params:oauth:grant-type:token-exchange'` |
| `packages/core/src/oidc/utils.test.ts:55-75` | 2.2 | Token Exchange grant_type 条件注入测试 |
