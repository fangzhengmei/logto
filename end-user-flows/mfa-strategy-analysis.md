# Logto MFA 策略与登录体验联动机制分析报告

> **交付物类型**: 代码级可复核分析报告 | **版本**: v1.36.0 | **日期**: 2026-05-16
> 
> **修正记录**: 
> - 2026-05-16 v2 - 明确优先级结论的适用范围：区分 sortMfaFactors 与 用户可用因子列表生成流程
> - 2026-05-16 v1 - 修正 MfaFactor 枚举顺序与显示优先级的区分，统一 Phone/Email 优先级描述

---

## 目录

1. [概述](#1-概述)
2. [组织级强制策略与全局策略合并判定逻辑](#2-组织级强制策略与全局策略合并判定逻辑)
3. [认证因子优先级与隐式因子动态加入规则](#3-认证因子优先级与隐式因子动态加入规则)
4. [前端按错误码切换页面分支逻辑](#4-前端按错误码切换页面分支逻辑)
5. [代码复核清单](#5-代码复核清单)

---

## 1. 概述

本报告基于 Logto 代码库进行深度代码级分析，重点剖析 MFA（多因素认证）策略在后端的判定逻辑与前端的用户体验联动。所有结论均提供明确的代码文件路径与行号，支持直接代码复核。

**关键区分**:
- **sortMfaFactors 函数**: 纯硬编码的固定优先级排序
- **getAllUserEnabledMfaVerifications 函数**: 混合流程，包含 lastUsedAt 动态排序

**分析范围**:
- 组织级 MFA 强制策略与全局策略的合并判定
- MFA 认证因子的优先级排序与隐式因子动态加入
- 前端基于错误码的页面切换分支逻辑

---

## 2. 组织级强制策略与全局策略合并判定逻辑

### 2.1 策略配置数据结构

#### 2.1.1 MFA 策略类型定义

| 策略类型 | 枚举值 | 说明 | 代码位置 |
|---------|--------|------|---------|
| 全局 MFA 策略 | `MfaPolicy` | 控制全局 MFA 提示行为 | `schemas/src/foundations/jsonb-types/sign-in-experience.ts:188-203` |
| 组织级 MFA 策略 | `OrganizationRequiredMfaPolicy` | 控制组织成员强制 MFA | `schemas/src/foundations/jsonb-types/sign-in-experience.ts:205-210` |

**代码片段**:
```typescript
// 文件: packages/schemas/src/foundations/jsonb-types/sign-in-experience.ts
// 行号: 188-210
export enum MfaPolicy {
  Mandatory = 'Mandatory',                              // 强制启用
  PromptAtSignInAndSignUp = 'PromptAtSignInAndSignUp',  // 注册+登录时提示
  PromptOnlyAtSignIn = 'PromptOnlyAtSignIn',            // 仅登录时提示
  NoPrompt = 'NoPrompt',                                // 不提示
  PromptAtSignInAndSignUpMandatory = 'PromptAtSignInAndSignUpMandatory', // 注册+登录强制提示(自适应MFA)
  PromptOnlyAtSignInMandatory = 'PromptOnlyAtSignInMandatory',           // 仅登录强制提示(自适应MFA)
}

export enum OrganizationRequiredMfaPolicy {
  NoPrompt = 'NoPrompt',    // 不强制
  Mandatory = 'Mandatory',  // 强制所有组织成员启用MFA
}
```

#### 2.1.2 MFA 配置对象结构

```typescript
// 文件: packages/schemas/src/foundations/jsonb-types/sign-in-experience.ts
// 行号: 212-240
type Mfa = {
  factors: MfaFactor[];                          // 启用的MFA认证因子列表
  policy: MfaPolicy;                             // 全局MFA提示策略
  organizationRequiredMfaPolicy?: OrganizationRequiredMfaPolicy;  // 组织级MFA策略
};
```

---

### 2.2 策略优先级判定层级

```
┌─────────────────────────────────────────────────────────────────┐
│                     MFA 策略判定优先级 (高→低)                    │
├─────────────────────────────────────────────────────────────────┤
│  1. 组织级强制策略                                               │
│     └─ organizationRequiredMfaPolicy = Mandatory                │
│     └─ 只要用户所属任意组织启用强制MFA → 判定为强制                │
│                                                                   │
│  2. 全局策略                                                     │
│     └─ isNoSkipMfaPolicy() → Mandatory/*Mandatory 为强制策略     │
│     └─ 其他策略为可选，用户可跳过                                 │
│                                                                   │
│  3. 用户配置状态                                                 │
│     └─ user.logtoConfig.mfa.enabled/skipped                      │
│     └─ user.mfaVerifications (已绑定的因子列表)                   │
└─────────────────────────────────────────────────────────────────┘
```

---

### 2.3 组织强制策略判定核心逻辑

#### 2.3.1 `isMfaRequiredByUserOrganizations()` 方法

**代码位置**: `packages/core/src/routes/experience/classes/mfa.ts:651-659`

```typescript
private async isMfaRequiredByUserOrganizations(
  mfaSettings: MfaSettings, 
  userId: string
): Promise<boolean> {
  // 条件1: 全局设置必须先开启组织强制策略开关
  if (mfaSettings.organizationRequiredMfaPolicy !== OrganizationRequiredMfaPolicy.Mandatory) {
    return false;
  }

  // 条件2: 查询用户所属所有组织
  const organizations = 
    await this.queries.organizations.relations.users.getOrganizationsByUserId(userId);

  // 条件3: 只要有任意一个组织设置了强制MFA，就返回true
  return organizations.some(({ isMfaRequired }) => isMfaRequired);
}
```

**复核要点**:
- ✅ 组织强制策略需要两级开关：全局开关 + 单组织开关
- ✅ 只要任一组织启用强制，用户就必须启用MFA
- ✅ 此方法在 assertUserMandatoryMfaFulfilled() 中被调用

---

#### 2.3.2 不可跳过策略判定函数

**代码位置**: `packages/core/src/libraries/sign-in-experience/mfa-policy.ts:1-8`

```typescript
import { MfaPolicy } from '@logto/schemas';

export const isNoSkipMfaPolicy = (policy: MfaPolicy): boolean =>
  [
    MfaPolicy.Mandatory,
    MfaPolicy.PromptAtSignInAndSignUpMandatory,
    MfaPolicy.PromptOnlyAtSignInMandatory,
  ].includes(policy);

export const isPromptOnlyAtSignInPolicy = (policy: MfaPolicy): boolean =>
  [MfaPolicy.PromptOnlyAtSignIn, MfaPolicy.PromptOnlyAtSignInMandatory].includes(policy);
```

**复核要点**:
- ✅ 三种策略属于"不可跳过"类型：Mandatory 及两个 Mandatory 后缀的自适应策略
- ✅ `isPromptOnlyAtSignInPolicy` 用于注册场景跳过 MFA 检查

---

### 2.4 登录场景：MFA 验证必要性判定

#### 2.4.1 `guardMfaVerificationStatus()` 方法

**代码位置**: `packages/core/src/routes/experience/classes/experience-interaction.ts:356-403`

```typescript
public async guardMfaVerificationStatus(log?: LogEntry) {
  // Exception 1: Enterprise SSO 登录免 MFA 验证
  if (this.hasVerifiedSsoIdentity || this.hasVerifiedSignInPasskey) {
    return;
  }

  const user = await this.getIdentifiedUser();
  const mfaSettings = await this.signInExperienceValidator.getMfaSettings();
  const adaptiveMfaResult = await this.adaptiveMfaValidator.getResult(log);

  const mfaValidator = new MfaValidator(mfaSettings, user, adaptiveMfaResult);

  // 检查是否需要 MFA 验证
  if (!mfaValidator.isMfaRequired) {
    return;
  }

  // 检查当前交互中是否已有通过的 MFA 验证记录
  const isMfaVerified = mfaValidator.isMfaVerified(this.verificationRecordsArray);

  if (isMfaVerified) {
    return;
  }

  // 抛出错误要求进行二次认证
  throw new RequestError(
    { code: 'session.mfa.require_mfa_verification', status: 403 },
    {
      availableFactors: mfaValidator.availableUserMfaVerificationTypes,
      maskedIdentifiers,  // 掩码后的邮箱/手机号
    }
  );
}
```

**复核要点**:
- ✅ SSO 和 Passkey 登录场景免 MFA 验证
- ✅ 先通过 `isMfaRequired` 判定是否需要验证
- ✅ 已有验证记录则跳过
- ✅ 否则抛出 403 错误要求前端跳转

---

#### 2.4.2 `isMfaRequired` Getter 属性

**代码位置**: `packages/core/src/routes/experience/classes/libraries/mfa-validator.ts:112-135`

```typescript
get isMfaRequired(): boolean {
  const hasUserFactors = this.userEnabledMfaVerifications.length > 0;

  // ========== 自适应 MFA 模式 ==========
  if (this.adaptiveMfaResult !== undefined) {
    // 风险规则触发 + 用户有MFA因子 → 需要验证
    return this.adaptiveMfaResult.requiresMfa && hasUserFactors;
  }

  // ========== 常规策略模式 ==========
  const mfaData = userMfaDataGuard.safeParse(this.user.logtoConfig[userMfaDataKey]);
  const skipMfaOnSignIn = mfaData.success ? mfaData.data.skipMfaOnSignIn : undefined;
  const isMfaEnabled = mfaData.success ? mfaData.data.enabled : undefined;

  // 用户明确禁用或跳过 + 策略非强制 → 不需要验证
  if ((isMfaEnabled === false || skipMfaOnSignIn) && !isNoSkipMfaPolicy(this.mfaSettings.policy)) {
    return false;
  }

  // 用户有可用因子 → 需要验证
  return hasUserFactors;
}
```

**复核要点**:
- ✅ 自适应模式：风险触发 + 有因子 → 需要验证
- ✅ 常规模式：用户已跳过且策略允许跳过 → 不需要
- ✅ 否则只要有绑定因子就需要验证

---

### 2.5 绑定场景：强制 MFA 绑定完整性检查

#### 2.5.1 `assertUserMandatoryMfaFulfilled()` 方法

**代码位置**: `packages/core/src/routes/experience/classes/mfa.ts:471-542`

```typescript
private async assertUserMandatoryMfaFulfilled(
  submitMfaValidationContext: SubmitMfaValidationContext
) {
  const { mfaSettings } = submitMfaValidationContext;
  const { policy, factors } = mfaSettings;

  // 退出条件1: 无启用因子
  if (factors.length === 0) {
    return;
  }

  // 退出条件2: 注册场景 + PromptOnlyAtSignIn 策略
  if (
    this.interactionContext.getInteractionEvent() === InteractionEvent.Register &&
    isPromptOnlyAtSignInPolicy(policy)
  ) {
    return;
  }

  const { user: identifiedUser } = submitMfaValidationContext;
  const { logtoConfig, id: userId } = identifiedUser;

  // 关键: 检查组织级强制策略
  const isMfaRequiredByUserOrganizations = await this.isMfaRequiredByUserOrganizations(
    mfaSettings,
    userId
  );

  // 退出条件3: NoPrompt策略且非组织强制
  if (policy === MfaPolicy.NoPrompt && !isMfaRequiredByUserOrganizations) {
    return;
  }

  // 退出条件4: 用户已跳过且策略允许跳过且非组织强制
  if (
    !isNoSkipMfaPolicy(policy) &&
    (this.#mfaSkipped ?? isMfaSkipped(logtoConfig)) &&
    !isMfaRequiredByUserOrganizations
  ) {
    return;
  }

  const configuredFactors = await this.signInExperienceValidator.getConfiguredMfaFactors();
  const { userFactors: factorsInUser } = submitMfaValidationContext;
  const factorsInBind = this.bindMfaFactorsArray.map(({ type }) => type);
  const linkedFactors = deduplicate([...factorsInUser, ...factorsInBind]);

  // 核心判定: 用户是否至少有一个配置的MFA因子？
  assertThat(
    configuredFactors.some((factor) => linkedFactors.includes(factor)),
    new RequestError(
      { code: 'user.missing_mfa', status: 422 },
      // skippable 标志决定前端是否显示跳过按钮
      isNoSkipMfaPolicy(policy) || isMfaRequiredByUserOrganizations
        ? { availableFactors: configuredFactors }
        : { availableFactors: configuredFactors, skippable: true }
    )
  );

  // 备用码强制绑定检查
  assertThat(
    !factors.includes(MfaFactor.BackupCode) || linkedFactors.includes(MfaFactor.BackupCode),
    new RequestError({
      code: 'session.mfa.backup_code_required',
      status: 422,
    })
  );
}
```

**复核要点**:
- ✅ 组织强制策略会覆盖用户的跳过选择
- ✅ `skippable` 字段由两个条件的**或运算**决定：
  - 全局策略是不可跳过的 (`isNoSkipMfaPolicy(policy)`)
  - **或者** 组织要求强制 MFA

---

### 2.6 策略判定真值表

| 全局策略 | 组织强制 | 用户已跳过 | 是否需要绑定 | skippable 值 | 说明 |
|---------|---------|-----------|-------------|-------------|------|
| Mandatory | 任意 | 任意 | ✅ 是 | ❌ false | 全局强制，不可跳过 |
| PromptAtSignInAndSignUp | 否 | 是 | ❌ 否 | - | 用户已跳过可选策略 |
| PromptAtSignInAndSignUp | 否 | 否 | ✅ 是 | ✅ true | 可选绑定，可跳过 |
| PromptAtSignInAndSignUp | 是 | 任意 | ✅ 是 | ❌ false | 组织强制覆盖用户选择 |
| NoPrompt | 否 | 任意 | ❌ 否 | - | 不提示 |
| NoPrompt | 是 | 任意 | ✅ 是 | ❌ false | 组织强制覆盖NoPrompt |

---

## 3. 认证因子优先级与隐式因子动态加入规则

### 3.1 MFA 因子类型定义

> ⚠️ **重要区分 1/2**: 枚举定义顺序 ≠ 显示优先级顺序 ≠ 用户可用因子顺序
> 
> - **MfaFactor 枚举**: 只是代码声明顺序
> - **sortMfaFactors**: 固定硬编码优先级
> - **getAllUserEnabledMfaVerifications**: 混合逻辑，含 lastUsedAt 动态排序

**代码位置**: `packages/schemas/src/foundations/jsonb-types/sign-in-experience.ts:176-182`

```typescript
export enum MfaFactor {
  TOTP = 'Totp',                                  // 枚举定义顺序 #1
  WebAuthn = 'WebAuthn',                          // 枚举定义顺序 #2
  BackupCode = 'BackupCode',                      // 枚举定义顺序 #3
  EmailVerificationCode = 'EmailVerificationCode', // 枚举定义顺序 #4
  PhoneVerificationCode = 'PhoneVerificationCode', // 枚举定义顺序 #5
}
```

**复核要点**:
- ✅ 5 种 MFA 因子类型
- ✅ 枚举定义顺序只是代码声明顺序，**不代表**显示优先级
- ✅ 邮箱和手机支持"隐式可用"——不需要用户显式绑定

---

### 3.2 sortMfaFactors: 固定优先级排序函数

> ✅ **适用范围**: 纯因子列表排序，例如 Admin Console 配置页、MFA 绑定/验证流程的因子列表排序

**代码位置**: `packages/core/src/routes/experience/classes/helpers.ts:70-91`

```typescript
const order: MfaFactor[] = [
  MfaFactor.WebAuthn,              // 1. 最高优先级
  MfaFactor.TOTP,                  // 2. 
  MfaFactor.PhoneVerificationCode, // 3. ✅ Phone > Email
  MfaFactor.EmailVerificationCode, // 4. ✅
  MfaFactor.BackupCode,            // 5. 最低优先级（总是排在最后）
];

/**
 * Sort MFA factors by display priority to keep client experience consistent.
 * Order: WebAuthn -> TOTP -> Phone -> Email -> Backup code -> others.
 */
export const sortMfaFactors = (factors: MfaFactor[]): MfaFactor[] => {
  return factors.slice().sort((factorA, factorB) => {
    const indexA = order.indexOf(factorA);
    const indexB = order.indexOf(factorB);
    const normalizedIndexA = indexA === -1 ? order.length : indexA;
    const normalizedIndexB = indexB === -1 ? order.length : indexB;

    return normalizedIndexA - normalizedIndexB;
  });
};
```

**复核要点**:
- ✅ 代码注释明确写了显示顺序: `WebAuthn -> TOTP -> Phone -> Email -> Backup code`
- ✅ WebAuthn 总是排在最前
- ✅ **PhoneVerificationCode 优先级高于 EmailVerificationCode**
- ✅ BackupCode 总是排在最后
- ✅ 未知因子排在 BackupCode 之后

---

### 3.3 getAllUserEnabledMfaVerifications: 用户可用因子列表生成

> ✅ **适用范围**: 登录流程中获取用户当前可用的 MFA 验证因子列表
> 
> ⚠️ **关键差异**: 此流程中 Phone 和 Email 的相对顺序**不固定**，取决于 lastUsedAt 和因子类型（显式/隐式）

**代码位置**: `packages/core/src/routes/experience/classes/helpers.ts:249-308`

```typescript
export const getAllUserEnabledMfaVerifications = (
  mfaSettings: Mfa,
  user: User,
  currentProfile?: InteractionProfile
): MfaFactor[] => {
  // ========== Step 1: 获取已存储的显式验证因子 ==========
  const storedVerifications = filterOutEmptyBackupCodes(user.mfaVerifications)
    .filter((verification) => mfaSettings.factors.includes(verification.type))
    .filter((verification) => { /* 过滤掉已用完的备用码 */ })
    .slice()
    // Sort by priority:
    // 1) WebAuthn always first if available
    // 2) Backup code always last
    // 3) Otherwise by last used time (desc)
    .sort((verificationA, verificationB) => {
      // WebAuthn 到最前
      if (verificationA.type === MfaFactor.WebAuthn && verificationB.type !== MfaFactor.WebAuthn) {
        return -1;
      }
      if (verificationB.type === MfaFactor.WebAuthn && verificationA.type !== MfaFactor.WebAuthn) {
        return 1;
      }

      // BackupCode 到最后
      if (verificationA.type === MfaFactor.BackupCode) {
        return 1;
      }
      if (verificationB.type === MfaFactor.BackupCode) {
        return -1;
      }

      // ⚠️ 其他因子 (TOTP, Phone, Email) 按 lastUsedAt 降序排列
      // 最近使用的在前，Phone 和 Email 顺序不固定！
      return (
        new Date(verificationB.lastUsedAt ?? 0).getTime() -
        new Date(verificationA.lastUsedAt ?? 0).getTime()
      );
    })
    .map(({ type }) => type);

  // ========== Step 2: 获取隐式验证因子 ==========
  const implicitVerifications = getProfileMfaFactors(mfaSettings, {
    primaryEmail: currentProfile?.primaryEmail ?? user.primaryEmail,
    primaryPhone: currentProfile?.primaryPhone ?? user.primaryPhone,
  });

  // ========== Step 3: 合并与最终排序 ==========
  return [...storedVerifications, ...implicitVerifications].slice().sort((factorA, factorB) => {
    // 只确保 BackupCode 总是排到最后
    if (factorA === MfaFactor.BackupCode) {
      return 1;
    }
    if (factorB === MfaFactor.BackupCode) {
      return -1;
    }
    return 0;  // ⚠️ 其他保持原顺序，不做二次排序！
  });
};
```

**复核要点**:
- ✅ Step 1 只处理显式绑定的因子（存储在 `users.mfaVerifications` JSON 列中）
- ✅ Step 1 排序规则: WebAuthn 优先 → BackupCode 放最后 → **其余按 lastUsedAt 降序**
- ✅ Step 2 动态加入隐式因子（getProfileMfaFactors 返回顺序：Phone → Email）
- ✅ Step 3 最终排序**只确保 BackupCode 在最后**，其他因子保持原有顺序
- ✅ **重要结论**: 用户可用因子列表中，Phone 和 Email 的相对顺序不固定

---

### 3.4 隐式因子动态加入规则

#### 3.4.1 `getProfileMfaFactors()` 函数

**代码位置**: `packages/core/src/routes/experience/classes/helpers.ts:222-240`

```typescript
export const getProfileMfaFactors = (
  mfaSettings: Mfa,
  {
    primaryEmail,
    primaryPhone,
  }: {
    primaryEmail?: Nullable<string>;
    primaryPhone?: Nullable<string>;
  }
): MfaFactor[] => {
  return [
    // 条件1: SIE 启用了 PhoneVerificationCode 因子
    // 条件2: 用户有 primaryPhone 字段
    ...(mfaSettings.factors.includes(MfaFactor.PhoneVerificationCode) && primaryPhone
      ? [MfaFactor.PhoneVerificationCode]
      : []),
    // 条件1: SIE 启用了 EmailVerificationCode 因子
    // 条件2: 用户有 primaryEmail 字段  
    ...(mfaSettings.factors.includes(MfaFactor.EmailVerificationCode) && primaryEmail
      ? [MfaFactor.EmailVerificationCode]
      : []),
  ];
};
```

**复核要点**:
- ✅ **重要修正**: 隐式因子**不存储在数据库中**，每次动态计算
- ✅ 两个必要条件：SIE 启用该因子 + 用户有对应联系方式
- ✅ Phone 和 Email 各自独立判断
- ✅ 此函数返回固定顺序 Phone → Email，但 Step 1 结果可能打乱这个顺序

---

### 3.5 两个优先级流程对比表

| 特性 | sortMfaFactors | getAllUserEnabledMfaVerifications |
|-----|---------------|----------------------------------|
| **适用场景** | 纯因子列表排序（如配置页、绑定页） | 登录时获取用户可用验证因子 |
| **WebAuthn 位置** | 总是第1位 | 总是第1位 |
| **BackupCode 位置** | 总是最后 | 总是最后 |
| **TOTP 位置** | 固定第2位 | 相对位置取决于 lastUsedAt |
| **Phone vs Email 顺序** | ✅ Phone > Email (固定) | ⚠️ **不固定**，取决于 lastUsedAt 和显式/隐式类型 |
| **排序依据** | order 数组硬编码 | WebAuthn/BackupCode 固定 + 其余 lastUsedAt 降序 |
| **隐式因子处理** | 不处理，纯排序 | Step 2 动态加入 |

---

### 3.6 显式 vs 隐式因子对比表

| 因子类型 | 存储位置 | 绑定要求 | 动态加入 | sortMfaFactors 优先级 |
|---------|---------|---------|---------|---------------------|
| WebAuthn | `users.mfaVerifications` | 必须显式绑定 | ❌ 否 | 1 (最高) |
| TOTP | `users.mfaVerifications` | 必须显式绑定 | ❌ 否 | 2 |
| PhoneVerificationCode | 隐式: `users.primaryPhone` | 绑定手机号即可自动可用 | ✅ 是 | 3 |
| EmailVerificationCode | 隐式: `users.primaryEmail` | 绑定邮箱即可自动可用 | ✅ 是 | 4 |
| BackupCode | `users.mfaVerifications` | 必须显式绑定 | ❌ 否 | 5 (最低) |

---

## 4. 前端按错误码切换页面分支逻辑

### 4.1 核心错误处理器 Hook

**代码位置**: `packages/experience/src/hooks/use-mfa-error-handler.ts:1-164`

```typescript
// 错误码到处理函数的映射
const mfaVerificationErrorHandler = useMemo<ErrorHandlers>(() => ({
  // 用户未绑定任何 MFA，建议绑定 → 跳转到引导页
  'user.suggest_mfa': handleMfaError(UserMfaFlow.MfaBinding),
  
  // 用户缺少必需的 MFA 因子 → 跳转到绑定页
  'user.missing_mfa': handleMfaError(UserMfaFlow.MfaBinding),
  
  // 登录时需要二次认证 → 跳转到验证页
  'session.mfa.require_mfa_verification': handleMfaError(UserMfaFlow.MfaVerification),
  
  // 注册时建议绑定更安全的因子 → 跳转到绑定页(带suggestion标志)
  'session.mfa.suggest_additional_mfa': handleMfaError(UserMfaFlow.MfaBinding),
  
  // 需要绑定备用码 → 直接开始备用码绑定流程
  'session.mfa.backup_code_required': async () => startBackupCodeBinding(replace),
}), [handleMfaError, replace, startBackupCodeBinding]);
```

---

### 4.2 错误码详细映射表

| 错误码 | HTTP 状态 | 流向页面 | 流程类型 | skippable | 触发场景 | 代码位置 |
|--------|----------|---------|---------|-----------|---------|---------|
| `user.suggest_mfa` | 422 | `/mfa-onboarding` | 引导绑定 | - | 可选MFA策略下用户未绑定任何因子 | `mfa.ts:462` |
| `user.missing_mfa` | 422 | `/mfa-binding` | 强制/可选绑定 | 后端决定 | 用户缺少必需的MFA因子 | `mfa.ts:521-529` |
| `session.mfa.require_mfa_verification` | 403 | `/mfa-verification` | 登录验证 | ❌ false | 登录时要求MFA二次认证 | `experience-interaction.ts:393-402` |
| `session.mfa.suggest_additional_mfa` | 422 | `/mfa-binding` | 建议额外绑定 | ✅ true | 仅用邮箱/手机/Passkey注册时建议 | `mfa.ts:624-634` |
| `session.mfa.backup_code_required` | 422 | `/mfa-binding/BackupCode` | 备用码绑定 | ❌ false | SIE启用备用码但用户未绑定 | `mfa.ts:535-541` |

---

### 4.3 `handleMfaRedirect()` 重定向核心逻辑

**代码位置**: `packages/experience/src/hooks/use-mfa-error-handler.ts:49-111`

```typescript
const handleMfaRedirect = useCallback(
  async (flow: UserMfaFlow, state: MfaFlowState) => {
    const { availableFactors } = state;

    // ========== 分支1: 绑定流程 + 多因子 ==========
    if (availableFactors.length > 1 && flow === UserMfaFlow.MfaBinding) {
      navigate({ pathname: `/${UserMfaFlow.MfaBinding}` }, { replace, state });
      return;
    }

    // ========== 分支2: 单因子直接跳转 (验证流程多因子也走这里) ==========
    // 验证流程第一个因子是最近使用的，直接进入该因子验证页
    const factor = availableFactors[0];

    // 分支2a: TOTP 绑定 → 直接开始绑定流程
    if (factor === MfaFactor.TOTP && flow === UserMfaFlow.MfaBinding) {
      return startTotpBinding(state, replace);
    }

    // 分支2b: WebAuthn (绑定/验证) → 直接调用浏览器认证API
    if (factor === MfaFactor.WebAuthn) {
      return startWebAuthnProcessing(flow, state, replace);
    }

    // 分支2c: 邮箱/手机 MFA 验证 → 直接发送验证码
    if (factor === MfaFactor.EmailVerificationCode && flow === UserMfaFlow.MfaVerification) {
      return startMfaVerificationCodeProcessing(SignInIdentifier.Email, state);
    }
    if (factor === MfaFactor.PhoneVerificationCode && flow === UserMfaFlow.MfaVerification) {
      return startMfaVerificationCodeProcessing(SignInIdentifier.Phone, state);
    }

    // 分支2d: 其他情况 → 跳转到对应因子的具体页面
    navigate({ pathname: `/${flow}/${factor}` }, { replace, state });
  },
  [navigate, replace, startMfaVerificationCodeProcessing, startTotpBinding, startWebAuthnProcessing]
);
```

**复核要点**:
- ✅ 绑定流程：多因子 → 列表页；单因子 → 直接进入对应流程
- ✅ **验证流程：总是进入第一个因子（最近使用的）**，不经过列表页
- ✅ 第一个因子可能是 Phone 也可能是 Email，取决于用户最近使用记录
- ✅ TOTP/WebAuthn/邮箱/手机有特殊优化，直接调用对应 Hook 开始流程

---

### 4.4 MFA 流程状态对象

**代码位置**: `packages/experience/src/types/guard.ts`

```typescript
export type MfaFlowState = {
  availableFactors: MfaFactor[];              // 可用因子列表（已排序）
  skippable?: boolean;                         // 是否可跳过（绑定流程）
  maskedIdentifiers?: Record<MfaFactor, string>; // 掩码后的邮箱/手机号
  suggestion?: boolean;                        // 是否为建议性质
  isWebAuthnUsedAsSignInPasskey?: boolean;     // WebAuthn 是否用作 Passkey
};
```

---

### 4.5 前端页面路由结构

```
packages/experience/src/pages/
├── MfaOnboarding/              # user.suggest_mfa → 引导启用页
│   └── index.tsx
│
├── MfaBinding/                 # 绑定流程入口
│   ├── index.tsx               # 多因子选择列表页（按 sortMfaFactors 排序）
│   ├── TotpBinding/            # TOTP 绑定页
│   ├── WebAuthnBinding/        # WebAuthn 绑定页
│   ├── PhoneMfaBinding/        # 手机验证码绑定页
│   ├── EmailMfaBinding/        # 邮箱验证码绑定页
│   └── BackupCodeBinding/      # 备用码绑定页
│
└── MfaVerification/            # 验证流程入口
    ├── index.tsx               # 多因子选择列表页
    ├── TotpVerification/       # TOTP 验证页
    ├── WebAuthnVerification/   # WebAuthn 验证页
    ├── PhoneVerificationCode/  # 手机验证码验证页
    ├── EmailVerificationCode/  # 邮箱验证码验证页
    └── BackupCodeVerification/ # 备用码验证页
```

---

### 4.6 MFA 绑定列表页逻辑

**代码位置**: `packages/experience/src/pages/MfaBinding/index.tsx:1-34`

```typescript
const MfaBinding = () => {
  const flowState = useMfaFlowState();
  const skipMfa = useSkipMfa();
  const skipOptionalMfa = useSkipOptionalMfa();

  return (
    <SecondaryPageLayout
      title={flowState.suggestion ? 'mfa.add_another_mfa_factor' : 'mfa.add_mfa_factors'}
      description={flowState.suggestion ? 'mfa.add_another_mfa_description' : 'mfa.add_mfa_description'}
      // 只有 skippable=true 时才显示跳过按钮
      onSkip={conditional(
        flowState.skippable && (flowState.suggestion ? skipOptionalMfa : skipMfa)
      )}
    >
      <MfaFactorList flow={UserMfaFlow.MfaBinding} flowState={flowState} />
    </SecondaryPageLayout>
  );
};
```

**复核要点**:
- ✅ `suggestion` 标志区分"首次绑定"和"建议额外绑定"两种文案
- ✅ `skippable` 标志控制跳过按钮显示
- ✅ `skipOptionalMfa` vs `skipMfa` 两个不同 Hook 处理不同场景的跳过逻辑

---

## 5. 代码复核清单

### 5.1 组织策略与全局策略合并

| 序号 | 复核项 | 文件路径 | 行号 | 状态 |
|-----|-------|---------|-----|-----|
| 5.1.1 | 组织强制策略需要全局开关+单组织开关两级启用 | `core/src/routes/experience/classes/mfa.ts` | 651-659 | ⬜ |
| 5.1.2 | 组织强制会覆盖用户的跳过选择 | `core/src/routes/experience/classes/mfa.ts` | 505-511 | ⬜ |
| 5.1.3 | 三种策略属于不可跳过类型: Mandatory / *Mandatory 后缀 | `core/src/libraries/sign-in-experience/mfa-policy.ts` | 3-8 | ⬜ |
| 5.1.4 | PromptOnlyAtSignIn 策略在注册时不执行检查 | `core/src/routes/experience/classes/mfa.ts` | 482-488 | ⬜ |
| 5.1.5 | 错误码 user.missing_mfa 的 skippable 由"策略强制 OR 组织强制"决定 | `core/src/routes/experience/classes/mfa.ts` | 525-528 | ⬜ |

### 5.2 认证因子优先级与隐式因子

| 序号 | 复核项 | 文件路径 | 行号 | 状态 |
|-----|-------|---------|-----|-----|
| 5.2.1 | 枚举定义顺序: TOTP → WebAuthn → BackupCode → Email → Phone | `schemas/src/foundations/jsonb-types/sign-in-experience.ts` | 176-182 | ⬜ |
| 5.2.2 | sortMfaFactors 显示优先级: WebAuthn > TOTP > Phone > Email > BackupCode | `core/src/routes/experience/classes/helpers.ts` | 70-90 | ⬜ |
| 5.2.3 | sortMfaFactors 代码注释明确标注显示顺序 | `core/src/routes/experience/classes/helpers.ts` | 78-80 | ⬜ |
| 5.2.4 | getAllUserEnabledMfaVerifications: WebAuthn 总是最前 | `core/src/routes/experience/classes/helpers.ts` | 269-274 | ⬜ |
| 5.2.5 | getAllUserEnabledMfaVerifications: BackupCode 总是最后 | `core/src/routes/experience/classes/helpers.ts` | 277-282, 298-305 | ⬜ |
| 5.2.6 | getAllUserEnabledMfaVerifications: 其他因子按 lastUsedAt 降序 | `core/src/routes/experience/classes/helpers.ts` | 285-289 | ⬜ |
| 5.2.7 | 隐式因子动态加入: SIE启用 + 用户有primaryPhone/Email | `core/src/routes/experience/classes/helpers.ts` | 222-240 | ⬜ |
| 5.2.8 | 用户可用因子列表中 Phone/Email 相对顺序不固定 | `core/src/routes/experience/classes/helpers.ts` | 249-308 | ⬜ |
| 5.2.9 | Step 3 最终排序只确保 BackupCode 在最后，其他保持原顺序 | `core/src/routes/experience/classes/helpers.ts` | 298-307 | ⬜ |

### 5.3 前端错误码页面跳转

| 序号 | 复核项 | 文件路径 | 行号 | 状态 |
|-----|-------|---------|-----|-----|
| 5.3.1 | 5个MFA错误码映射到对应处理函数 | `experience/src/hooks/use-mfa-error-handler.ts` | 151-160 | ⬜ |
| 5.3.2 | 绑定流程多因子→列表页，单因子→直接进入 | `experience/src/hooks/use-mfa-error-handler.ts` | 53-58 | ⬜ |
| 5.3.3 | 验证流程总是直接进入第一个(最近使用的)因子 | `experience/src/hooks/use-mfa-error-handler.ts` | 60-65 | ⬜ |
| 5.3.4 | 第一个因子可能是 Phone 也可能是 Email，取决于 lastUsedAt | `core/src/routes/experience/classes/helpers.ts` | 285-289 | ⬜ |
| 5.3.5 | TOTP/WebAuthn/邮箱/手机有特殊直接启动逻辑 | `experience/src/hooks/use-mfa-error-handler.ts` | 75-95 | ⬜ |
| 5.3.6 | MfaBinding 页面根据 skippable 显示/隐藏跳过按钮 | `experience/src/pages/MfaBinding/index.tsx` | 27-29 | ⬜ |

---

## 修正汇总

### v2 (2026-05-16) - 优先级适用范围明确化

| 修正项 | 原描述 | 修正后描述 |
|-------|-------|-----------|
| 适用范围区分 | 未区分两个函数的不同适用范围 | 新增 3.3 节对比表，明确 sortMfaFactors 和 getAllUserEnabledMfaVerifications 的差异 |
| Phone/Email 顺序结论 | 统一说 Phone > Email | 修正：sortMfaFactors 中 Phone > Email；但用户可用因子列表中顺序不固定 |
| Step 3 排序逻辑 | 描述不完整 | 明确说明 Step 3 只确保 BackupCode 在最后，其他因子保持 Step 1+2 的合并顺序 |
| 复核清单扩展 | 5.2 节 8 项 | 扩展到 9 项，增加"其他保持原顺序"和"Phone/Email 顺序不固定"核对项 |

### v1 (2026-05-16) - 基础版本

| 修正项 | 原描述 | 修正后描述 |
|-------|-------|-----------|
| MfaFactor 枚举顺序 | 与显示顺序混淆 | 明确区分"枚举定义顺序"和"显示优先级顺序"两个概念 |
| Phone/Email 优先级 | 部分表格 Phone/Email 顺序不一致 | 统一为 Phone > Email（sortMfaFactors 场景） |
| 排序依据说明 | 只提到硬编码排序 | 补充说明 Step 1 中显式因子还会按 lastUsedAt 排序 |
| 3.5 表格显示优先级列 | Phone/Email 顺序颠倒 | 修正为 Phone 3，Email 4 |

---

**报告生成说明**:
- 本报告所有结论均基于 Logto v1.36.0 代码库
- 所有代码路径和行号均可直接在 IDE 中跳转复核
- 建议配合 `packages/integration-tests/src/tests/api/experience-api/bind-mfa/` 目录下的集成测试进行验证
