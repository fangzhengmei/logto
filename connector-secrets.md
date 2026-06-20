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

| 模块 | 文件路径 | 职责 |
|------|---------|------|
| Secret Encryption | [secret-encryption.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/utils/secret-encryption.ts) | AES-256-GCM 加密/解密、Token 序列化 |
| Secret Queries | [secret.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/queries/secret.ts) | Secrets 表与关联表的数据库操作 |
| Social Library | [social.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/libraries/social.ts) | 社交连接器 Token 存储与刷新 |
| Third-Party Tokens API | [third-party-tokens.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/routes/account/third-party-tokens.ts) | 用户获取第三方 Access Token 的接口 |
| Social Verification | [social-verification.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/routes/experience/classes/verifications/social-verification.ts) | 社交登录验证流程中的 Token 暂存 |

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

关联表 1：`secret_social_connector_relations`（社交连接器关联）
- `secret_id` → 关联 `secrets.id`
- `connector_id` → 关联 `connectors.id`
- `target` → 社交连接器目标标识（如 `github`、`google`）
- `identity_id` → 第三方用户 ID

关联表 2：`secret_enterprise_sso_connector_relations`（企业 SSO 连接器关联）
- `secret_id` → 关联 `secrets.id`
- `sso_connector_id` → 关联企业 SSO 连接器
- `issuer` → IdP Issuer
- `identity_id` → 第三方用户 ID

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
            ├─ 插入 secrets 表
            └─ 插入 secret_social_connector_relations 表
```

**核心代码**：
- `getUserInfoWithOptionalTokenResponse`：[social.ts#L95-L152](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/libraries/social.ts#L95-L152)
- `upsertSocialTokenSetSecret`：[social.ts#L183-L204](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/libraries/social.ts#L183-L204)
- `encryptAndSerializeTokenResponse`：[secret-encryption.ts#L179-L192](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/utils/secret-encryption.ts#L179-L192)

#### 流程二：用户读取第三方 Access Token

```
用户请求：GET /api/account/identities/:target/access-token
    ↓
[thirdPartyTokensRoutes]
    ↓
queries.secrets.findSocialTokenSetSecretByUserIdAndTarget(userId, target)
    └─ JOIN secrets + secret_social_connector_relations
    ↓
[getAccessToken()]
    ├─ decryptTokens({ iv, encryptedDek, ciphertext, authTag })
    │   └─ 使用 KEK 解密得到明文 TokenSet
    ├─ 检查 access_token 是否过期（metadata.expiresAt）
    │   ├─ 未过期：直接返回
    │   └─ 已过期：
    │       ├─ 有 refresh_token → 调用 refreshTokenSetSecret()
    │       │   ├─ 连接器 getAccessTokenByRefreshToken() 刷新 Token
    │       │   ├─ encryptTokenResponse() 重新加密
    │       │   └─ secrets.updateById() 更新数据库
    │       └─ 无 refresh_token → 删除 secret，返回 401
    └─ 返回格式化的 Access Token 响应
```

**核心代码**：
- `getAccessToken`：[third-party-tokens.ts#L47-L88](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/routes/account/third-party-tokens.ts#L47-L88)
- `decryptTokens`：[secret-encryption.ts#L89-L92](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/utils/secret-encryption.ts#L89-L92)
- `refreshTokenSetSecret`：[social.ts#L213-L271](file:///d:/fz/0601-2/solo-dogfeeding/code/66-logto/packages/core/src/libraries/social.ts#L213-L271)

---

## 三、职责边界对比

| 维度 | Connector Helper（连接器配置） | Secret Vault（用户凭据加密） |
|------|-------------------------------|-----------------------------|
| **存储对象** | 连接器配置参数（`clientId`、`clientSecret`、SMTP 账号密码、API Key 等） | 用户登录后获取的第三方 Token（`access_token`、`refresh_token`、`id_token`） |
| **所属主体** | Tenant 级（连接器是租户配置） | User 级（每个用户的第三方凭据） |
| **存储方式** | `connectors.config` JSONB **明文**存储 | `secrets` 表 **AES-256-GCM 信封加密**存储 |
| **使用时机** | 连接器运行时（发送邮件、获取授权 URL、换取 Token） | 用户需要调用第三方 API 时 |
| **配置开关** | 无需开关，创建连接器即存储配置 | `connectors.enable_token_storage` 控制是否启用 |
| **前置依赖** | 无（创建连接器即可） | 需要配置 `SECRET_VAULT_KEK` 环境变量 |
| **读取方式** | 通过 `getConnectorConfig()` 直接读取 JSON 明文 | 通过 `decryptTokens()` 解密后使用 |
| **前端敏感标记** | `ConnectorConfigFormItem.isConfidential`（仅 UI 掩码） | 无（后端完全加密，前端不可见） |
| **数据生命周期** | 随连接器创建/删除 | 随用户社交身份绑定/解除绑定 |

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
| `metadata.isTokenStorageSupported` | 连接器工厂元数据 | 连接器实现是否支持 Token 存储（需实现 `getTokenResponseAndUserInfo` 和 `getAccessTokenByRefreshToken`） |

---

## 五、易错点与注意事项

1. **Connector `config` 明文存储**：`clientSecret` 等敏感配置直接存储在 `connectors.config` JSONB 中，没有加密。如需加密需要额外处理。

2. **`isConfidential` ≠ 加密**：配置表单项的 `isConfidential` 字段仅影响前端 UI 展示（密码输入框掩码），不影响后端存储方式。

3. **两套独立的敏感信息系统**：连接器配置和用户 Token 是完全独立的两套系统，使用不同的存储表和安全策略。

4. **Token 存储的双重开关**：需要同时满足 `connectors.enable_token_storage=true` 和连接器元数据 `isTokenStorageSupported=true`，以及配置了 `SECRET_VAULT_KEK`，Token 才会被存储。

5. **Demo 连接器配置隐藏**：在 API 响应中，Demo 连接器的 `config` 字段被置为空对象 `{}`，不返回真实配置。

6. **Well-Known 查询不含 config**：`findAllConnectorsWellKnown` 查询只返回 `id`、`metadata`、`connectorId`，不包含敏感的 `config` 字段。

7. **Refresh Token 的保留策略**：刷新 Token 时，如果第三方未返回新的 refresh_token，会保留原有 refresh_token（如 Google 的一次性 refresh_token 策略）。
