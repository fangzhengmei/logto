# Sign-in Experience 多分支渲染链路解析

## 全局总览

Sign-in Experience 的渲染是一个 **"配置驱动 + 路由分支 + 条件渲染"** 的三层协作系统：

```
后端配置 (DB)  →  API 聚合  →  前端 Context 注入  →  路由决策  →  页面组件  →  条件渲染子组件
```

核心问题：页面长什么样，不写在组件里，而是由后端下发的 `SignInExperience` 配置决定。前端组件只负责"根据配置选择渲染哪棵子树"。

---

## 一、配置加载：从后端到前端 Context

### 1.1 后端：`getFullSignInExperience` 组装完整配置

**入口**：[well-known/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/core/src/routes/well-known/index.ts#L45-L58)

```
GET /api/.well-known/sign-in-exp?organizationId=...&appId=...
```

**组装逻辑**：[sign-in-experience/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/core/src/libraries/sign-in-experience/index.ts#L222-L342)

`getFullSignInExperience` 并行拉取 6 份数据后合并：

| 数据源 | 用途 |
|--------|------|
| `findDefaultSignInExperience()` | 数据库中的默认 SIE 配置（登录方式、品牌、颜色等） |
| `getLogtoConnectors()` | 已安装的社交连接器 |
| `getIsDevelopmentTenant()` | 是否开发租户 |
| `getOrganizationOverride(organizationId)` | 组织级别的 SIE 覆盖 |
| `findApplicationSignInExperience(appId)` | 应用级别的 SIE 覆盖 |
| `findAllCustomProfileFields()` | 自定义 profile 字段 |

然后：
- 用 `deepmerge` 三层合并：`默认 SIE → 应用覆盖 → 组织覆盖`
- 按配置的 `socialSignInConnectorTargets` 筛选社交连接器，提取 `socialConnectors`
- 根据 `singleSignOnEnabled` 决定是否获取 `ssoConnectors`
- 计算忘记密码的可用方式 `forgotPassword`
- 提取 Google One Tap 配置 `googleOneTap`
- 提取 Captcha 配置 `captchaConfig`

**返回类型**：[`FullSignInExperience`](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/schemas/src/types/sign-in-experience.ts#L34-L63)

```typescript
type FullSignInExperience = Omit<SignInExperience, 'forgotPasswordMethods'> & {
  socialConnectors: ExperienceSocialConnector[];
  ssoConnectors: SsoConnectorMetadata[];
  forgotPassword: ForgotPassword;
  isDevelopmentTenant: boolean;
  googleOneTap?: GoogleOneTapConfig & { clientId: string; connectorId: string };
  captchaConfig?: { type: CaptchaType; siteKey: string; domain?: string; mode?: RecaptchaEnterpriseMode };
  customProfileFields?: Readonly<CustomProfileField[]>;
  customProfileFieldCatalog?: Readonly<CustomProfileField[]>;
};
```

前端拿到的是 [`SignInExperienceResponse`](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/shared/types/index.ts)，即 `Omit<FullSignInExperience, 'socialSignInConnectorTargets'>`。

### 1.2 前端：SettingsProvider 加载配置到 Context

**加载链路**：

```
App.tsx
  └─ PageContextProvider          ← 创建 experienceSettings 状态
       └─ SettingsProvider        ← 触发配置加载
            └─ useSignInExperience / usePreview
                 └─ getSignInExperienceSettings()
                      └─ getSignInExperience()   ← ky.get('/api/.well-known/sign-in-exp')
```

关键文件：
- [SettingsProvider](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/Providers/SettingsProvider/index.tsx#L12-L20)：根据 `isPreview` 选择数据源 hook，**配置未加载完成前不渲染子组件**（`experienceSettings ? children : null`）
- [useSignInExperience](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/Providers/SettingsProvider/use-sign-in-experience.ts)：并行初始化 i18n 和配置获取，先设置主题再设置配置（防止闪烁）
- [PageContextProvider](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/Providers/PageContextProvider/index.tsx)：维护 `experienceSettings` 状态，通过 React Context 分发

### 1.3 配置消费：`useSieMethods` 桥接配置与组件

[useSieMethods](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/hooks/use-sie.ts#L54-L142) 是整个渲染树的配置消费入口，它从 `PageContext.experienceSettings` 中派生出组件需要的所有渲染参数：

| 返回值 | 来源 | 渲染用途 |
|--------|------|----------|
| `signInMethods` | `experienceSettings.signIn.methods` 过滤空配置 | 决定显示 IdentifierSignInForm / PasswordSignInForm |
| `signUpMethods` | `experienceSettings.signUp.identifiers` | 注册表单的标识符选项 |
| `socialConnectors` | `experienceSettings.socialConnectors` | Social 登录按钮列表 |
| `ssoConnectors` | `experienceSettings.ssoConnectors` | SSO 连接器列表 |
| `signInMode` | `experienceSettings.signInMode` | 控制显示登录/注册/两者 |
| `singleSignOnEnabled` | `experienceSettings.singleSignOnEnabled` | 是否显示 SSO 入口 |
| `passkeySignIn` | `experienceSettings.passkeySignIn` | Passkey 按钮与自动填充 |
| `forgotPassword` | `experienceSettings.forgotPassword` | 忘记密码链接 |
| `customContent` | `experienceSettings.customContent` | 自定义 HTML 侧边栏 |
| `socialSignInSettings` | `experienceSettings.socialSignIn` | 社交登录行为（自动关联等） |

`signInMethods` 的过滤逻辑值得注意：

```typescript
const signInMethods = experienceSettings?.signIn.methods.filter(
  ({ password, verificationCode }) => password || verificationCode
) ?? [];
```

即只有 **password 或 verificationCode 至少开启一个** 的 method 才被视为有效。这防止了后端配置出现"既无密码又无验证码"的空壳 method 进入渲染树。

---

## 二、路由决策：两套首页体系

### 2.1 路由定义

[App.tsx](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/App.tsx#L83-L213) 中定义了两类首页路由：

| 路由 | 组件 | 用途 |
|------|------|------|
| `/sign-in` | `SignIn` | **全功能登录首页**，展示所有配置的登录方式 |
| `/sign-in/password` | `SignInPassword` | 密码登录子页面 |
| `/sign-in/passkey` | `SignInPasskeyVerification` | Passkey 验证子页面 |
| `/sign-in/verification-methods` | `SignInVerificationMethods` | 选择验证方式 |
| `/identifier-sign-in` | `IdentifierSignIn` | **聚焦登录首页**，仅展示指定标识符的登录方式 |
| `/register` | `Register` | 全功能注册首页 |
| `/identifier-register` | `IdentifierRegister` | 聚焦注册首页 |
| `/direct/:method/:target` | `DirectSignIn` | 直接跳转社交/SSO 登录 |
| `/single-sign-on/*` | SSO 系列页面 | SSO 邮箱输入/连接器选择/落地页 |

路由常量来自 [`experience.routes`](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/schemas/src/consts/experience.ts#L1-L16)。

### 2.2 两套首页的设计意图

- **全功能首页** (`/sign-in`, `/register`)：展示管理员配置的所有登录方式，是默认落地页
- **聚焦首页** (`/identifier-sign-in`, `/identifier-register`)：通过 URL 参数 `first_screen=identifier:sign_in` 或 `identifier=email+phone` 精确控制显示哪些标识符的登录方式，适用于嵌入式场景

### 2.3 AppLayout：页面外壳

所有主页面都包裹在 [AppLayout](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/Layout/AppLayout/index.tsx#L13-L34) 中：

```
AppLayout
  ├── CustomContent（左侧/桌面端自定义 HTML 侧边栏，按路由路径匹配 customContent[pathname]）
  ├── <Outlet />（当前路由页面）
  └── LogtoSignature（可选品牌标识）
```

`CustomContent` 使用 `dangerouslySetInnerHTML` 渲染后端配置的 `customContent[pathname]`，实现了按路由插入自定义 HTML 的能力。

---

## 三、登录首页的分支渲染

### 3.1 SignIn 页面入口

[SignIn](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignIn/index.tsx#L104-L143) 的分支逻辑：

```
SignIn
  ├─ signInMode 为空？ → ErrorPage
  ├─ signInMode === Register？ → Navigate("/register")
  ├─ URL 含 oneTimeToken？ → Navigate("/one-time-token")
  └─ 正常渲染：
       ├─ LandingPageLayout（品牌 Header + 标题）
       │    ├─ GoogleOneTap
       │    ├─ WebAuthnContextProvider
       │    │    └─ SingleSignOnFormModeContextProvider
       │    │         ├─ Main（核心表单）
       │    │         └─ SignInFooters（底部链接）
       │    └─ TermsAndPrivacyLinks
       └─ （Mobile/桌面端区分由 FirstScreenLayout 根据 platform 处理）
```

### 3.2 Main 组件：三路分支

[Main](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignIn/Main.tsx#L18-L53) 根据 `signInMethods` 和 `socialConnectors` 做三路分支：

```
Main(signInMethods, socialConnectors)
  ├─ signInMethods 为空 && socialConnectors 不为空
  │    → SocialSignInList（仅社交登录按钮 + 条款勾选）
  │
  ├─ isPasswordOnly（所有 method 都只开 password，且非 passkey 优先模式）
  │    → PasswordSignInForm（标识符 + 密码表单）
  │
  └─ signInMethods 不为空
       → IdentifierSignInForm（智能标识符输入表单）
```

**`isPasswordOnly` 判定逻辑**（来自 [useIdentifierSignInMethods](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/IdentifierSignIn/use-identifier-sign-in-methods.ts#L41-L47)）：

```typescript
const isPasswordOnly = signInMethods.length > 0
  && signInMethods.every(({ password, verificationCode }) => password && !verificationCode)
  && !isIdentifierFirstPasskeySignInConfig;
```

即：所有有效 method 都开启密码且关闭验证码，且不是"passkey 启用但隐藏按钮"模式 → 直接显示密码表单，跳过标识符先行输入。

### 3.3 SignInFooters：底部链接分支

[SignInFooters](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignIn/index.tsx#L26-L102) 的渲染逻辑：

```
SignInFooters
  ├─ showSingleSignOnForm？ → null（SSO 模式时隐藏所有 footer）
  ├─ singleSignOnEnabled？ → SSO 链接 + 条款勾选（仅 SSO 场景）
  ├─ signInMode === SignInAndRegister && signUpMethods.length > 0？
  │    → "创建账号" 链接
  ├─ signInMethods.length > 0 && socialConnectors.length > 0？
  │    → 分隔线 + SocialSignInList（社交按钮列表）
  └─ passkeySignIn.enabled && passkeySignIn.showPasskeyButton？
       → PasskeySignInButton
```

---

## 四、核心表单组件的渲染细节

### 4.1 IdentifierSignInForm：智能标识符输入

[IdentifierSignInForm](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/components/IdentifierSignInForm/index.tsx#L35-L178)

**输入控件**：`SmartInputField` — 根据用户输入自动推断标识符类型

```
SmartInputField
  ├─ enabledTypes = signInMethods.map(({ identifier }) => identifier)
  ├─ 输入内容变化 → detectIdentifierType() 自动切换 Email/Phone/Username
  ├─ Phone 模式 → 显示 CountryCodeSelector（国家码前缀）
  ├─ Email 模式 → 正常文本输入
  └─ Username 模式 → 正常文本输入
```

**提交后分支**（[useOnSubmit](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/components/IdentifierSignInForm/use-on-submit.ts#L35-L96)）：

```
onSubmit(identifier, value)
  ├─ 查找 method = signInMethods.find(m => m.identifier === identifier)
  ├─ identifier === Email && ssoConnectors.length > 0？
  │    └─ checkSingleSignOn(email) → 若命中 SSO，跳转 SSO 流程
  ├─ passkeySignIn.enabled？
  │    └─ startIdentifierPasskeySignInProcessing → 若 passkey 成功，直接完成
  ├─ identifier === Username？
  │    └─ Navigate("/sign-in/password")（用户名只能密码登录）
  ├─ password && (isPasswordPrimary || !verificationCode)？
  │    └─ Navigate("/sign-in/password")
  └─ verificationCode？
       └─ sendVerificationCode → 跳转验证码页面
```

**SSO 实时监测**：[useSingleSignOnWatch](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/hooks/use-single-sign-on-watch.ts#L21-L137)

当用户输入邮箱时，以 300ms 防抖调用 `/api/experience/sso-connectors` 检查该邮箱是否关联 SSO 连接器。若命中：
- `showSingleSignOnForm` 设为 `true`
- 表单按钮文案变为 "Single Sign On"
- 密码输入框隐藏
- 提交时走 SSO 流程而非普通登录

### 4.2 PasswordSignInForm：密码登录

[PasswordSignInForm](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/components/PasswordSignInForm/index.tsx#L38-L196)

与 IdentifierSignInForm 类似但始终显示密码字段，并额外渲染：
- 忘记密码链接（根据 `forgotPassword` 配置决定是否显示）
- SSO 实时监测（同上）

### 4.3 SocialSignInList：社交登录按钮列表

[SocialSignInList](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/containers/SocialSignInList/index.tsx#L17-L50)

遍历 `socialConnectors` 数组，为每个连接器渲染 `SocialLinkButton`：
- Logo：根据主题选择 `logo` / `logoDark`
- 点击：调用 `invokeSocialSignIn(connector)` → 跳转 OAuth 授权链接

---

## 五、IdentifierSignIn 聚焦首页

[IdentifierSignIn](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/IdentifierSignIn/index.tsx#L25-L59) 与全功能首页的区别：

| 特性 | SignIn (全功能) | IdentifierSignIn (聚焦) |
|------|----------------|------------------------|
| 布局 | `LandingPageLayout` | `FocusedAuthPageLayout` |
| 标识符范围 | 配置中的所有 signInMethods | URL `identifier` 参数与配置的交集 |
| 无 method 时 | 显示 Social 列表 | Navigate 回 `/sign-in` |
| 底部 | Social 按钮 / SSO / 注册链接 | "查看所有登录选项" 链接 |
| 标题 | 固定文案 | 动态描述可用标识符类型 |

标识符交集逻辑（[useIdentifierSignInMethods](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/IdentifierSignIn/use-identifier-sign-in-methods.ts#L15-L58)）：

```
URL identifiers 非空？
  ├─ 是 → 取 URL identifiers ∩ 配置 signInMethods
  │       └─ 交集为空？ → 回退到全部 signInMethods
  └─ 否 → 使用全部 signInMethods
```

---

## 六、配置数据结构关键字段

### 6.1 `SignIn.methods[]`

[signInGuard](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/schemas/src/foundations/jsonb-types/sign-in-experience.ts#L133-L144)

```typescript
{
  identifier: SignInIdentifier,  // 'username' | 'email' | 'phone'
  password: boolean,             // 是否启用密码登录
  verificationCode: boolean,     // 是否启用验证码登录
  isPasswordPrimary: boolean,    // 密码是否为首选方式
}
```

这个数组是渲染分支的核心数据源：每个元素代表一种标识符下的登录方式组合。

### 6.2 `SignInMode`

数据库枚举（[sign_in_experiences.sql](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/schemas/tables/sign_in_experiences.sql)）：

| 值 | 效果 |
|----|------|
| `SignIn` | 仅登录，访问 `/register` 时自动跳转 `/sign-in` |
| `Register` | 仅注册，访问 `/sign-in` 时自动跳转 `/register` |
| `SignInAndRegister` | 登录注册都可用，首页互相链接 |

### 6.3 `PasskeySignIn`

[PasskeySignIn](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/schemas/src/foundations/jsonb-types/sign-in-experience.ts#L356-L360)

```typescript
{
  enabled?: boolean,          // 全局 Passkey 开关
  showPasskeyButton?: boolean, // 是否在首页显示 Passkey 按钮
  allowAutofill?: boolean,    // 是否允许浏览器自动填充 Passkey
}
```

`showPasskeyButton` 影响 `isPasswordOnly` 的判定：当 `enabled=true` 但 `showPasskeyButton=false` 时，系统采用"标识符先行 → 再选 passkey/密码"的两步流程，此时即使只有密码方式也不能直接显示密码表单。

### 6.4 `SignInIdentifier`

[SignInIdentifier](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/schemas/src/foundations/jsonb-types/sign-in-experience.ts#L44-L48)

```typescript
enum SignInIdentifier {
  Username = 'username',
  Email = 'email',
  Phone = 'phone',
}
```

---

## 七、完整渲染决策树

```
用户访问 /sign-in
  │
  ├─ [SettingsProvider] experienceSettings 未加载？ → 不渲染（白屏等待）
  │
  ├─ [SignIn] signInMode 判断
  │    ├─ undefined → ErrorPage
  │    ├─ Register → Navigate("/register")
  │    └─ SignIn / SignInAndRegister → 继续
  │
  ├─ [Main] 三路分支
  │    ├─ 仅社交 → SocialSignInList
  │    ├─ 仅密码 → PasswordSignInForm
  │    │    └─ [SmartInputField] → 自动推断标识符类型
  │    └─ 混合 → IdentifierSignInForm
  │         └─ [SmartInputField] → 自动推断标识符类型
  │
  ├─ [SignInFooters] 条件链接
  │    ├─ SSO 链接（singleSignOnEnabled）
  │    ├─ 创建账号链接（SignInAndRegister 模式）
  │    ├─ 社交按钮列表（有 identifier 方法 + 有社交连接器时）
  │    └─ Passkey 按钮（passkeySignIn.enabled && showPasskeyButton）
  │
  └─ 提交后路由（useOnSubmit）
       ├─ SSO 检测 → 跳转 SSO 流程
       ├─ Passkey 尝试 → 直接完成或降级
       ├─ 密码优先 → /sign-in/password
       ├─ 验证码 → /sign-in/verification-code
       └─ 用户名 → /sign-in/password
```

---

## 八、关键文件索引

| 层级 | 文件 | 职责 |
|------|------|------|
| 后端 API | [well-known/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/core/src/routes/well-known/index.ts#L45-L58) | SIE 配置端点 |
| 后端组装 | [sign-in-experience/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/core/src/libraries/sign-in-experience/index.ts#L222-L342) | 合并默认/应用/组织配置 |
| Schema | [sign-in-experience.ts (jsonb)](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/schemas/src/foundations/jsonb-types/sign-in-experience.ts) | 数据类型与校验 |
| Schema | [sign-in-experience.ts (types)](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/schemas/src/types/sign-in-experience.ts#L34-L63) | FullSignInExperience 类型 |
| Schema | [experience.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/schemas/src/consts/experience.ts#L1-L16) | 路由常量 |
| 前端入口 | [App.tsx](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/App.tsx#L64-L224) | 路由定义 |
| 配置加载 | [SettingsProvider](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/Providers/SettingsProvider/index.tsx#L12-L20) | 加载并注入配置 |
| 配置获取 | [settings.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/apis/settings.ts#L28-L38) | API 调用封装 |
| 配置工具 | [sign-in-experience.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/utils/sign-in-experience.ts) | SSR 降级 + 社交连接器过滤 |
| Context | [PageContext](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/Providers/PageContextProvider/PageContext.tsx) | 全局状态容器 |
| 配置消费 | [use-sie.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/hooks/use-sie.ts#L54-L142) | 派生渲染参数 |
| 登录首页 | [SignIn/index.tsx](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignIn/index.tsx#L104-L143) | 登录首页路由组件 |
| 三路分支 | [SignIn/Main.tsx](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignIn/Main.tsx#L18-L53) | 表单类型选择 |
| 聚焦首页 | [IdentifierSignIn](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/IdentifierSignIn/index.tsx#L25-L59) | 标识符聚焦登录 |
| 方法筛选 | [use-identifier-sign-in-methods.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/IdentifierSignIn/use-identifier-sign-in-methods.ts) | URL 参数与配置交集 |
| 标识符表单 | [IdentifierSignInForm](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/components/IdentifierSignInForm/index.tsx) | 智能标识符 + 条件提交 |
| 密码表单 | [PasswordSignInForm](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/components/PasswordSignInForm/index.tsx) | 标识符 + 密码 |
| 提交分支 | [use-on-submit.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/components/IdentifierSignInForm/use-on-submit.ts#L35-L96) | 密码/验证码/Passkey/SSO 路由 |
| SSO 监测 | [use-single-sign-on-watch.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/hooks/use-single-sign-on-watch.ts) | 实时检测邮箱 SSO |
| 社交按钮 | [SocialSignInList](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/containers/SocialSignInList/index.tsx) | 渲染社交登录按钮 |
| 智能输入 | [SmartInputField](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/shared/components/InputFields/SmartInputField/index.tsx) | 自动推断标识符类型 |
| 输入逻辑 | [use-smart-input-field.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/shared/components/InputFields/SmartInputField/use-smart-input-field.ts) | 输入状态管理 |
| 直接登录 | [DirectSignIn](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/DirectSignIn/index.tsx) | URL 驱动的社交/SSO 跳转 |
| 注册首页 | [Register](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/Register/index.tsx) | 全功能注册页 |
| 页面外壳 | [AppLayout](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/Layout/AppLayout/index.tsx) | 自定义内容 + 页面 + 签名 |
| 自定义内容 | [CustomContent](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/Layout/AppLayout/CustomContent.tsx) | 按路由路径渲染自定义 HTML |
