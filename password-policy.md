# 密码策略配置与应用分析

## 1. 密码策略核心配置结构

密码策略定义在 `@logto/core-kit` 包中，类型结构如下：

```typescript
type PasswordPolicy = {
  length: {
    min: number;      // 最小长度，默认 8
    max: number;      // 最大长度，默认 256
  };
  characterTypes: {
    min: number;      // 最少字符类型数（1-4），默认 1
  };
  rejects: {
    pwned: boolean;                   // 是否拒绝已泄露密码，默认 true
    repetitionAndSequence: boolean;   // 是否拒绝重复/序列密码，默认 true
    userInfo: boolean;                // 是否拒绝包含用户信息的密码，默认 true
    words: string[];                  // 自定义拒绝词列表，默认 []
  };
};
```

**配置默认值与校验** (`password-policy.ts:43-63`):
- 使用 Zod 进行运行时校验，支持 DeepPartial 输入
- 所有字段均有合理默认值，可增量配置

---

## 2. 三条流程中密码策略的应用方式

### 2.1 注册流程 (Register)

**核心入口**：
- `NewPasswordIdentityVerification.verify()` (`new-password-identity-verification.ts:86-100`)
- `interaction/index.ts:101-104` - 创建 Interaction 时校验

**应用特点**：
1. **无用户上下文**：创建 `PasswordValidator` 时不传入 user 参数
2. **校验时机**：在验证新密码身份时立即校验
3. **用户信息来源**：从注册标识符（邮箱/手机号/用户名）提取
4. **无旧密码检查**：无需对比历史密码

**代码流程**：
```typescript
// 注册流程 - NewPasswordIdentityVerification.verify()
const passwordPolicy = await this.signInExperienceValidator.getPasswordPolicy();
const passwordValidator = new PasswordValidator(passwordPolicy); // 无 user
await passwordValidator.validatePassword(password, identifierProfile);
```

### 2.2 找回密码流程 (ForgotPassword)

**核心入口**：
- `profile-routes.ts:141-179` - `PUT /experience/profile/password`
- `Profile.setPasswordDigestWithValidation(password, true)` (`profile.ts:170-182`)

**应用特点**：
1. **有用户上下文**：需先通过验证码识别用户，传入 user 参数
2. **reset 标志**：`reset=true`，仅跳过"密码已存在于当前账户"检查
3. **仍需策略校验**：密码强度、敏感字段比对等正常执行
4. **新旧密码相同检查仍执行**：`same_password` 检查在 `validatePassword()` 内部，只要传入 user 就执行，与 reset 无关

> **重要澄清**：两个本质不同的检查
> - `same_password`：比对新旧密码内容是否相同（argon2Verify 哈希比对）
> - `password_exists_in_profile`：检查用户账户是否已设置过密码（`!user.passwordEncrypted`）
> 
> `reset=true` 仅跳过后者，不影响前者。

**代码流程**：
```typescript
// 找回密码 - profile-routes.ts
await experienceInteraction.profile.setPasswordDigestWithValidation(password, true);

// Profile.setPasswordDigestWithValidation()
async setPasswordDigestWithValidation(password: string, reset = false) {
  const user = await this.safeGetIdentifiedUser();
  const passwordValidator = new PasswordValidator(passwordPolicy, user);
  await passwordValidator.validatePassword(password, this.#data);
  
  if (user && !reset) {
    // 仅在非 reset 场景检查密码是否已存在
    this.profileValidator.guardProfileNotExistInCurrentUserAccount(user, passwordDigests);
  }
}
```

### 2.3 改密流程 (ChangePassword)

改密流程有两个独立入口，检查范围略有不同：

#### 入口 1：账户中心改密
- `account/index.ts:181-221` - `POST /account/password`
- 需身份验证 (`identityVerified`)
- 直接调用 `PasswordValidator.validatePassword()`，不经过 `setPasswordDigestWithValidation`
- **不执行**"密码已存在"检查

#### 入口 2：交互流程改密
- `profile-routes.ts:114-117` - `POST /experience/profile` (type='password')
- `Profile.setPasswordDigestWithValidation(password, false)`
- `reset=false`，执行完整检查

**应用特点**：
1. **有用户上下文**：必须传入 user 参数
2. **新旧密码比对**：`PasswordValidator.validatePassword()` 中检查新旧密码是否相同（两个入口都执行）
3. **密码存在性检查**：仅交互流程改密执行（`reset=false`），账户中心改密不执行

**代码流程**：
```typescript
// 账户中心改密 - account/index.ts
const passwordPolicyChecker = new PasswordValidator(signInExperience.passwordPolicy, user);
await passwordPolicyChecker.validatePassword(password, user);
```

---

### 2.3.1 same_password 触发条件深度分析

`same_password` 检查在代码中有两处独立实现，但判断逻辑**完全相同**：

**实现 1：experience 侧** (`password-validator.ts:57-67`)
**实现 2：interaction 侧** (`profile-verification.ts:199-206`)

```typescript
// 完全相同的三层 OR 逻辑
assertThat(
  !oldPasswordEncrypted ||                                     // 条件1：无旧密码 → 通过
    passwordEncryptionMethod !== UsersPasswordEncryptionMethod.Argon2i ||  // 条件2：非Argon2i加密 → 通过（迁移用户）
    !(await argon2Verify({ password, hash: oldPasswordEncrypted })),        // 条件3：Argon2i且密码不同 → 通过
  new RequestError({ code: 'user.same_password', status: 422 })
);
```

**真值表 - 触发 `user.same_password` 错误的条件**：

| oldPasswordEncrypted | passwordEncryptionMethod | argon2Verify 结果 | 触发 same_password？ | 场景说明 |
|---------------------|-------------------------|-------------------|---------------------|----------|
| null/undefined | - | - | ✗ | 用户从未设置过密码 |
| 存在 | 非 Argon2i | - | ✗ | 迁移用户（如 SHA-256、BCrypt 等），允许使用相同密码重新加密 |
| 存在 | Argon2i | false（密码不同） | ✗ | 正常改密，新密码与旧密码不同 |
| 存在 | Argon2i | true（密码相同） | ✓ | **唯一触发场景**：Argon2i 加密用户尝试使用相同密码 |

> **关键洞察**：迁移用户（非 Argon2i 加密）在找回密码时，即使输入与旧密码完全相同的新密码，也不会触发 `same_password` 错误。这是为了支持"将旧算法密码平滑迁移到 Argon2i"的场景。

### 2.4 reset=true 影响范围分析

**执行顺序** (`profile.ts:170-182`):
```typescript
async setPasswordDigestWithValidation(password: string, reset = false) {
  const user = await this.safeGetIdentifiedUser();
  const passwordValidator = new PasswordValidator(passwordPolicy, user);
  
  // 第1步：validatePassword - 包含 same_password 检查
  await passwordValidator.validatePassword(password, this.#data);  // ← 只要有 user，这里就检查 same_password！
  
  const passwordDigests = await passwordValidator.createPasswordDigest(password);

  // 第2步：reset 仅影响这一步
  if (user && !reset) {
    this.profileValidator.guardProfileNotExistInCurrentUserAccount(user, passwordDigests);
  }
}
```

**受 reset=true 影响（被跳过）的检查：**

| 检查项 | 位置 | 错误码 | 说明 |
|--------|------|--------|------|
| 密码已存在检查 | `profile-validator.ts:140-148` | `user.password_exists_in_profile` | 检查 `!user.passwordEncrypted`，防止给已有密码的用户重复设置 |

**不受 reset=true 影响（仍执行）的检查：**

| 检查项 | 位置 | 说明 |
|--------|------|------|
| 密码长度 | `password-policy.ts:244-254` | 最小/最大长度检查 |
| 字符类型 | `password-policy.ts:256-266` | 字符类型数量检查 |
| 已泄露密码 (pwned) | `password-policy.ts:175-179` | HaveIBeenPwned API 检查 |
| 重复/序列密码 | `password-policy.ts:203-206` | 重复字符、序列模式检查 |
| 用户信息敏感字段 | `password-policy.ts:212-218` | 姓名、用户名、邮箱、手机号比对 |
| 自定义拒绝词 | `password-policy.ts:208-210` | 自定义词列表检查 |
| **新旧密码相同检查** | `password-validator.ts:57-67` | **argon2Verify 比对新旧密码哈希**，只要 `this.user` 存在就执行 |

### 2.5 三条流程对比表

| 检查项 | 注册 | 找回密码 | 改密（交互） | 改密（账户中心） |
|--------|------|----------|------------|----------------|
| 密码长度 | ✓ | ✓ | ✓ | ✓ |
| 字符类型 | ✓ | ✓ | ✓ | ✓ |
| 已泄露密码 (pwned) | ✓ | ✓ | ✓ | ✓ |
| 重复/序列密码 | ✓ | ✓ | ✓ | ✓ |
| 用户信息敏感字段 | ✓ | ✓ | ✓ | ✓ |
| 自定义拒绝词 | ✓ | ✓ | ✓ | ✓ |
| 新旧密码相同检查 (`same_password`) | ✗ | ✓ | ✓ | ✓ |
| 密码已存在检查 (`password_exists_in_profile`) | ✗ | ✗ | ✓ | ✗ |

**关键差异说明**：
- **注册**：无 user 上下文，不执行任何用户相关的历史密码检查
- **找回密码**：有 user 上下文，`reset=true` 仅跳过"密码已存在"检查，但`same_password` 检查仍执行（注意 Argon2i 迁移用户例外）
- **改密（交互）**：有 user 上下文，`reset=false`，执行全部检查
- **改密（账户中心）**：直接调用 `PasswordValidator.validatePassword()`，不经过 `setPasswordDigestWithValidation`，所以不执行"密码已存在"检查，但 `same_password` 检查仍执行

---

### 2.6 找回密码：interaction 侧 vs experience 侧校验链路

找回密码有两套独立的 API 链路，校验时机和范围存在差异：

#### 链路 A：experience 侧（新版）
- **入口**：`PUT /experience/profile/password` (`profile-routes.ts:141-179`)
- **校验时机**：密码提交时立即校验
- **校验流程**：
  ```
  setPasswordDigestWithValidation(password, true)
    → PasswordValidator.validatePassword()
       → 密码策略校验（长度、字符类型、pwned等）
       → same_password 检查（含 Argon2i 条件）✓
    → reset=true，跳过 password_exists_in_profile 检查 ✗
  ```

#### 链路 B：interaction 侧（旧版）
- **入口**：`PUT /interaction` → `PUT /interaction/profile` → `POST /interaction/submit`
- **校验时机**：分两阶段校验
- **校验流程**：
  ```
  阶段1：创建/更新 Profile 时
    → validatePassword() (interaction/utils/validate-password.ts:58-76)
       → 仅调用 checker.check()，做密码策略校验 ✓
       → ❗ 不检查 same_password ✗
       → ❗ 不检查 password_exists_in_profile ✗
  
  阶段2：提交 Interaction 时
    → verifyProfile() (interaction/verifications/profile-verification.ts:163-214)
       → forgotPasswordProfileGuard 确保 password 存在 ✓
       → same_password 检查（含 Argon2i 条件，与 experience 侧完全相同）✓
       → ❗ 不检查 password_exists_in_profile ✗
  ```

**两侧关键差异对比**：

| 校验项 | experience 侧 | interaction 侧 |
|--------|--------------|----------------|
| 密码策略校验 | 提交时 | 提交时 |
| same_password 检查 | 提交时立即 | 延迟到 submit 时 |
| password_exists_in_profile | ✗ | ✗ |
| Argon2i 迁移用户例外 | ✓ | ✓ |

---

### 2.7 password_exists_in_profile 判定口径差异

`password_exists_in_profile` 检查在两处有不同的判定逻辑：

#### 判定口径 1：interaction 侧（SignIn 事件专用）
**位置**：`profile-verification.ts:153-160`
```typescript
if (password) {
  assertThat(
    !isUserPasswordSet(user),
    new RequestError({ code: 'user.password_exists_in_profile' })
  );
}

// isUserPasswordSet 定义 (interaction/utils/index.ts:24-29)
export const isUserPasswordSet = ({
  passwordEncrypted,
  identities,
}: Pick<User, 'passwordEncrypted' | 'identities'>): boolean => {
  return Boolean(passwordEncrypted) || Object.keys(identities).length > 0;
};
```
**判定逻辑**：有密码哈希 **或** 有社交身份 → 认为"已设置密码"
**适用场景**：仅 SignIn 事件，ForgotPassword 事件不执行此检查

#### 判定口径 2：experience 侧（Profile 类专用）
**位置**：`profile-validator.ts:140-148`
```typescript
if (passwordEncrypted) {
  assertThat(
    !user.passwordEncrypted,
    new RequestError({ code: 'user.password_exists_in_profile', status: 422 })
  );
}
```
**判定逻辑**：仅判断 `!user.passwordEncrypted`，不考虑社交身份
**适用场景**：`setPasswordDigestWithValidation` 且 `reset=false` 时（即改密交互流程）

**判定口径差异总结**：

| 判定维度 | interaction 侧 | experience 侧 |
|---------|--------------|----------------|
| 检查 `passwordEncrypted` | ✓ | ✓ |
| 检查 `identities` 长度 | ✓ | ✗ |
| 用户有社交身份但无密码 | 认为"已设置密码" | 认为"未设置密码" |
| 适用场景 | SignIn 事件 | Profile.setPasswordDigestWithValidation |
| ForgotPassword 事件 | 不执行此检查 | reset=true 时不执行 |

> **设计意图差异**：
> - interaction 侧的 `isUserPasswordSet` 认为"社交身份可替代密码"，所以有社交身份的用户不需要再设置密码
> - experience 侧的判断更直接，只看是否有密码哈希，用于防止给已有密码的用户重复设置密码

---

## 3. 强度评估机制

### 3.1 两层校验架构

**快速校验 (fastCheck)** - 前端实时校验 (`password-policy.ts:241-269`):
```typescript
fastCheck(password: string): PasswordIssue[] {
  // 1. 长度检查
  if (password.length < min) → too_short
  if (password.length > max) → too_long
  
  // 2. 字符类型检查
  const result = checkCharTypes(password);
  if (result === 'unsupported') → unsupported_characters
  else if (!result) → character_types
}
```

**完整校验 (check)** - 后端完整校验 (`password-policy.ts:172-228`):
```typescript
async check(password, userInfo?): Promise<PasswordIssue[]> {
  // 1. 先执行 fastCheck
  const issues = this.fastCheck(password);
  
  // 2. 异步检查已泄露密码 (HaveIBeenPwned API)
  if (policy.rejects.pwned && await hasBeenPwned(password)) → pwned
  
  // 3. 标记违规字符位置 (hashArray 算法)
  const hashArray = Array(password.length).fill(0);
  
  for (let i = 0; i < password.length; i++) {
    const sliced = password.slice(i);
    fillHashArray(i, repetitionLength(sliced), 'restricted.repetition');
    fillHashArray(i, sequenceLength(sliced), 'restricted.sequence');
    fillHashArray(i, wordLength(sliced), 'restricted.words');
    fillHashArray(i, userInfoLength(sliced, userInfo), 'restricted.user_info');
  }
  
  // 4. 容忍度判断：违规字符数 > 密码长度 - 3 才拒绝
  return hashArray.sum() > getRestrictedPhraseThreshold(password)
    ? [...issues, ...issueCodes]
    : issues;
}
```

### 3.2 字符类型检查 (`checkCharTypes`)

支持四种字符类型：
- 小写字母 (a-z)
- 大写字母 (A-Z)
- 数字 (0-9)
- 符号 (`!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~ `)

检查逻辑：
1. 遍历密码的每个字符
2. 遇到不支持的字符立即返回 `'unsupported'`
3. 统计出现的字符类型数量
4. 返回 `类型数量 >= policy.characterTypes.min`

### 3.3 已泄露密码检查 (`hasBeenPwned`)

使用 k-anonymity 算法保护隐私：
1. 计算密码 SHA-1 哈希
2. 取哈希前 5 位查询 HaveIBeenPwned API
3. 本地比对返回的哈希后缀列表
4. 集成测试环境使用 mock 数据 (`getPwnPasswordsForTest()`)

### 3.4 重复/序列检查

**重复检查** (`repetitionLength`):
- 检查连续相同字符（如 "aaaaa"）
- 阈值：`repetitionAndSequenceThreshold = 3`
- 小于阈值返回 0，不标记为违规

**序列检查** (`sequenceLength`):
- 预定义序列模式：数字、字母、键盘布局 (qwerty, 1qaz 等)
- 支持正向和反向序列检查
- 同样适用 3 字符阈值

---

## 4. 敏感字段比对机制

### 4.1 用户信息比对 (`userInfoLength`)

**比对字段** (`password-policy.ts:359-407`):
```typescript
userInfoLength(password, userInfo: UserInfo): number
type UserInfo = Partial<{
  name: string;
  username: string;
  email: string;
  phoneNumber: string;
}>;
```

**姓名匹配逻辑**：
1. 原始全名匹配（忽略大小写）
2. 去除空格后匹配
3. 按空格拆分后逐个单词匹配
4. 取最长匹配长度

**邮箱匹配**：
- 仅匹配 `@` 前缀部分

**手机号匹配**：
- 完整号码匹配

### 4.2 自定义拒绝词 (`wordLength`)

- 从 `policy.rejects.words` 配置中读取
- 遍历每个词，检查密码是否以该词开头
- 取最长匹配长度
- 不区分大小写

### 4.3 容忍度机制

```typescript
static restrictedPhrasesTolerance = 3;
static getRestrictedPhraseThreshold(password: string): number {
  return Math.max(1, password.length - restrictedPhrasesTolerance);
}
```

**设计意图**：
- 允许密码中包含少量用户信息字符
- 例如：密码 "john123!"，用户名为 "john"
  - 密码长度 8，阈值 = 8 - 3 = 5
  - 违规字符数 = 4 ("john")
  - 4 < 5，允许通过

---

## 5. 错误反馈机制

### 5.1 错误码定义

```typescript
type PasswordRejectionCode =
  | 'too_short'
  | 'too_long'
  | 'character_types'
  | 'unsupported_characters'
  | 'pwned'
  | 'restricted.repetition'
  | 'restricted.sequence'
  | 'restricted.user_info'
  | 'restricted.words';
```

### 5.2 后端错误抛出

**校验失败** (`password-validator.ts:53-55`):
```typescript
if (issues.length > 0) {
  throw new RequestError({ code: 'password.rejected', status: 422 }, issues);
}
```

**新旧密码相同** (`password-validator.ts:60-66`):
```typescript
throw new RequestError({ code: 'user.same_password', status: 422 });
```

### 5.3 前端错误展示

**优先级策略** (`use-password-error-message.ts:11-44`):
```typescript
// 1. 独立展示的高优先级错误（按顺序）
const singleDisplayError = [
  'unsupported_characters',  // 最高优先级
  'too_short',
  'character_types',
  'too_long',
  'pwned',
].find(Boolean);

// 2. 组合展示的限制类错误
const restrictedErrors = issues
  .filter(i => i.code.startsWith('password_rejected.restricted.'))
  .map(i => t(`error.${i.code}`));

return t('error.password_rejected.restricted_found', { list: restrictedErrors });
```

**展示规则**：
- 高优先级错误单独显示，只显示第一个匹配的
- 多个限制类错误合并显示，使用列表格式
- 错误消息支持插值（如 `min` 参数）

---

## 6. 多租户差异处理

### 6.1 配置存储与隔离

密码策略作为 `SignInExperience` 的一部分，按租户存储：
- 数据库表：`sign_in_experiences`
- 每个租户有独立的 `passwordPolicy` JSONB 字段

### 6.2 运行时注入

**中间件注入** (`koa-interaction-sie.ts:21-44`):
```typescript
export default function koaInteractionSie(queries: Queries) {
  return async (ctx, next) => {
    const signInExperience = await queries.signInExperiences.findDefaultSignInExperience();
    ctx.signInExperience = signInExperience;
    ctx.passwordPolicyChecker = new PasswordPolicyChecker(
      signInExperience.passwordPolicy,
      crypto.subtle
    );
    return next();
  };
}
```

**使用时获取** (`sign-in-experience-validator.ts:239-243`):
```typescript
public async getPasswordPolicy() {
  const { passwordPolicy } = await this.getSignInExperienceData();
  return passwordPolicy;
}
```

### 6.3 多租户架构要点

1. **租户上下文** (`TenantContext`)：每个请求绑定特定租户，包含该租户的 queries 和 libraries
2. **配置缓存**：`SignInExperienceValidator` 内部缓存 `signInExperienceDataCache`
3. **查询隔离**：所有数据库查询通过 `tenant.queries` 访问，自动应用租户过滤
4. **独立配置**：不同租户可配置完全不同的密码策略

---

## 7. 关键类与文件索引

| 模块 | 文件路径 | 核心职责 |
|------|----------|----------|
| 策略核心 | `packages/toolkit/core-kit/src/password-policy.ts` | 策略定义、校验算法 |
| 校验器 | `packages/core/src/routes/experience/classes/libraries/password-validator.ts` | 流程级校验封装，含 same_password 检查 |
| interaction 策略校验 | `packages/core/src/routes/interaction/utils/validate-password.ts` | Interaction 路由密码策略校验（不含 same_password） |
| interaction 完整校验 | `packages/core/src/routes/interaction/verifications/profile-verification.ts` | Interaction submit 时完整校验，含 same_password |
| interaction 工具 | `packages/core/src/routes/interaction/utils/index.ts` | `isUserPasswordSet()` 判定函数 |
| 注册流程 | `packages/core/src/routes/experience/classes/verifications/new-password-identity-verification.ts` | 注册密码验证 |
| Profile 类 | `packages/core/src/routes/experience/classes/profile.ts` | 改密/找回密码校验入口 |
| Profile 校验器 | `packages/core/src/routes/experience/classes/libraries/profile-validator.ts` | 密码已存在性检查（experience 侧口径） |
| 账户改密 | `packages/core/src/routes/account/index.ts` | 账户中心改密 |
| 多租户注入 | `packages/core/src/routes/interaction/middleware/koa-interaction-sie.ts` | 密码策略中间件 |
| 前端校验 | `packages/experience/src/hooks/use-password-policy-checker.ts` | 前端快速校验 |
| 错误展示 | `packages/experience/src/shared/hooks/use-password-error-message.ts` | 错误消息格式化 |
| 错误短语 | `packages/phrases/src/locales/en/errors/password.ts` | 错误文案 |
