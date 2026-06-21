# Connector 配置、敏感信息处理与读取流程

## 概述

Logto 的连接器（Connector）系统涉及两套不同职责的敏感信息处理机制，两者职责边界容易混淆：

1. **Connector Helper（连接器配置管理）**：负责连接器本身的配置（如 `clientId`、`clientSecret`、SMTP 账号等）的存储、验证与读取
2. **凭据加密系统（Secret Vault）**：负责用户通过社交/SSO 连接器登录后获取的第三方 Token（`access_token`、`refresh_token`、`id_token`）的加密存储与读取

---

## 一、Connector Helper 职责边界

### 1.1 核心模块

| 模块 | 文件路径 | 职责 |
|------|---------|------|
| Connector Library | [connector.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/libraries/connector.ts) | 连接器实例加载、配置获取、连接器类型分发 |
| Connector Queries | [connector.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/queries/connector.ts) | 连接器数据的数据库 CRUD 操作 |
| Connector Routes | [index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/routes/connector/index.ts) | Management API 连接器 RESTful 接口 |
| Connector Utils (CLI) | [utils.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/cli/src/connector/utils.ts) | 连接器工厂加载、原始连接器构建、元数据解析 |
| Connector Utils (Core) | [index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/utils/connectors/index.ts) | 连接器格式转换、工厂加载、配置脱敏 |

### 1.2 数据存储：`connectors` 表

表定义：[connectors.sql](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/schemas/tables/connectors.sql)

```sql
create table connectors (
  tenant_id varchar(21) not null references tenants,
  id varchar(128) not null,
  sync_profile boolean not null default FALSE,
  enable_token_storage boolean not null default FALSE,  -- 是否启用 Token 存储
  connector_id varchar(128) not null,                   -- 连接器工厂 ID（如 google、github）
  config jsonb not null default '{}'::jsonb,            -- 连接器配置（包含敏感信息，明文存储）
  metadata jsonb not null default '{}'::jsonb,          -- 连接器元数据
  created_at timestamptz not null default(now()),
  primary key (id)
);
```

**关键设计点**：
- `config` 字段以 JSONB 明文存储，包含 `clientSecret`、API Key 等敏感凭据
- `enable_token_storage` 字段控制是否启用第三方 Token 存储（独立于 `config`）
- `findAllConnectorsWellKnown` 查询不返回 `config` 字段，用于无需敏感信息的场景

### 1.3 配置验证流程

连接器配置通过连接器工厂提供的 `configGuard`（Zod Schema）进行验证：

**定义**：[foundation.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/toolkit/connector-kit/src/types/foundation.ts)
```typescript
export type BaseConnector<Type extends ConnectorType> = {
  type: Type;
  metadata: ConnectorMetadata;
  configGuard: ZodType;  // 每个连接器自定义配置 Schema
};
```

**验证函数**：[index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/toolkit/connector-kit/src/index.ts#L19-L28)
```typescript
export function validateConfig<Output, Input = Output>(
  config: unknown,
  guard: ZodType<Output, ZodTypeDef, Input>
): asserts config is Output {
  const result = guard.safeParse(config);
  if (!result.success) {
    throw new ConnectorError(ConnectorErrorCodes.InvalidConfig, result.error);
  }
}
```

**表单级敏感字段标记**：[config-form.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/toolkit/connector-kit/src/types/config-form.ts#L24)
```typescript
export enum ConnectorConfigFormItemType {
  Text = 'Text',
  // ...
}

const baseConfigFormItem = {
  // ...
  isConfidential: z.boolean().optional(),  // 仅 Text 类型，标记为前端密码输入框
  // ...
};
```

> ⚠️ 注意：`isConfidential` 仅用于前端 UI 展示（密码框掩码），**不影响后端存储方式**，后端仍然明文存储在 `connectors.config` JSONB 中。

### 1.4 连接器加载与配置读取流程

```
API 请求 (GET /connectors/:id)
    ↓
[connectorRoutes] router.get('/connectors/:id')
    ↓
[tenant.connectors] getLogtoConnectorById(id)
    ↓
[tenant.connectors] getLogtoConnectors()
    ├─ 从 DB 加载：queries.connectors.findAllConnectors()
    │   └─ 返回完整 config（敏感信息未加密）
    ├─ 加载连接器工厂：loadConnectorFactories()
    │   └─ 从 packages/connectors/ 目录加载所有连接器包
    └─ 构建原始连接器：buildRawConnector(connectorFactory, getConnectorConfig)
        └─ 注入 getConfig 回调：async () => getConnectorConfig(id)
            └─ 从 DB 读取 connectors.config 并返回给连接器使用
    ↓
[transpileLogtoConnector] 转换为 API 响应格式
    ├─ Demo 连接器：config = {}（完全隐藏）
    └─ 普通连接器：config 原样返回（包含 clientSecret 等）
    ↓
API 响应
```

**核心代码**：
- `getConnectorConfig`：[connector.ts#L34-L41](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/libraries/connector.ts#L34-L41)
- `buildRawConnector`：[utils.ts#L96-L116](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/cli/src/connector/utils.ts#L96-L116)
- `transpileLogtoConnector`：[index.ts#L32-L58](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/utils/connectors/index.ts#L32-L58)

---

## 二、凭据加密系统（Secret Vault）职责边界

### 2.1 核心模块

#### 共用模块（社交连接器 + 企业 SSO 连接器共用）

| 模块 | 文件路径 | 职责 |
|------|---------|------|
| Secret Encryption | [secret-encryption.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/utils/secret-encryption.ts) | AES-256-GCM 加密/解密、Token 序列化（两种连接器完全共用） |
| Secret Queries | [secret.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/queries/secret.ts) | Secrets 主表及两张关联表的数据库 CRUD 操作 |
| Third-Party Tokens API | [third-party-tokens.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/routes/account/third-party-tokens.ts) | 用户获取第三方 Access Token 的统一接口（内部根据类型分发） |
| Provision Library | [provision-library.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/routes/experience/classes/libraries/provision-library.ts) | 新用户注册时，将暂存的 Token 写入 secrets 表（两种连接器都走这里） |

#### 社交连接器专属模块

| 模块 | 文件路径 | 职责 |
|------|---------|------|
| Social Library | [social.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/libraries/social.ts) | 社交连接器 Token 存储、读取与刷新 |
| Social Verification | [social-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/routes/experience/classes/verifications/social-verification.ts) | 社交登录验证流程中的 Token 暂存 |

#### 企业 SSO 连接器专属模块

| 模块 | 文件路径 | 职责 |
|------|---------|------|
| SSO Connector Library | [sso-connector.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/libraries/sso-connector.ts) | 企业 SSO 连接器 Token 存储与刷新 |
| Enterprise SSO Verification | [enterprise-sso-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/routes/experience/classes/verifications/enterprise-sso-verification.ts) | 企业 SSO 登录验证流程中的 Token 暂存 |
| SSO Verification Helper | [single-sign-on.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/libraries/verification-helpers/single-sign-on.ts) | SSO 身份验证、Token 获取与加密 |
| Admin User Enterprise SSO API | [enterprise-sso.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/routes/admin-user/enterprise-sso.ts) | 管理员查询用户 SSO 身份及脱敏 Token 信息 |

### 2.2 数据存储：`secrets` 表及关联表

主表定义：[secrets.sql](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/schemas/tables/secrets.sql)

```sql
create table secrets (
  tenant_id varchar(21) not null references tenants,
  id varchar(21) not null primary key,
  user_id varchar(21) not null references users,
  type varchar(256) not null,                          -- SecretType.FederatedTokenSet
  encrypted_dek bytea not null,                        -- 加密后的数据密钥
  iv bytea not null,                                   -- AES-GCM 初始化向量
  auth_tag bytea not null,                             -- AES-GCM 认证标签
  ciphertext bytea not null,                           -- 加密后的 Token 数据
  metadata jsonb not null default '{}'::jsonb,         -- Token 元数据（过期时间、scope 等，明文）
  created_at timestamptz not null default(now()),
  updated_at timestamptz not null default(now())
);
```

#### 连接器配置表

社交连接器和企业 SSO 连接器使用**两张独立的配置表**，但都有 `enable_token_storage` 开关字段：

**社交连接器配置表**：`connectors`（详见 1.2 节）
- 敏感配置 `config` 字段明文存储在 JSONB 中

**企业 SSO 连接器配置表**：[sso_connectors.sql](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/schemas/tables/sso_connectors.sql)
```sql
create table sso_connectors (
  tenant_id varchar(21) not null references tenants,
  id varchar(128) not null primary key,
  provider_name varchar(128) not null,                 -- OIDC / SAML / AzureAD / Okta 等
  connector_name varchar(128) not null,
  config jsonb not null default '{}'::jsonb,            -- 连接器配置（明文存储）
  domains jsonb not null default '[]'::jsonb,           -- SSO 邮箱域名
  branding jsonb not null default '{}'::jsonb,          -- SSO 品牌配置
  sync_profile boolean not null default FALSE,
  enable_token_storage boolean not null default FALSE,  -- 是否启用 Token 存储（仅 OIDC 类型有效）
  created_at timestamptz not null default(now())
);
```

#### 关联表（两张关联表共用 `secrets` 主表）

**关联表 1**：`secret_social_connector_relations`（社交连接器关联）
- `secret_id` → 关联 `secrets.id`
- `connector_id` → 关联 `connectors.id`（社交连接器实例 ID）
- `target` → 社交连接器目标标识（如 `github`、`google`）
- `identity_id` → 第三方用户 ID

**关联表 2**：[secret_enterprise_sso_connector_relations.sql](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/schemas/tables/secret_enterprise_sso_connector_relations.sql)（企业 SSO 连接器关联）
```sql
create table secret_enterprise_sso_connector_relations (
  tenant_id varchar(21) not null references tenants,
  secret_id varchar(21) not null references secrets (id),
  sso_connector_id varchar(128) not null references sso_connectors (id),
  issuer varchar(256) not null,                         -- IdP Issuer
  identity_id varchar(128) not null,                    -- 第三方用户 ID
  primary key (tenant_id, secret_id),
  -- 级联删除触发器：删除 SSO 连接器时自动删除关联的 secrets
  -- 级联删除触发器：删除用户 SSO 身份时自动删除关联的 secrets
);
```

> 🔑 **关键共用点**：社交连接器和企业 SSO 连接器共享同一张 `secrets` 主表（相同的加密字段结构），区别仅在于关联表不同。

### 2.3 加密算法：信封加密（Envelope Encryption）

实现：[secret-encryption.ts#L23-L82](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/utils/secret-encryption.ts#L23-L82)

采用 **AES-256-GCM** + 信封加密方案：

```
加密流程：
┌──────────────────────────────────────────────────────┐
│ 1. 从环境变量读取 KEK (Key Encryption Key)            │
│    SECRET_VAULT_KEK (Base64 编码，32 字节)            │
└──────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────┐
│ 2. 生成随机 DEK (Data Encryption Key，32 字节)        │
└──────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────┐
│ 3. 用 DEK 加密 Token 明文 (AES-256-GCM)               │
│    - 生成随机 IV (12 字节)                             │
│    - 输出：ciphertext + authTag (16 字节)              │
└──────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────┐
│ 4. 用 KEK 加密 DEK (AES-256-GCM)                      │
│    - 生成随机 ivDek (12 字节)                          │
│    - 输出：encryptedDek = ivDek + ciphertext + authTag│
└──────────────────────────────────────────────────────┘
                        ↓
         存储到数据库：{ iv, authTag, ciphertext, encryptedDek, metadata }
```

```
解密流程：
┌──────────────────────────────────────────────────────┐
│ 1. 拆分 encryptedDek                                  │
│    - 前 12 字节：ivDek                                 │
│    - 后 16 字节：dekAuthTag                            │
│    - 中间部分：encryptedDekPayload                     │
└──────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────┐
│ 2. 用 KEK + ivDek + dekAuthTag 解密得到 DEK            │
└──────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────┐
│ 3. 用 DEK + iv + authTag 解密 ciphertext 得到 Token   │
└──────────────────────────────────────────────────────┘
```

**Token 结构定义**：[secrets.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/schemas/src/types/secrets.ts)

```typescript
export const tokenSetGuard = z.object({
  id_token: z.string().optional(),
  access_token: z.string(),
  refresh_token: z.string().optional(),
});

export const tokenSetMetadataGuard = z.object({
  scope: z.string().optional(),
  expiresAt: z.number().optional(),
  tokenType: z.string().optional(),
  hasRefreshToken: z.boolean(),
});
```

### 2.4 Token 存储与读取完整流程

#### 流程一：用户社交登录时存储 Token

```
用户完成社交登录回调
    ↓
[SocialVerification.verify()] 验证社交身份
    ↓
[socials.getUserInfoWithOptionalTokenResponse()]
    ├─ 检查条件：enableTokenStorage && isTokenStorageSupported && getTokenResponseAndUserInfo
    ├─ 调用连接器 getTokenResponseAndUserInfo() 获取 userInfo + tokenResponse
    └─ 加密 Token：encryptAndSerializeTokenResponse(tokenResponse)
        └─ 输出：{ encryptedTokenSetBase64, metadata }
    ↓
Token 暂存到 SocialVerification 实例的 encryptedTokenSet 字段
    ↓
（后续用户提交交互时）
    ↓
用户主动请求存储 Token：PUT /api/account/identities/:target/access-token
    ↓
[thirdPartyTokensRoutes]
    ├─ 从 SocialVerificationRecord 读取 tokenSecret
    └─ [socials.upsertSocialTokenSetSecret()] 写入数据库
        ├─ deserializeEncryptedSecret(encryptedTokenSetBase64)
        │   └─ 反序列化得到 { iv, authTag, ciphertext, encryptedDek }
        └─ queries.secrets.upsertSocialTokenSetSecret()
            ├─ 事务：删除同 user + target 的旧 secret
            │   SQL: DELETE FROM secrets USING secret_social_connector_relations
            │        WHERE secrets.id = secretId
            │          AND secrets.user_id = userId
            │          AND secret_social_connector_relations.target = :target
            ├─ 插入 secrets 表（type = 'FederatedTokenSet'）
            └─ 插入 secret_social_connector_relations 表
```

**核心代码**：
- `getUserInfoWithOptionalTokenResponse`：[social.ts#L95-L152](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/libraries/social.ts#L95-L152)
- `upsertSocialTokenSetSecret`（业务层）：[social.ts#L183-L204](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/libraries/social.ts#L183-L204)
- `upsertSocialTokenSetSecret`（数据库层，含删除逻辑）：[secret.ts#L40-L73](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/queries/secret.ts#L40-L73)
- `encryptAndSerializeTokenResponse`：[secret-encryption.ts#L179-L192](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/utils/secret-encryption.ts#L179-L192)

#### 流程二：用户读取第三方 Access Token

```
用户请求：GET /api/account/identities/:target/access-token
    ↓
[thirdPartyTokensRoutes]
    ↓
queries.secrets.findSocialTokenSetSecretByUserIdAndTarget(userId, target)
    └─ JOIN secrets + secret_social_connector_relations
       WHERE secrets.user_id = userId
         AND secrets.type = 'FederatedTokenSet'
         AND target = :target
    ↓
[getAccessToken()] 共用函数（通过类型守卫区分社交/SSO）
    ├─ isSocialTokenSetSecret() 检查（判断是否包含 target 和 connectorId 字段）
    ├─ decryptTokens({ iv, encryptedDek, ciphertext, authTag })
    │   └─ 使用 KEK 解密得到明文 TokenSet
    ├─ 检查 access_token 是否过期（metadata.expiresAt）
    │   ├─ 未过期：直接返回
    │   └─ 已过期：
    │       ├─ 有 refresh_token → 调用 socials.refreshTokenSetSecret()（社交）
    │       │   ├─ 连接器 getAccessTokenByRefreshToken() 刷新 Token
    │       │   ├─ encryptTokenResponse() 重新加密
    │       │   └─ secrets.updateById() 更新数据库
    │       └─ 无 refresh_token → 删除 secret，返回 401
    └─ 返回格式化的 Access Token 响应
```

**核心代码**：
- `getAccessToken`（共用函数）：[third-party-tokens.ts#L47-L88](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/routes/account/third-party-tokens.ts#L47-L88)
- `isSocialTokenSetSecret`（类型守卫，社交/SSO 分发）：[third-party-tokens.ts#L25-L28](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/routes/account/third-party-tokens.ts#L25-L28)
- `findSocialTokenSetSecretByUserIdAndTarget`：[secret.ts#L78-L91](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/queries/secret.ts#L78-L91)
- `decryptTokens`：[secret-encryption.ts#L89-L92](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/utils/secret-encryption.ts#L89-L92)
- `refreshTokenSetSecret`（社交版）：[social.ts#L213-L271](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/libraries/social.ts#L213-L271)

#### 流程三：用户企业 SSO 登录时存储 Token

> 与社交连接器相比，企业 SSO 的 Token 加密、序列化、反序列化逻辑**完全共用**，区别在于：
> - 仅 OIDC 类型的企业 SSO 连接器支持 Token 存储（SAML 不支持）
> - Token 存储在用户**注册/登录流程中自动完成**，无需用户额外主动请求
> - 关联表使用 `secret_enterprise_sso_connector_relations`

```
用户完成企业 SSO 登录回调
    ↓
[EnterpriseSsoVerification.verify()] 验证 SSO 身份
    ↓
[verifySsoIdentity()] 内部处理：
    ├─ 检查 connectorInstance instanceof OidcConnector（SAML 跳过）
    ├─ 检查 connectorData.enable_token_storage
    ├─ 调用 OidcConnector.getUserInfo() 获取 userInfo + tokenResponse
    ├─ 检查 tokenResponse.access_token 存在
    └─ 加密 Token：encryptAndSerializeTokenResponse(tokenResponse)
        └─ 输出：{ encryptedTokenSetBase64, metadata }（与社交连接器共用加密逻辑）
    ↓
Token 暂存到 EnterpriseSsoVerification.encryptedTokenSet 字段
    ↓
（用户提交交互，创建新用户或登录现有用户时）
    ↓
[ProvisionLibrary.createUser()] 或交互提交时：
    ├─ 读取 enterpriseSsoConnectorTokenSetSecret
    └─ [ssoConnectors.upsertEnterpriseSsoTokenSetSecret()] 写入数据库
        ├─ deserializeEncryptedSecret(encryptedTokenSetBase64)
        │   └─ 反序列化得到 { iv, authTag, ciphertext, encryptedDek }（共用）
        └─ queries.secrets.upsertEnterpriseSsoTokenSetSecret()
            ├─ 事务：删除同 user + issuer 的旧 secret（⚠️ 只按 userId + issuer 删除，不区分 ssoConnectorId）
            │   SQL: DELETE FROM secrets USING secret_enterprise_sso_connector_relations
            │        WHERE secrets.id = secretId
            │          AND secrets.user_id = userId
            │          AND secret_enterprise_sso_connector_relations.issuer = :issuer
            ├─ 插入 secrets 表（共用主表，type = 'FederatedTokenSet'）
            └─ 插入 secret_enterprise_sso_connector_relations 表（企业 SSO 专属关联表）
```

**核心代码**：
- `verifySsoIdentity`：[single-sign-on.ts#L157-L221](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/libraries/verification-helpers/single-sign-on.ts#L157-L221)
- `upsertEnterpriseSsoTokenSetSecret`：[sso-connector.ts#L229-L256](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/libraries/sso-connector.ts#L229-L256)
- `ProvisionLibrary.createUser`：[provision-library.ts#L58-L136](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/routes/experience/classes/libraries/provision-library.ts#L58-L136)
- `getTokenSetSecret`：[enterprise-sso-verification.ts#L222-L236](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/routes/experience/classes/verifications/enterprise-sso-verification.ts#L222-L236)

#### 流程四：管理员/用户读取企业 SSO Access Token

> 与社交连接器共用 `decryptTokens`、`encryptTokenResponse` 及刷新策略，差异在于查询入口和关联表。

```
管理员请求：GET /api/users/:userId/sso-identities/:ssoConnectorId?includeTokenSecret=true
    或
用户请求：GET /api/account/sso-identities/:connectorId/access-token
    ↓
[enterprise-sso.ts / third-party-tokens.ts]
    ↓
queries.secrets.findEnterpriseSsoTokenSetSecretByUserIdAndConnectorId(userId, connectorId)
    └─ JOIN secrets + secret_enterprise_sso_connector_relations
       WHERE secrets.user_id = userId
         AND secrets.type = 'FederatedTokenSet'
         AND sso_connector_id = :connectorId
    ↓
[getAccessToken()] 共用函数（通过类型守卫区分社交/SSO）
    ├─ isSocialTokenSetSecret() 检查（SSO 类型包含 ssoConnectorId、issuer 字段）
    ├─ decryptTokens({ iv, encryptedDek, ciphertext, authTag })
    │   └─ 共用解密逻辑：使用 KEK 解密得到明文 TokenSet
    ├─ 检查 access_token 是否过期（metadata.expiresAt）
    │   ├─ 未过期：直接返回
    │   └─ 已过期：
    │       ├─ 有 refresh_token → 调用 ssoConnectors.refreshTokenSetSecret()（企业 SSO 版）
    │       │   ├─ 校验 OidcConnector && enableTokenStorage
    │       │   ├─ OidcConnector.getTokenByRefreshToken() 刷新 Token
    │       │   ├─ encryptTokenResponse() 重新加密（共用）
    │       │   ├─ 保留原 refresh_token（若新响应未返回）
    │       │   └─ secrets.updateById() 更新数据库
    │       └─ 无 refresh_token → 删除 secret，返回 401
    └─ 返回格式化的 Access Token 响应（或 desensitizeTokenSetSecret 脱敏后返回）
```

**核心代码**：
- `getAccessToken`（共用函数）：[third-party-tokens.ts#L47-L88](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/routes/account/third-party-tokens.ts#L47-L88)
- `isSocialTokenSetSecret`（类型守卫，社交/SSO 分发）：[third-party-tokens.ts#L25-L28](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/routes/account/third-party-tokens.ts#L25-L28)
- `findEnterpriseSsoTokenSetSecretByUserIdAndConnectorId`：[secret.ts#L129-L145](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/queries/secret.ts#L129-L145)
- `upsertEnterpriseSsoTokenSetSecret`（upsert 删除逻辑）：[secret.ts#L93-L124](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/queries/secret.ts#L93-L124)
- `refreshTokenSetSecret`（企业 SSO 版）：[sso-connector.ts#L265-L314](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/libraries/sso-connector.ts#L265-L314)
- `desensitizeTokenSetSecret`：管理员端脱敏返回，隐藏 refresh_token 和 ciphertext
- Admin User SSO Identities API：[enterprise-sso.ts#L29-L162](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/routes/admin-user/enterprise-sso.ts#L29-L162)
- User SSO Identities API：[third-party-tokens.ts#L133-L163](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/routes/account/third-party-tokens.ts#L133-L163)

#### 社交连接器 vs 企业 SSO 连接器：共用 vs 差异汇总

| 模块/逻辑 | 社交连接器 | 企业 SSO 连接器 | 是否共用 |
|----------|-----------|-----------------|---------|
| `secrets` 主表 | ✅ 使用 | ✅ 使用 | **完全共用** |
| `secrets.type` 过滤条件 | `type = 'FederatedTokenSet'` | `type = 'FederatedTokenSet'` | **完全共用** |
| AES-256-GCM 信封加密 | ✅ `encryptTokenResponse` | ✅ 同一函数 | **完全共用** |
| Token 解密 | ✅ `decryptTokens` | ✅ 同一函数 | **完全共用** |
| Token 序列化/反序列化 | ✅ `encryptAndSerializeTokenResponse` / `deserializeEncryptedSecret` | ✅ 同一函数 | **完全共用** |
| Refresh Token 保留策略 | ✅ 保留原 refresh_token | ✅ 同一策略 | **完全共用** |
| TokenSet 结构（access_token/refresh_token/id_token） | ✅ | ✅ | **完全共用** |
| `getAccessToken()` 刷新逻辑分发 | ✅ 通过 `isSocialTokenSetSecret()` 类型守卫判断 | ✅ 同一类型守卫判断 | **完全共用** |
| 连接器配置表 | `connectors` 表 | `sso_connectors` 表（独立） | ❌ 独立表 |
| 关联表 | `secret_social_connector_relations` | `secret_enterprise_sso_connector_relations`（独立） | ❌ 独立表 |
| Token 存储触发时机 | 用户主动 PUT 请求 | 用户注册/登录时自动完成 | ❌ 不同 |
| Token 存储支持的协议类型 | OAuth 2.0 / OIDC 社交连接器 | **仅 OIDC**（SAML 不支持） | ❌ 不同 |
| Token 刷新入口 | `socials.refreshTokenSetSecret()` | `ssoConnectors.refreshTokenSetSecret()`（独立实现） | ❌ 独立函数（逻辑相同） |
| 查询入口（按用户查找） | `findSocialTokenSetSecretByUserIdAndTarget(userId, target)` | `findEnterpriseSsoTokenSetSecretByUserIdAndConnectorId(userId, connectorId)` | ❌ 独立查询 |
| 查询条件（WHERE 子句） | `user_id = ? AND target = ?` | `user_id = ? AND sso_connector_id = ?` | ❌ 不同 |
| **Upsert 旧记录删除条件** | `user_id = ? AND target = ?`（按 userId + target） | `user_id = ? AND issuer = ?`（⚠️ 仅按 userId + issuer，不区分 ssoConnectorId） | ❌ 不同 |
| 用户读取 Token 路由 | `GET /api/account/identities/:target/access-token` | `GET /api/account/sso-identities/:connectorId/access-token` | ❌ 不同路径和参数 |

---

## 三、职责边界对比

### 3.1 Connector Helper vs Secret Vault

| 维度 | Connector Helper（连接器配置） | Secret Vault（用户凭据加密） |
|------|-------------------------------|-----------------------------|
| **存储对象** | 连接器配置参数（`clientId`、`clientSecret`、SMTP 账号密码、API Key 等） | 用户登录后获取的第三方 Token（`access_token`、`refresh_token`、`id_token`） |
| **所属主体** | Tenant 级（连接器是租户配置） | User 级（每个用户的第三方凭据） |
| **存储方式** | `connectors.config` / `sso_connectors.config` JSONB **明文**存储 | `secrets` 表 **AES-256-GCM 信封加密**存储 |
| **使用时机** | 连接器运行时（发送邮件、获取授权 URL、换取 Token） | 用户需要调用第三方 API 时 |
| **配置开关** | 无需开关，创建连接器即存储配置 | `enable_token_storage` 控制是否启用 |
| **前置依赖** | 无（创建连接器即可） | 需要配置 `SECRET_VAULT_KEK` 环境变量 |
| **读取方式** | 通过 `getConnectorConfig()` 直接读取 JSON 明文 | 通过 `decryptTokens()` 解密后使用 |
| **前端敏感标记** | `ConnectorConfigFormItem.isConfidential`（仅 UI 掩码） | 无（后端完全加密，前端不可见） |
| **数据生命周期** | 随连接器创建/删除 | 随用户社交/SSO 身份绑定/解除绑定 |

### 3.2 社交连接器 vs 企业 SSO 连接器（Secret Vault 内部分层）

| 维度 | 社交连接器 | 企业 SSO 连接器 |
|------|-----------|-----------------|
| **连接器配置表** | `connectors` | `sso_connectors`（独立表） |
| **Token 关联表** | `secret_social_connector_relations` | `secret_enterprise_sso_connector_relations`（独立表） |
| **Token 加密主表** | `secrets`（共用） | `secrets`（共用） |
| **加密算法** | AES-256-GCM 信封加密（共用） | AES-256-GCM 信封加密（共用） |
| **Token 结构** | `{access_token, refresh_token?, id_token?}`（共用） | 相同结构（共用） |
| **支持协议** | OAuth 2.0 / OIDC | **仅 OIDC**（SAML 不支持 Token 存储） |
| **Token 存储触发** | 用户主动调用 PUT API | 用户注册/登录时自动写入 |
| **Token 刷新入口** | `socials.refreshTokenSetSecret()` | `ssoConnectors.refreshTokenSetSecret()`（独立实现，逻辑相同） |
| **Refresh Token 保留** | 保留原 refresh_token（共用策略） | 相同策略（共用） |
| **级联删除** | 连接器/身份删除时删除 secret | 数据库触发器自动删除关联 secret |
| **管理员查询 API** | `/users/:userId/all-identities?includeTokenSecret=true` | `/users/:userId/sso-identities/:ssoConnectorId?includeTokenSecret=true` |

---

## 四、关键配置项

### 4.1 环境变量

| 变量名 | 说明 | 适用模块 |
|--------|------|---------|
| `SECRET_VAULT_KEK` | Base64 编码的 32 字节密钥加密密钥（KEK），用于信封加密 | Secret Vault（启用 `enable_token_storage` 必需） |

### 4.2 连接器级别配置

| 字段 | 表 | 说明 |
|------|-----|------|
| `enable_token_storage` | `connectors` | 是否为该社交连接器启用用户 Token 持久化存储 |
| `enable_token_storage` | `sso_connectors` | 是否为该企业 SSO 连接器启用用户 Token 持久化存储（仅 OIDC 类型有效） |
| `metadata.isTokenStorageSupported` | 连接器工厂元数据（社交） | 连接器实现是否支持 Token 存储（需实现 `getTokenResponseAndUserInfo` 和 `getAccessTokenByRefreshToken`） |
| `connectorInstance instanceof OidcConnector` | SSO 连接器运行时判断 | 企业 SSO 连接器仅 OIDC 类型支持 Token 存储，SAML 类型跳过 |

---

## 五、易错点与注意事项

1. **Connector `config` 明文存储**：`clientSecret` 等敏感配置直接存储在 `connectors.config` 和 `sso_connectors.config` JSONB 中，没有加密。如需加密需要额外处理。

2. **`isConfidential` ≠ 加密**：配置表单项的 `isConfidential` 字段仅影响前端 UI 展示（密码输入框掩码），不影响后端存储方式。

3. **两套独立的敏感信息系统**：连接器配置和用户 Token 是完全独立的两套系统，使用不同的存储表和安全策略。

4. **Token 存储的双重/三重开关**：
   - 社交连接器：`connectors.enable_token_storage=true` + 连接器元数据 `isTokenStorageSupported=true` + `SECRET_VAULT_KEK` 已配置
   - 企业 SSO 连接器：`sso_connectors.enable_token_storage=true` + 连接器是 `OidcConnector` 实例 + `SECRET_VAULT_KEK` 已配置

5. **SAML 企业 SSO 不支持 Token 存储**：即使 `enable_token_storage=true`，SAML 类型的企业 SSO 连接器也会跳过 Token 存储逻辑（`connectorInstance instanceof OidcConnector` 校验不通过）。

6. **社交 vs SSO Token 存储触发时机不同**：
   - 社交连接器：用户需额外调用 `PUT /api/account/identities/:target/access-token` 主动存储
   - 企业 SSO 连接器：在用户注册/登录流程中由 `ProvisionLibrary.createUser()` 自动完成存储

7. **Demo 连接器配置隐藏**：在 API 响应中，Demo 连接器的 `config` 字段被置为空对象 `{}`，不返回真实配置。

8. **Well-Known 查询不含 config**：`findAllConnectorsWellKnown` 查询只返回 `id`、`metadata`、`connectorId`，不包含敏感的 `config` 字段。

9. **Refresh Token 的保留策略**：刷新 Token 时，如果第三方未返回新的 refresh_token，会保留原有 refresh_token（如 Google 的一次性 refresh_token 策略）。社交连接器和企业 SSO 连接器共用此策略。

10. **企业 SSO 级联删除通过触发器实现**：`secret_enterprise_sso_connector_relations` 表有两个 PL/pgSQL 触发器，分别在删除 `sso_connectors` 和 `user_sso_identities` 时自动清理关联的 `secrets` 记录。

11. **⚠️ 企业 SSO upsert 删除条件较粗**：`upsertEnterpriseSsoTokenSetSecret` 删除旧记录时只按 `userId + issuer` 删除，不区分 `ssoConnectorId`。这意味着如果同一用户通过同一 issuer（如同一 Azure AD 租户）的不同 SSO 连接器登录，后登录的会覆盖先登录的 Token。

12. **社交与企业 SSO Token 读取路由完全独立**：
    - 社交连接器：`GET /api/account/identities/:target/access-token`（`target` 是社交目标标识，如 `github`）
    - 企业 SSO 连接器：`GET /api/account/sso-identities/:connectorId/access-token`（路径是 `/sso-identities/`，参数是 `connectorId`）
    - 两者参数含义不同，不能混用。

13. **查询必须包含 `type = 'FederatedTokenSet'` 条件**：两个 `find*` 查询函数都会显式加上 `secrets.type = 'FederatedTokenSet'` 过滤条件，确保只查询 Token 类型的 secret，不与其他类型的 secret 混淆。

14. **`getAccessToken` 是共用函数，通过类型守卫分发**：社交和企业 SSO 的 Token 读取和刷新逻辑都走同一个 `getAccessToken` 函数，内部通过 `isSocialTokenSetSecret()` 类型守卫（检查是否包含 `target` 和 `connectorId` 字段）来区分，调用不同的 `refreshTokenSetSecret` 实现。
