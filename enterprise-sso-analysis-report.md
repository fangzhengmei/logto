# 企业级单点登录（SSO）全流程分析报告

## 1. 概述

本报告对Logto系统中企业级单点登录从应用注册、元数据交换到运行时断言生成的全过程进行深入分析，重点关注配置存储、签名密钥取用以及与会话上下文的衔接面。

## 2. 应用注册流程

### 2.1 SSO连接器注册

**核心存储表：`sso_connectors`**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | varchar(128) | 连接器唯一标识 |
| `provider_name` | varchar(128) | SSO提供商类型（OIDC/SAML/AzureAD/GoogleWorkspace/Okta等） |
| `connector_name` | varchar(128) | 连接器显示名称 |
| `config` | jsonb | 连接器配置（不同提供商有不同schema） |
| `domains` | jsonb | SSO邮箱域名列表 |
| `branding` | jsonb | 品牌配置 |
| `sync_profile` | boolean | 是否在每次登录时同步用户资料 |
| `enable_token_storage` | boolean | 是否启用令牌存储（仅OIDC） |

**注册入口**：`packages/core/src/routes/sso-connector/index.ts`

注册流程：
1. 验证提供商是否受支持（`isSupportedSsoProvider`）
2. 域名规范化与验证（`validateConnectorDomains`）
3. 配置解析与验证（`parseConnectorConfig`）
4. 连接状态验证（`validateConnectorConfigConnectionStatus`）
5. 令牌存储权限检查（仅OIDC支持，需配置`SECRET_VAULT_KEK`）
6. 数据库插入

### 2.2 SAML应用注册

**核心存储表：**
- `saml_application_configs` - SAML应用配置
- `saml_application_secrets` - SAML应用密钥
- `applications` - 应用基础信息（类型为`SAML`）

**SAML应用配置字段：**
| 字段 | 类型 | 说明 |
|------|------|------|
| `attribute_mapping` | jsonb | SAML属性映射配置 |
| `entity_id` | varchar(128) | 服务提供者实体ID |
| `acs_url` | jsonb | 断言消费服务URL（含绑定类型） |
| `encryption` | jsonb | SAML断言加密配置 |
| `name_id_format` | varchar(128) | NameID格式 |

**SAML应用密钥字段：**
| 字段 | 类型 | 说明 |
|------|------|------|
| `private_key` | text | 私钥（PEM格式） |
| `certificate` | text | 证书（PEM格式） |
| `expires_at` | timestamptz | 过期时间 |
| `active` | boolean | 是否活跃 |

**密钥管理规则**：
- 每个应用只能有一个活跃密钥（通过唯一索引`sam_application_secrets__unique_active_secret`保证）
- 支持密钥轮换

**注册入口**：`packages/core/src/saml-application/SamlApplication/index.ts`

## 3. 元数据交换

### 3.1 SAML元数据交换

**SAML连接器配置支持三种方式**（`packages/core/src/sso/types/saml.ts`）：

1. **元数据URL方式**
   ```typescript
   { metadataUrl: string, attributeMapping?: AttributeMap }
   ```

2. **元数据XML方式**
   ```typescript
   { metadata: string, attributeMapping?: AttributeMap }
   ```

3. **手动配置方式**
   ```typescript
   { 
     entityId: string, 
     signInEndpoint: string, 
     x509Certificate: string,
     attributeMapping?: AttributeMap 
   }
   ```

**元数据解析流程**（`packages/core/src/sso/SamlConnector/index.ts`）：
1. 若提供`metadataUrl`，通过HTTP获取XML元数据
2. 若提供`metadata`，直接使用XML内容
3. 使用`XMLValidator`验证XML格式
4. 调用`samlify`库的`IdentityProvider`解析元数据
5. 提取`entityId`、`signInEndpoint`、`x509Certificate`等关键信息

**服务提供者（SP）元数据自动生成**：
- `entityId`：`urn:logto:${tenantId}:sso-connector:${connectorId}`
- `assertionConsumerServiceUrl`：`${endpoint}/authn/sso/saml/${connectorId}`

### 3.2 OIDC元数据交换

**OIDC配置字段**（`packages/core/src/sso/types/oidc.ts`）：
```typescript
{
  clientId: string,
  clientSecret: string,
  issuer: string,
  scope?: string,
  trustUnverifiedEmail?: boolean
}
```

**元数据发现**（`packages/core/src/sso/OidcConnector/utils.ts`）：
1. 通过`${issuer}/.well-known/openid-configuration`获取OIDC配置
2. 提取`authorization_endpoint`、`token_endpoint`、`userinfo_endpoint`、`jwks_uri`
3. 自动添加必需scope：`openid`、`profile`、`email`

## 4. 运行时断言生成

### 4.1 SAML断言生成（作为IdP角色）

**断言生成入口**：`packages/core/src/saml-application/SamlApplication/index.ts`中的`createSamlResponse`方法

**生成流程**：
1. 构建SAML身份提供者实例（`buildSamlIdentityProvider`）
2. 构建SAML服务提供者实例（`buildSamlServiceProvider`）
3. 调用`samlify`库的`createLoginResponse`生成响应
4. 使用自定义模板回调（`createSamlTemplateCallback`）填充断言内容

**断言模板关键参数**：
- `ID`：断言唯一标识
- `Issuer`：IdP实体ID
- `IssueInstant`：签发时间
- `ConditionsNotBefore` / `ConditionsNotOnOrAfter`：有效期（10分钟）
- `NameID`：根据`nameIdFormat`生成（Persistent/EmailAddress等）
- `Attributes`：根据`attributeMapping`从用户信息中提取
- `AuthnContextClassRef`：认证上下文（默认`passwordProtectedTransport`）
- `SessionIndex` / `SessionNotOnOrAfter`：会话信息

**属性映射处理**：
- 优先使用配置的`attributeMapping`
- 若无配置，使用默认属性：`sub`、`email`、`name`
- 支持嵌套对象和数组的JSON序列化

### 4.2 SAML断言验证（作为SP角色）

**验证入口**：`packages/core/src/routes/authn.ts`中的`/authn/sso/saml/:connectorId`端点

**验证流程**：
1. 从`RelayState`获取`jti`（会话标识）
2. 通过`jti`从OIDC Provider会话存储中获取连接器会话
3. 使用`samlify`库验证SAML响应签名
4. 解析断言内容（`handleSamlAssertion`）
5. 应用属性映射提取用户信息
6. 将用户信息存入会话存储供后续使用

### 4.3 OIDC令牌验证

**验证入口**：`packages/core/src/sso/OidcConnector/index.ts`中的`getUserInfo`方法

**验证流程**：
1. 使用授权码交换令牌（`fetchToken`）
2. 验证ID Token签名和声明（`getIdTokenClaims`）
3. 可选：从`userinfo_endpoint`获取用户信息
4. 根据`trustUnverifiedEmail`配置决定是否接受未验证邮箱

## 5. 配置存储机制

### 5.1 连接器配置存储

所有SSO连接器配置存储在`sso_connectors`表的`config`字段（jsonb类型）中，不同提供商有不同的schema验证：

- **OIDC**：`basicOidcConnectorConfigGuard`
- **SAML**：`samlConnectorConfigGuard`
- **特定提供商**：如AzureAD、Okta等有各自的扩展配置

### 5.2 密钥存储

**OIDC签名密钥**（`packages/schemas/src/utils/oidc-private-key.ts`）：
- 存储在`logto_config`表的`oidc.privateKeys`字段
- 支持三种状态：`Current`（当前使用）、`Next`（待轮换）、`Previous`（已过期）
- 规范化函数：`normalizeOidcPrivateKeys`
- 当前密钥获取：`getCurrentOidcPrivateKey`
- 支持立即轮换和分段轮换两种策略

**SAML应用密钥**：
- 存储在`saml_application_secrets`表
- 私钥和证书以PEM格式明文存储
- 支持密钥轮换（保留历史密钥）

**联邦令牌存储**（`packages/core/src/utils/secret-encryption.ts`）：
- 存储在`secrets`表
- 使用AES-256-GCM加密算法
- 采用双层加密架构：
  1. 数据加密密钥（DEK）：随机生成，用于加密实际数据
  2. 密钥加密密钥（KEK）：通过`SECRET_VAULT_KEK`环境变量配置，用于加密DEK
- 存储字段：`encrypted_dek`、`iv`、`auth_tag`、`ciphertext`

## 6. 签名密钥取用

### 6.1 SAML签名密钥

**作为IdP时**（`packages/core/src/saml-application/SamlApplication/index.ts`）：
```typescript
// 构建IdP实例时注入私钥
saml.IdentityProvider({
  entityID: entityId,
  signingCert: certificate,
  privateKey: privateKey,  // 从saml_application_secrets表获取active密钥
  // ...
})
```

**作为SP时**（`packages/core/src/sso/SamlConnector/index.ts`）：
- 使用IdP提供的`x509Certificate`验证签名
- 从元数据中提取或手动配置

### 6.2 OIDC签名密钥

**令牌签名**：
- 使用`getCurrentOidcPrivateKey`获取当前活跃密钥
- 由`oidc-provider`库自动处理签名过程

**令牌验证**：
- 通过`jwks_uri`端点发布公钥
- 客户端使用公钥验证JWT签名

### 6.3 HMAC签名

通用签名工具（`packages/core/src/utils/sign.ts`）：
```typescript
export const sign = (signingKey: string, payload: Record<string, unknown>) => {
  const hmac = createHmac('sha256', signingKey);
  const payloadString = JSON.stringify(payload);
  hmac.update(payloadString);
  return hmac.digest('hex');
};
```

## 7. 会话上下文衔接

### 7.1 SSO连接器会话

**会话数据结构**（`packages/core/src/sso/types/session.ts`）：
```typescript
type SingleSignOnConnectorSession = {
  state: string;              // 客户端生成的state
  redirectUri: string;        // 回调URI
  connectorId: string;        // 连接器ID
  nonce?: string;             // OIDC nonce（仅OIDC）
  userInfo?: ExtendedSocialUserInfo;  // SAML断言解析的用户信息（仅SAML）
};
```

**会话存储机制**：
- 存储在OIDC Provider的interaction会话中
- 通过`jti`（JSON Token ID）作为会话标识
- 存储/读取函数：
  - `assignSingleSignOnSessionResult` - 存储会话
  - `getSingleSignOnSessionResult` - 读取会话
  - `assignSamlAssertionResultViaJti` - 通过jti存储SAML断言结果
  - `getSingleSignOnSessionResultByJti` - 通过jti读取会话

### 7.2 交互流程衔接

**SP发起的SSO流程**（`packages/core/src/routes/interaction/utils/single-sign-on.ts`）：

1. **生成授权URL**（`getSsoAuthorizationUrl`）：
   - 从interaction详情获取`jti`
   - 创建连接器实例
   - 生成授权URL（SAML使用RelayState传递jti）
   - 存储连接器会话

2. **验证SSO身份**（`verifySsoIdentity`）：
   - 从会话存储读取连接器会话
   - 验证回调参数（state、code等）
   - 获取用户信息
   - 可选：加密存储联邦令牌

3. **处理认证结果**（`handleSsoAuthentication`）：
   - 查询用户SSO身份关联
   - 若存在：直接登录，可选同步资料
   - 若不存在但邮箱匹配：登录并关联SSO身份
   - 若不存在：抛出错误引导注册

### 7.3 IdP发起的SSO流程

**会话存储表**：`idp_initiated_saml_sso_sessions`

| 字段 | 类型 | 说明 |
|------|------|------|
| `connector_id` | varchar(128) | SSO连接器ID |
| `assertion_content` | jsonb | SAML断言内容 |
| `expires_at` | timestamptz | 过期时间 |

**流程**（`packages/core/src/libraries/sso-connector.ts`）：
1. 接收IdP发送的SAML断言
2. 验证并解析断言
3. 创建IdP发起的SSO会话记录
4. 生成带`direct_sign_in`参数的登录URL
5. 用户访问URL时，检查会话cookie并直接使用断言结果

### 7.4 SAML应用会话

**存储表**：`saml_application_sessions`

| 字段 | 类型 | 说明 |
|------|------|------|
| `saml_request_id` | varchar(128) | SAML请求ID |
| `oidc_state` | varchar(32) | OIDC状态 |
| `relay_state` | varchar(512) | RelayState |
| `raw_auth_request` | text | 原始认证请求 |
| `expires_at` | timestamptz | 过期时间 |

**衔接流程**：
1. 接收SAML认证请求，创建会话记录
2. 重定向到Logto登录页面
3. 用户登录后，根据会话记录生成SAML响应
4. 发送响应到SP的ACS URL

## 8. 关键技术要点总结

### 8.1 配置存储分层
1. **连接器配置**：`sso_connectors.config`（jsonb，schema验证）
2. **应用配置**：`saml_application_configs`（结构化表）
3. **密钥材料**：分层存储（OIDC在logto_config，SAML在专用表，联邦令牌加密存储）
4. **会话状态**：OIDC Provider会话 + 数据库持久化

### 8.2 安全设计
1. **联邦令牌加密**：双层AES-256-GCM加密，DEK/KEK分离
2. **密钥轮换**：OIDC支持Current/Next/Previous三状态，SAML支持多密钥历史
3. **签名验证**：SAML使用x509证书，OIDC使用JWKS
4. **会话安全**：HttpOnly Cookie，jti会话标识，state/nonce防CSRF

### 8.3 扩展性设计
1. **连接器工厂模式**：`ssoConnectorFactories`注册表，支持动态添加新提供商
2. **属性映射**：可配置的SAML/OIDC属性到Logto用户属性映射
3. **令牌存储**：可选的联邦令牌持久化，支持令牌刷新

### 8.4 流程完整性
1. **SP发起**：完整的OAuth2/OIDC授权码流程 + SAML Web SSO Profile
2. **IdP发起**：支持SAML IdP-Initiated SSO，通过会话cookie衔接
3. **用户关联**：支持自动关联（邮箱匹配）、手动关联、新用户注册

## 9. 结论

Logto的企业级SSO实现采用了分层架构设计，在配置存储、密钥管理和会话衔接方面表现出以下特点：

1. **配置存储**：灵活的jsonb存储与结构化表相结合，既保证了不同SSO协议的配置多样性，又通过schema验证确保了数据一致性。

2. **密钥管理**：针对不同场景采用不同的密钥管理策略，OIDC签名密钥支持优雅的轮换机制，联邦令牌采用行业标准的双层加密保护。

3. **会话衔接**：通过OIDC Provider的interaction会话作为核心载体，结合数据库持久化和Cookie机制，实现了SP发起和IdP发起两种SSO模式的无缝衔接。

4. **协议支持**：同时支持SAML 2.0和OIDC 1.0两大主流企业SSO协议，并且针对主流提供商（Azure AD、Google Workspace、Okta）提供了专门的连接器实现。

5. **扩展性**：工厂模式的连接器设计使得新增SSO提供商变得简单，属性映射机制则保证了不同IdP的用户属性能够正确映射到Logto系统。
