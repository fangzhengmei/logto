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

## 九、登录方式选择的深度分析

本章聚焦三个问题：**URL 标识符过滤的传输与生效链路**、**`isPasswordOnly` 与 `isPasswordPrimary` 的协同机制**、**配置组合 → 表单输出 → 提交后路由**的完整映射真值表。

### 9.1 URL 参数传递与标识符过滤的完整链路

URL 参数在登录流程中扮演"外部引导器"的角色，涉及四类参数：`first_screen`（路由选择）、`identifier`（标识符过滤）、`login_hint`（预填）、`organization_id`/`app_id`（配置覆盖）。

#### 9.1.1 URL 参数的生命周期

[`handleSearchParametersData()`](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/shared/utils/search-parameters.ts#L23-L56) 在 App 启动时（App.tsx L62）立即执行，作为 URL 参数处理的第一道关：

```
浏览器 URL: ?organization_id=xxx&app_id=yyy&ui_locales=en&login_hint=user@example.com
                                        |
                                        v
                handleSearchParametersData()
                  ├─ 已知 key（organization_id / app_id / ui_locales）：
                  │     ├─ 存入 sessionStorage
                  │     └─ 从 URL 中移除（保留 app_id 用于会话恢复）
                  ├─ 未知 key（identifier / login_hint / first_screen / one_time_token 等）：
                  │     └─ 保留在 URL 中，由各 hook 按需读取
                  └─ replaceState 更新浏览器地址栏
```

这些被 `searchKeys` 捕获的参数会在调用 `/api/.well-known/sign-in-exp` 时通过 query 传递（参见 [apis/settings.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/apis/settings.ts#L28-L38)）：

```typescript
ky.get('/api/.well-known/sign-in-exp', {
  searchParams: {
    organizationId: sessionStorage.getItem('organization_id'),
    appId: sessionStorage.getItem('app_id'),
    uiLocales: sessionStorage.getItem('ui_locales'),
  }
})
```

后端的 [`getFullSignInExperience`](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/core/src/libraries/sign-in-experience/index.ts#L222-L342) 使用这些参数做三层 deepmerge：

```
默认 SIE 配置 → 应用覆盖（appId 对应的 app_sign_in_experiences） → 组织覆盖（organizationId 对应的 organization_sign_in_experiences）
```

#### 9.1.2 `first_screen` 路由映射

[`FirstScreen` 枚举](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/schemas/src/consts/oidc.ts#L88-L97) 与 React Router 路由的对应关系：

| `first_screen` 值 | 实际路由 | 页面组件 |
|-------------------|----------|----------|
| `sign_in` | `/sign-in` | `SignIn` |
| `register` | `/register` | `Register` |
| `reset_password` | `/reset-password` | `ResetPasswordLanding` |
| `identifier:sign_in` | `/identifier-sign-in` | `IdentifierSignIn` |
| `identifier:register` | `/identifier-register` | `IdentifierRegister` |
| `single_sign_on` | `/single-sign-on` | `SingleSignOnLanding` |
| `signIn` (deprecated) | `/sign-in` | `SignIn` |

**前端如何读取 first_screen？** 实际上前端 **不直接** 根据 `first_screen` 做路由！OIDC 授权请求的 `first_screen` 参数由 **后端 OIDC 中间件**在重定向到体验页时，将其转换为对应的路由路径 URL。前端只处理浏览器当前已经到达的路径。

#### 9.1.3 `identifier` 参数的生效链路

`identifier` 参数（如 `?identifier=email+phone`）只在聚焦首页生效，使用 **hook 级** 的交集逻辑，而非修改全局配置。

[`useIdentifierParams`](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/hooks/use-identifier-params.ts#L31-L37) 读取 URL 参数：

```typescript
const { identifiers } = useIdentifierParams();
// 内部：parseIdentifierParamValue(searchParams.get('identifier') ?? '')
//   按空格切分 → signInIdentifierGuard.safeParse 逐一校验 → 过滤非法值
```

然后在 [`useIdentifierSignInMethods`](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/IdentifierSignIn/use-identifier-sign-in-methods.ts#L20-L34) 中做交集：

```typescript
const methods = useMemo(() => {
  if (identifiers.length === 0) {
    return signInMethods;  // 未传 identifier → 用全部配置
  }

  const filtered = signInMethods.filter(
    ({ identifier }) => identifiers.includes(identifier)
  );

  // 交集为空 → 回退到全部配置（防止参数错误时页面空白）
  if (filtered.length === 0) {
    return signInMethods;
  }

  return filtered;
}, [identifiers, signInMethods]);
```

**重要**：URL 过滤只作用于 `methods` 数组，不影响其它配置（如 socialConnectors、ssoConnectors、passkey 等）。因此在 IdentifierSignIn 页面上仍然可以通过 footer 的 "所有登录选项" 回到 `/sign-in` 看到完整配置。

#### 9.1.4 `login_hint` 预填的生效链路

[`usePrefilledIdentifier`](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/hooks/use-prefilled-identifier.ts#L55-L87) 的优先级：

```
SmartInputField 的默认值来源：
  1. 缓存值（UserInteractionContext.identifierInputValue）且类型在 enabledTypes 中
  2. URL 中的 login_hint 参数
  3. 空字符串

实际代码：
  cachedInputIdentifier = (上次用户输入的值 ∩ enabledTypes) ?? undefined
  prefilled = cachedInputIdentifier ?? { value: loginHint ?? '' }
```

这个 hook 被 `IdentifierSignInForm`（[L47-L49](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/components/IdentifierSignInForm/index.tsx#L47-L49)）和 `PasswordSignInForm`（[L46](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/components/PasswordSignInForm/index.tsx#L46)）使用。

### 9.2 `isPasswordOnly` 与 `isPasswordPrimary` 的本质差异

登录方式选择中，**两个布尔变量** 决定了表单输出的形态。它们作用于不同层级、服务于不同目标：

| 维度 | `isPasswordOnly` | `isPasswordPrimary` |
|------|-----------------|---------------------|
| **作用层级** | 页面级（`Main` 组件选择哪个表单） | method 级（提交后选择哪个验证方式） |
| **作用域** | 所有 method 的组合判断 | 单个 method 的内部判断 |
| **控制范围** | 首次渲染表单类型 | 用户点击提交后的路由 |
| **数据源** | 所有 method 的 `password` 和 `verificationCode` 字段 | 单个 method 的 `password`、`verificationCode`、`isPasswordPrimary` 字段 |
| **额外条件** | 需排除 passkey 两步流程模式 | 无需额外条件 |
| **代码位置** | [use-identifier-sign-in-methods.ts L41-L47](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/IdentifierSignIn/use-identifier-sign-in-methods.ts#L41-L47) | [use-on-submit.ts L76-L84](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/components/IdentifierSignInForm/use-on-submit.ts#L76-L84) |

#### 9.2.1 `isPasswordOnly`：决定首屏表单类型

```typescript
// 页面级
const isPasswordOnly = signInMethods.length > 0
  // 条件 A：所有 method 都启用 password
  && signInMethods.every(({ password }) => password === true)
  // 条件 B：所有 method 都禁用 verificationCode
  && signInMethods.every(({ verificationCode }) => verificationCode === false)
  // 条件 C：不是 "passkey 两步流程" 模式
  && !isIdentifierFirstPasskeySignInConfig;

// passkey 两步流程：passkey 已启用但不显示按钮 → 用户需先输入标识符，再在下一步选择 passkey/密码
const isIdentifierFirstPasskeySignInConfig =
  passkeySignIn?.enabled && !passkeySignIn.showPasskeyButton;
```

**效果**：`isPasswordOnly = true` → `Main` 渲染 `PasswordSignInForm`（首屏直接显示密码框），否则渲染 `IdentifierSignInForm`（首屏只显示标识符框）。

#### 9.2.2 `isPasswordPrimary`：决定提交后的默认验证方式

```typescript
// method 级，在 useOnSubmit 中执行
const { password, isPasswordPrimary, verificationCode } = method;

// 注意：这个判断是针对单个 method（当前用户输入的标识符类型对应的配置）
if (password && (isPasswordPrimary || !verificationCode)) {
  // 密码优先 或 只有密码 → 跳到密码页
  navigate("/sign-in/password");
} else if (verificationCode) {
  // 验证码优先 或 只有验证码 → 发验证码并跳转
  await sendVerificationCode({ identifier, value });
}
```

**`isPasswordPrimary` 的真实含义**：当 **password 和 verificationCode 同时启用** 时，哪个作为**首选**。如果只有其中一个，则直接走有的那个，`isPasswordPrimary` **不参与**判断。

```
真值表（单个 method 内）：
password  verificationCode  isPasswordPrimary  →  提交后路由
   T              T              T              →  /sign-in/password（密码优先）
   T              T              F              →  验证码（验证码优先）
   T              F              *              →  /sign-in/password（只有密码）
   F              T              *              →  验证码（只有验证码）
   F              F              *              →  （被 useSieMethods 过滤，不可能到达）
```

### 9.3 配置组合到表单输出的完整真值表

以下真值表从"后端 `signIn.methods[]` 配置"出发，推导页面级的 `isPasswordOnly` 判定、首屏表单类型、提交后的路由。

#### 前置约定

- 假设 passkey 配置为 `{ enabled: false }`（即 `isIdentifierFirstPasskeySignInConfig = false`），否则所有 case 都强制走 IdentifierSignInForm
- `methods[].isPasswordPrimary` 简写为 `PP`
- 对每个 method，`password` 简写为 `P`，`verificationCode` 简写为 `VC`

#### 情形一：单一标识符 + 单一验证方式

| 配置 methods | PP | `isPasswordOnly` | 首屏表单 | 用户输入 → 提交后路由 |
|-------------|-----|-----------------|----------|----------------------|
| `[{email, P=T, VC=F}]` | T | ✅ true | **PasswordSignInForm**（Email + 密码框） | email + 密码 → 直接提交 |
| `[{email, P=F, VC=T}]` | F | ❌ false | **IdentifierSignInForm**（Email 框） | email → 发送验证码 → `/sign-in/verification-code` |
| `[{username, P=T, VC=F}]` | T | ✅ true | **PasswordSignInForm**（Username + 密码框） | username + 密码 → 直接提交 |
| `[{phone, P=F, VC=T}]` | F | ❌ false | **IdentifierSignInForm**（Phone 框） | phone → 发送验证码 → `/sign-in/verification-code` |

**观察**：用户名不能用验证码，所以 username + `VC=T` 的配置在 `useSieMethods` 过滤后仍保留 `P` 的实际能力。但提交后 `Username` **强制走密码**（[use-on-submit.ts L70-L74](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/components/IdentifierSignInForm/use-on-submit.ts#L70-L74)），忽略 VC 和 PP 的值。

#### 情形二：单一标识符 + 双验证方式（密码和验证码都开启）

| 配置 methods | PP | `isPasswordOnly` | 首屏表单 | 用户输入 → 提交后路由 |
|-------------|-----|-----------------|----------|----------------------|
| `[{email, P=T, VC=T}]` | T | ❌ false | **IdentifierSignInForm** | email → 密码优先 → `/sign-in/password` |
| `[{email, P=T, VC=T}]` | F | ❌ false | **IdentifierSignInForm** | email → 验证码优先 → `/sign-in/verification-code` |
| `[{phone, P=T, VC=T}]` | T | ❌ false | **IdentifierSignInForm** | phone → 密码优先 → `/sign-in/password` |
| `[{phone, P=T, VC=T}]` | F | ❌ false | **IdentifierSignInForm** | phone → 验证码优先 → `/sign-in/verification-code` |

**关键观察**：只要 **任一 method 有 VC=T**，`isPasswordOnly` 即为 false → 首屏一定是 IdentifierSignInForm（标识符先行）。此时：
- 密码页和验证码页之间可以通过 `SwitchToVerificationMethodsLink` 互相跳转
- `/sign-in/verification-methods` 列出全部三种方式（Passkey + 密码 + 验证码），当方式数 > 2 时显示

#### 情形三：多标识符 + 不同验证方式组合

| 配置 methods | PP(per) | `isPasswordOnly` | 首屏表单 | 用户输入 → 提交后路由 |
|-------------|---------|-----------------|----------|----------------------|
| `[{email,P=T,VC=F}, {phone,P=T,VC=F}]` | T,T | ✅ true | **PasswordSignInForm**（智能标识符 + 密码框） | auto → 直接提交密码 |
| `[{email,P=T,VC=F}, {phone,P=T,VC=T}]` | T,F | ❌ false | **IdentifierSignInForm** | email → 密码<br>phone → 验证码 |
| `[{email,P=T,VC=T}, {phone,P=T,VC=T}]` | T,F | ❌ false | **IdentifierSignInForm** | email → 密码优先<br>phone → 验证码优先 |
| `[{email,P=T,VC=F}, {username,P=T,VC=F}]` | T,T | ✅ true | **PasswordSignInForm** | auto → 直接提交密码 |
| `[{username,P=T,VC=F}, {email,P=F,VC=T}]` | T,- | ❌ false | **IdentifierSignInForm** | username → 密码（强制）<br>email → 验证码 |

**多标识符下的 `isPasswordOnly` 判定**：只有 **全部** method 都是 `P=T, VC=F` 才成立。只要有一个 method 开启了 VC，整页就降级为 IdentifierSignInForm。即使大部分标识符都是纯密码模式，一个例外就足以改变整个页面的首屏布局。

#### 情形四：URL identifier 参数过滤后的方法集

假设后端配置：`[{email,P=T,VC=T}, {phone,P=T,VC=T}, {username,P=T,VC=F}]`，PP 全部为 T。

| URL 参数 | 过滤后 methods | `isPasswordOnly` | 首屏表单 |
|----------|---------------|-----------------|----------|
| （无） | email + phone + username | ❌ false（email/phone 有 VC） | IdentifierSignInForm |
| `?identifier=email` | `[{email,P=T,VC=T}]` | ❌ false（email 有 VC） | IdentifierSignInForm |
| `?identifier=username` | `[{username,P=T,VC=F}]` | ✅ true | PasswordSignInForm |
| `?identifier=email+phone` | email + phone（都有 VC） | ❌ false | IdentifierSignInForm |
| `?identifier=username+email` | username + email（email 有 VC） | ❌ false | IdentifierSignInForm |
| `?identifier=invalid` | 回退：全部 3 个 | ❌ false | IdentifierSignInForm |

**注意 `?identifier=username` 这一行**：原来全局有 email/phone 的 VC，导致 `isPasswordOnly=false`。但 URL 过滤后只剩下 username（纯密码），此时 `isPasswordOnly=true` → 页面从 IdentifierSignInForm 切换为 PasswordSignInForm。URL 过滤不仅改变了可选标识符的范围，**还能改变首屏表单的类型**。

### 9.4 验证方式间的切换机制

首屏提交后，用户进入 **第二屏验证**。第二屏底部的 [`SwitchToVerificationMethodsLink`](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/components/SwitchToVerificationMethodsLink/index.tsx#L30-L73) 提供了验证方式间的互跳：

```
判断逻辑（按优先级）：
  1. 可用方式 > 2 种 → 显示 "尝试其它验证方式" 链接 → 跳转 /sign-in/verification-methods
  2. 可用方式 = 2 种 → 直接显示跳转链接（不在当前页的那种方式）
       ├─ 有 passkey → PasskeySignInLink
       ├─ 有 password 且当前不在 /sign-in/password → PasswordSignInLink
       └─ 有 verificationCode 且当前不在验证码页 → VerificationCodeLink
  3. 只有 1 种 → 不显示任何链接
```

其中 `/sign-in/verification-methods` 页面（[SignInVerificationMethods](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignInVerificationMethods/index.tsx#L30-L94)）为每种可用方式渲染一张卡片，卡片的可见性规则：

| 卡片 | 显示条件 |
|------|----------|
| Passkey | `passkeySignIn.enabled && hasBoundPasskey`（用户有绑定的 passkey） |
| 密码 | `methodSetting.password === true` |
| 邮箱验证码 | `methodSetting.verificationCode === true && type === Email` |
| 短信验证码 | `methodSetting.verificationCode === true && type === Phone` |

`hasBoundPasskey` 来自 `UserInteractionContext`，是在用户输入标识符后通过 API 检查是否绑定了 passkey。这解释了为什么 passkey 两步流程需要先输入标识符——**只有确定了用户身份，才能知道有没有 passkey 可用**。

### 9.5 数据流全景图：从配置到 UI 再到交互后路由

```
后端 DB: sign_in_experiences.sign_in.methods[]
  │
  ├─ GET /api/.well-known/sign-in-exp
  │    └─ getFullSignInExperience() → FullSignInExperience
  │         └─ 合并默认/应用/组织配置，附加 socialConnectors / ssoConnectors / forgotPassword
  │
  ▼
前端: SettingsProvider → setExperienceSettings() → PageContext.experienceSettings
  │
  ├─ useSieMethods()
  │    ├─ signInMethods = 过滤空配置后的 methods[]
  │    ├─ signInMode
  │    ├─ socialConnectors, ssoConnectors, passkeySignIn, forgotPassword
  │    └─ ...
  │
  ▼
路由组件: SignIn / IdentifierSignIn
  │
  ├─ useIdentifierSignInMethods()
  │    ├─ 若 URL 有 identifier 参数 → methods = URL 交集 ∩ 配置 methods
  │    ├─ isIdentifierFirstPasskeySignInConfig = passkey.enabled && !passkey.showPasskeyButton
  │    └─ isPasswordOnly = 全部 method 纯密码 && 非 passkey 两步流程
  │
  ▼
Main 组件（三路分支）
  │
  ├─ signInMethods 为空 && socialConnectors 有 → SocialSignInList
  │
  ├─ isPasswordOnly = true → PasswordSignInForm
  │    ├─ SmartInputField（enabledTypes = 全部 identifiers）
  │    ├─ PasswordInputField
  │    ├─ 提交后: usePasswordSignIn → 直接调用密码登录 API
  │    └─ SwitchToVerificationMethodsLink（如果 method 有 VC，显示"用验证码登录"）
  │
  └─ 其它 → IdentifierSignInForm
       ├─ SmartInputField（enabledTypes = 全部 identifiers）
       ├─ 实时监测 SSO: useSingleSignOnWatch
       │    └─ 若邮箱命中 SSO → 按钮文案变 SSO → 提交走 SSO
       └─ 提交后: useOnSubmit
            ├─ SSO 检测（Email + ssoConnectors.length > 0）
            ├─ Passkey 尝试（passkeySignIn.enabled）
            ├─ Username → /sign-in/password（强制）
            └─ 按当前 method 的 PP / VC / P
                 ├─ P && (PP || !VC) → /sign-in/password
                 └─ VC → /sign-in/verification-code
```

---

## 十、关键文件索引（补充）

| 层级 | 文件 | 职责 |
|------|------|------|
| URL 处理 | [search-parameters.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/shared/utils/search-parameters.ts#L23-L56) | 启动时处理 organization_id/app_id/ui_locales |
| URL 参数常量 | [oidc.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/schemas/src/consts/oidc.ts#L20-L80) | ExtraParamsKey / FirstScreen 枚举 |
| identifier 读取 | [use-identifier-params.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/hooks/use-identifier-params.ts) | 解析并校验 URL identifier 参数 |
| login_hint 读取 | [use-login-hint.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/hooks/use-login-hint.ts) | 读取 login_hint URL 参数 |
| 预填值优先级 | [use-prefilled-identifier.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/hooks/use-prefilled-identifier.ts#L55-L87) | 缓存 > login_hint > 空 |
| 密码页组件 | [SignInPassword](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignInPassword/index.tsx) | 第二屏密码验证 |
| 密码页表单 | [PasswordForm](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignInPassword/PasswordForm/index.tsx) | 密码输入 + 切换验证码 |
| 验证码页 | [VerificationCode](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/VerificationCode/index.tsx) | 第二屏验证码验证 |
| 验证方式选择页 | [SignInVerificationMethods](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignInVerificationMethods/index.tsx) | >2 种方式时的选择页 |
| 验证方式切换链接 | [SwitchToVerificationMethodsLink](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/components/SwitchToVerificationMethodsLink/index.tsx#L30-L73) | 密码/验证码/passkey 互跳 |

