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

### 9.0 先厘清架构：两套首页、两条数据链

Logto 有两个登录首页路由，它们对 URL `identifier` 参数的处理方式截然不同。理解这一点是后续所有分析的前提。

| 路由 | 组件 | methods 来源 | URL identifier 过滤 | `isPasswordOnly` 数据源 |
|------|------|-------------|-------------------|------------------------|
| `/sign-in` | `SignIn` | `useSieMethods()` → **全部配置方法** | ❌ **完全不生效** | 全部配置方法 |
| `/identifier-sign-in` | `IdentifierSignIn` | `useIdentifierSignInMethods()` → **URL 过滤后方法** | ✅ 生效（交集逻辑） | 全部配置方法（**注意不是过滤后方法**） |

代码证明：

**`/sign-in` 链路（不做 URL 过滤）**：

[SignIn/index.tsx L105](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignIn/index.tsx#L105-L105)：
```typescript
const { signInMethods, socialConnectors, signInMode } = useSieMethods();
// ↑ signInMethods 是全部配置方法，未经 URL 过滤
```

[SignIn/index.tsx L131](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignIn/index.tsx#L131-L131)：
```typescript
<Main signInMethods={signInMethods} socialConnectors={socialConnectors} />
// ↑ 把全部方法直接传给 Main 组件作为 props
```

[SignIn/Main.tsx L18-L20](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignIn/Main.tsx#L18-L20)：
```typescript
const Main = ({ signInMethods, socialConnectors }: Props) => {
  // signInMethods 是父组件传入的 props —— 全部方法
  const { isPasswordOnly } = useIdentifierSignInMethods();
  // 只从 hook 取 isPasswordOnly，不取过滤后的 methods
```

[SignIn/Main.tsx L39-L49](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignIn/Main.tsx#L39-L49)：
```typescript
if (isPasswordOnly) {
  return <PasswordSignInForm signInMethods={signInMethods.map(({ identifier }) => identifier)} />;
  //                                                  ↑ props（全部方法）
}
if (signInMethods.length > 0) {
  return <IdentifierSignInForm signInMethods={signInMethods} />;
  //                                          ↑ props（全部方法）
}
```

**结论**：访问 `/sign-in?identifier=username` 时，`identifier=username` 参数对方法过滤**完全没有效果**。SmartInputField 仍然接受全部配置的标识符类型。

---

**`/identifier-sign-in` 链路（做 URL 过滤，但 `isPasswordOnly` 不过滤）**：

[IdentifierSignIn/index.tsx L28](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/IdentifierSignIn/index.tsx#L28-L28)：
```typescript
const { signInMethods, isPasswordOnly } = useIdentifierSignInMethods();
// ↑ signInMethods 是 URL 过滤后的结果
// ↑ isPasswordOnly 是基于全部配置方法计算的
```

[use-identifier-sign-in-methods.ts L16-L47](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/IdentifierSignIn/use-identifier-sign-in-methods.ts#L16-L47)：
```typescript
const useIdentifierSignInMethods = () => {
  const { signInMethods, passkeySignIn } = useSieMethods();
  // ↑ 全局方法（全部配置）

  const { identifiers } = useIdentifierParams();
  // ↑ URL 参数解析出的标识符列表

  // ① URL 过滤后的方法，赋值给局部变量 methods
  const methods = useMemo(() => {
    if (identifiers.length === 0) return signInMethods;
    const filtered = signInMethods.filter(({ identifier }) => identifiers.includes(identifier));
    return filtered.length === 0 ? signInMethods : filtered;
  }, [identifiers, signInMethods]);

  // ② isPasswordOnly 的计算——用的是全局 signInMethods，不是过滤后的 methods！
  const isPasswordOnly = useMemo(
    () =>
      signInMethods.length > 0 &&
      signInMethods.every(({ password, verificationCode }) => password && !verificationCode) &&
      !isIdentifierFirstPasskeySignInConfig,
    [signInMethods, isIdentifierFirstPasskeySignInConfig]  // ← 依赖的是全局 signInMethods
  );

  return { signInMethods: methods, isPasswordOnly, ... };
  //       ↑ 返回值重命名为 signInMethods，实际是过滤后的 methods
};
```

**关键发现**：在返回对象中，`signInMethods` 是过滤后的（赋值为局部变量 `methods`），但 `isPasswordOnly` 依赖的是**全局** `signInMethods`。两者数据源不一致。

这意味着在 `/identifier-sign-in?identifier=username` 场景下，若全局配置中有任何 method 启用了 `verificationCode`，即使 URL 过滤后只剩纯密码的 username，`isPasswordOnly` 仍然是 `false`。页面仍会走两步流程（先输入标识符再输入密码），而不是直接显示密码表单。

### 9.1 URL 参数传递与标识符过滤的完整链路

URL 参数在登录流程中扮演"外部引导器"的角色，涉及四类参数：`first_screen`（路由选择）、`identifier`（标识符过滤，仅 IdentifierSignIn 生效）、`login_hint`（预填）、`organization_id`/`app_id`（配置覆盖）。

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

`identifier` 参数（如 `?identifier=email+phone`）**只在聚焦首页 `/identifier-sign-in` 生效**，在 `/sign-in` 上完全被忽略。生效方式为 **hook 级** 的交集逻辑，不修改全局配置。

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

**重要**：
1. URL 过滤只作用于返回值中的 `signInMethods` 字段，**不影响**同 hook 中的 `isPasswordOnly` 计算（见 §9.0）
2. URL 过滤也不影响其它配置（如 socialConnectors、ssoConnectors、passkey 等）
3. 在 IdentifierSignIn 页面上可以通过 footer 的 "所有登录选项" 回到 `/sign-in` 看到完整配置

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

`login_hint` 在两个首页路由上都生效，因为它不依赖 method 过滤，只依赖 SmartInputField 传入的 `enabledTypes`。

### 9.2 `isPasswordOnly` 与 `isPasswordPrimary` 的本质差异

登录方式选择中，**两个布尔变量** 决定了表单输出的形态。它们作用于不同层级、服务于不同目标：

| 维度 | `isPasswordOnly` | `isPasswordPrimary` |
|------|-----------------|---------------------|
| **作用层级** | 页面级（`Main` 组件选择哪个表单） | method 级（提交后选择哪个验证方式） |
| **作用域** | **全部 method** 的组合判断（即使 URL 过滤也用全部） | 单个 method 的内部判断 |
| **控制范围** | 首次渲染表单类型 | 用户点击提交后的路由 |
| **数据源** | **全局** `signInMethods` 的 `password` 和 `verificationCode` 字段 | 单个 method 的 `password`、`verificationCode`、`isPasswordPrimary` 字段 |
| **额外条件** | 需排除 passkey 两步流程模式 | 无需额外条件 |
| **代码位置** | [use-identifier-sign-in-methods.ts L41-L47](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/IdentifierSignIn/use-identifier-sign-in-methods.ts#L41-L47) | [use-on-submit.ts L76-L84](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/components/IdentifierSignInForm/use-on-submit.ts#L76-L84) |

#### 9.2.1 `isPasswordOnly`：决定首屏表单类型

```typescript
// 注意：此处 signInMethods 来自 useSieMethods()，是全局全部方法
const isPasswordOnly = signInMethods.length > 0
  // 条件 A：所有全局 method 都启用 password
  && signInMethods.every(({ password }) => password === true)
  // 条件 B：所有全局 method 都禁用 verificationCode
  && signInMethods.every(({ verificationCode }) => verificationCode === false)
  // 条件 C：不是 "passkey 两步流程" 模式
  && !isIdentifierFirstPasskeySignInConfig;

// passkey 两步流程：passkey 已启用但不显示按钮 → 用户需先输入标识符，再在下一步选择 passkey/密码
const isIdentifierFirstPasskeySignInConfig =
  passkeySignIn?.enabled && !passkeySignIn.showPasskeyButton;
```

**效果**：`isPasswordOnly = true` → `Main` 渲染 `PasswordSignInForm`（首屏直接显示密码框），否则渲染 `IdentifierSignInForm`（首屏只显示标识符框）。

**对 `/identifier-sign-in` 页面的特殊影响**：即使 URL 过滤后只剩纯密码 method，只要全局配置中有任何 method 开启了 `verificationCode`，`isPasswordOnly` 就是 `false`，页面仍走两步流程。具体示例见 §9.3.4。

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
- 对于 `/sign-in` 路由，URL `identifier` 参数不生效，不单独列

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

#### 情形四：`/identifier-sign-in` 页面上 URL identifier 参数的效果

**全局配置**：`[{email,P=T,VC=T,PP=T}, {phone,P=T,VC=T,PP=F}, {username,P=T,VC=F,PP=T}]`

| URL 参数 | 路由 | 过滤后 methods（传给表单） | `isPasswordOnly`（全局判定） | 首屏表单（实际渲染） | SmartInputField 接受的标识符 |
|----------|------|--------------------------|---------------------------|---------------------|---------------------------|
| （无） | `/sign-in` | **全部 3 个** | ❌ false（email/phone 有 VC） | IdentifierSignInForm | email + phone + username |
| `?identifier=email` | `/sign-in` | **全部 3 个**（URL 参数被忽略） | ❌ false | IdentifierSignInForm | email + phone + username |
| `?identifier=username` | `/sign-in` | **全部 3 个**（URL 参数被忽略） | ❌ false | IdentifierSignInForm | email + phone + username |
| （无） | `/identifier-sign-in` | **全部 3 个**（未传 URL 参数） | ❌ false | IdentifierSignInForm | email + phone + username |
| `?identifier=email` | `/identifier-sign-in` | `[{email,P=T,VC=T,PP=T}]` | ❌ false（全局 email 仍有 VC） | IdentifierSignInForm | email 仅 |
| `?identifier=username` | `/identifier-sign-in` | `[{username,P=T,VC=F,PP=T}]` | ❌ **false（全局 email/phone 有 VC！）** | **IdentifierSignInForm**（两步） | **username 仅** |
| `?identifier=email+phone` | `/identifier-sign-in` | email + phone | ❌ false | IdentifierSignInForm | email + phone |
| `?identifier=username+email` | `/identifier-sign-in` | username + email | ❌ false | IdentifierSignInForm | username + email |
| `?identifier=invalid` | `/identifier-sign-in` | 回退：全部 3 个 | ❌ false | IdentifierSignInForm | email + phone + username |

**最重要的一行：`/identifier-sign-in?identifier=username`**

这是最容易误判的场景。配置分析：

```
全局配置：
  email:    P=T, VC=T  → 不是纯密码
  phone:    P=T, VC=T  → 不是纯密码
  username: P=T, VC=F  → 是纯密码

URL 过滤后只剩 username（纯密码）。
但 isPasswordOnly 计算的是全局 3 个 method：
  signInMethods.every(m => m.password && !m.verificationCode)
  = (email:P=T,VC=F? 否) AND (phone:P=T,VC=F? 否) AND (username:P=T,VC=F? 是)
  = false

实际行为：
  ① SmartInputField 只接受 username（来自过滤后的 methods）
  ② 首屏是 IdentifierSignInForm（因为 isPasswordOnly=false）
  ③ 用户输入 username → 提交
  ④ IdentifierSignInForm.useOnSubmit 判断 username 强制走密码
  ⑤ Navigate("/sign-in/password")
  ⑥ SignInPassword.PasswordForm 显示密码框

即使用户能输入的标识符只有纯密码的 username，仍然必须走两步流程。
```

**为什么会这样？** 从代码设计意图推断：`isPasswordOnly` 的职责是判断"当前系统整体登录方式配置是否可以简化为一步密码表单"，它是基于全局配置的粗粒度判断。URL 过滤只影响 SmartInputField 的 `enabledTypes`（细粒度控制输入选项），不改变系统级的一步/两步流程判定。

如果希望 URL 过滤后 username 能直接显示 PasswordSignInForm，需要把 `isPasswordOnly` 的依赖从全局 `signInMethods` 改为过滤后的 `methods`。但当前代码不是这么实现的。

#### 情形五：全局纯密码时 URL 过滤的效果

**全局配置**：`[{email,P=T,VC=F,PP=T}, {username,P=T,VC=F,PP=T}]`（全部都是纯密码）

| URL 参数 | 路由 | 过滤后 methods | `isPasswordOnly` | 首屏表单 | SmartInputField 接受的标识符 |
|----------|------|--------------|-----------------|----------|---------------------------|
| （无） | `/sign-in` | 全部 2 个 | ✅ true | PasswordSignInForm | email + username |
| `?identifier=username` | `/sign-in` | 全部 2 个（URL 参数被忽略） | ✅ true | PasswordSignInForm | email + username |
| `?identifier=username` | `/identifier-sign-in` | `[{username,P=T,VC=F}]` | ✅ **true（全局全部都是纯密码）** | PasswordSignInForm | username 仅 |

只有当全局配置本身就是全部纯密码，且 URL 过滤也聚焦到纯密码标识符时，`/identifier-sign-in` 才会一步显示 PasswordSignInForm。此时 SmartInputField 的 enabledTypes 也被正确限制。

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
  │    ├─ signInMethods = 过滤空配置后的全局 methods[]  ← 全局使用
  │    ├─ signInMode, socialConnectors, ssoConnectors, passkeySignIn, forgotPassword
  │    └─ ...
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│                     路由分支（浏览器 URL）                        │
│                                                                  │
│  /sign-in                                          /identifier-sign-in
│      │                                                   │
│      ▼                                                   ▼
│  SignIn 组件                                     IdentifierSignIn 组件
│      │                                                   │
│      ├─ signInMethods = useSieMethods() 全局              ├─ useIdentifierSignInMethods()
│      │         (不做 URL 过滤)                             │     ├─ methods = URL ∩ 全局 signInMethods
│      └─ <Main signInMethods={全局} />                      │     ├─ isPasswordOnly = 全局 signInMethods.every(...)
│                  │                                         │     └─ 返回 { signInMethods: methods, isPasswordOnly }
│                  ▼                                         │
│              Main 组件                                     └─ { signInMethods: 过滤后, isPasswordOnly: 全局 }
│                  │                                                   │
│                  ├─ isPasswordOnly（来自 hook，基于全局）              │
│                  │                                                   ▼
│                  ├─ signInMethods（props，全局）                  条件渲染：
│                  │                                                   ├─ 过滤后 methods 为空 → Navigate("/sign-in")
│                  ▼                                                   └─ isPasswordOnly ?
│              三路分支：                                                   PasswordSignInForm(过滤后 identifiers)
│                ├─ 仅社交方法 → SocialSignInList                            : IdentifierSignInForm(过滤后 methods)
│                ├─ isPasswordOnly → PasswordSignInForm(全局 identifiers)
│                └─ 其它 → IdentifierSignInForm(全局 methods)
└─────────────────────────────────────────────────────────────────┘
                  │
                  ▼
         IdentifierSignInForm 或 PasswordSignInForm
              │                  │
              │                  ├─ SmartInputField（enabledTypes = 传入的 identifiers）
              │                  ├─ PasswordInputField
              │                  └─ 提交后: usePasswordSignIn → 直接调用密码登录 API
              │
              ├─ SmartInputField（enabledTypes = methods 中的 identifiers）
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

### 9.6 关键设计决策总结

| 决策点 | 设计选择 | 代码位置 | 影响 |
|--------|---------|---------|------|
| URL 过滤作用域 | 仅 IdentifierSignIn 页面 | `SignIn/index.tsx` 用 `useSieMethods` 而非 `useIdentifierSignInMethods` | `/sign-in` 忽略 identifier 参数 |
| `isPasswordOnly` 数据源 | 始终用全局方法 | `useIdentifierSignInMethods` L43 用 `signInMethods`（全局）而非 `methods`（过滤后） | URL 过滤到纯密码也可能走两步 |
| `isPasswordPrimary` 条件 | 仅双方式都开时生效 | `useOnSubmit` L76: `password && (PP \|\| !VC)` | 单方式时 PP 不参与判断 |
| Username 提交后路由 | 强制走密码 | `useOnSubmit` L70-L74 | 忽略 username method 的 VC/PP |
| Passkey 两步模式 | 强制 IdentifierSignInForm | `isIdentifierFirstPasskeySignInConfig` | passkey.enabled 但无按钮 → 全局两步 |

### 9.7 Username 仅开启验证码时的死路分析

配置 `[{username, P=F, VC=T}]` 在现实中不应出现（后端 Console 不允许 Username 开启验证码），但代码层面并无校验阻止它下发。一旦出现，用户会走进一条死路。逐行追踪如下。

#### 9.7.1 首屏：IdentifierSignInForm

```
① useSieMethods 过滤：P=F, VC=T → password=F, verificationCode=T → 满足 P||VC → 保留
② isPasswordOnly = signInMethods.every(m => m.password && !m.verificationCode)
   = (P=F && !VC=T) = (F && F) = F → isPasswordOnly=false
③ Main 渲染 IdentifierSignInForm
④ SmartInputField enabledTypes = ['username']
⑤ 用户输入 username → 点击继续
```

#### 9.7.2 提交后：useOnSubmit 的无条件跳转

[use-on-submit.ts L70-L74](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/components/IdentifierSignInForm/use-on-submit.ts#L70-L74)：

```typescript
if (identifier === SignInIdentifier.Username) {
  navigateToPasswordPage();
  return;  // ← 无条件返回，不看 method 的 password/verificationCode 配置
}
```

**这里就是问题的根源**：对 Username 标识符，代码不看 method 的任何字段，直接跳密码页。即使 method 的 `password=false`、`verificationCode=true`，也照样跳。

此后的 L76-L84（`password && (isPasswordPrimary || !verificationCode)` → 密码页 / `verificationCode` → 发验证码）对 Username **永远不执行**，因为 L70-L74 的 return 已经终止了函数。

#### 9.7.3 第二屏：SignInPassword 的 ErrorPage

[SignInPassword/index.tsx L26-L31](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignInPassword/index.tsx#L26-L31)：

```typescript
const methodSetting = signInMethods.find((method) => method.identifier === type);

// Sign-in method not enabled
if (!methodSetting?.password) {
  return <ErrorPage />;
}
```

SignInPassword 在渲染前做了**二次校验**：查找当前标识符对应的 method，若 `password` 未启用则直接显示 `ErrorPage`。对本场景 `methodSetting.password = false` → 用户看到错误页。

**关键**：这个 `ErrorPage` 是 SignInPassword 自身的保护逻辑，不是全局路由守卫。它只拦截了"配置没有密码却进了密码页"的情况，但**无法阻止** useOnSubmit 把用户导航到这里。

#### 9.7.4 死路：没有出口

用户此时停留在 ErrorPage 上。我们来检查所有可能的出口：

**出口一：SwitchToVerificationMethodsLink — 不存在**

SwitchToVerificationMethodsLink 只出现在两个地方：
- [PasswordForm](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignInPassword/PasswordForm/index.tsx#L121-L126)（第二屏密码表单）
- [VerificationCode 页面](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/VerificationCode/index.tsx)

但 SignInPassword 在 `!methodSetting?.password` 时直接 `return <ErrorPage />`，**不会渲染 PasswordForm**，因此 SwitchToVerificationMethodsLink **不会出现**。

即使假设 SwitchToVerificationMethodsLink 能被渲染，它对 Username 也有硬性排除：

[PasswordForm/index.tsx L122](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignInPassword/PasswordForm/index.tsx#L122-L122)：
```typescript
hasVerificationCode={identifier !== SignInIdentifier.Username && isVerificationCodeEnabled}
```

`identifier === Username` → `hasVerificationCode = false`。验证码入口被切断。

**出口二：SignInVerificationMethods 页面 — 不存在**

[SignInVerificationMethods/index.tsx L80](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignInVerificationMethods/index.tsx#L80-L80)：
```typescript
{hasVerificationCode && type !== SignInIdentifier.Username && (
```

`type === Username` → 验证码卡片不渲染。密码卡片需要 `hasPassword = Boolean(methodSetting?.password) = false` → 也不渲染。Passkey 卡片取决于用户是否绑定了 passkey。如果没有，页面显示空列表。

**出口三：VerificationCodeIdentifier 类型 — 不包含 Username**

[types/index.ts L31](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/types/index.ts#L31-L31)：
```typescript
export type VerificationCodeIdentifier = SignInIdentifier.Email | SignInIdentifier.Phone;
```

`VerificationCodeLink`、`PasskeySignInLink` 的 props 类型是 `VerificationCodeIdentifier`，**编译期就不接受 Username**。即使想给 Username 显示验证码入口，TypeScript 也会报错。

**出口四：VerificationCode 页面 — 不接受 Username**

[VerificationCode/index.tsx L22-L29](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/VerificationCode/index.tsx#L22-L29)：
```typescript
const isValidVerificationCodeIdentifier = (
  identifierInputValue: IdentifierInputValue | undefined
): identifierInputValue is VerificationCodeIdentifier =>
  Boolean(
    identifierInputValue?.type &&
      identifierInputValue.type !== SignInIdentifier.Username &&
      identifierInputValue.value
  );
```

如果有人用 URL 直接访问 `/sign-in/verification-code`，而 Context 中的标识符是 Username，该页面也会显示 `ErrorPage`。

#### 9.7.5 完整死路图

```
配置：[{username, P=F, VC=T}]
          │
          ▼
    首屏 IdentifierSignInForm
    SmartInputField 接受 username
          │
          ▼ 用户输入 username，点继续
    useOnSubmit L70: identifier === Username?
          │
          ├─ 是 → navigateToPasswordPage()  ← 无条件，不看 P/VC
          │        return
          │
          ▼
    SignInPassword 页面
          │
          ├─ methodSetting.password === false
          │     │
          │     ▼
          │   ErrorPage  ← 用户被困在这里
          │     │
          │     ├─ 无 SwitchToVerificationMethodsLink（ErrorPage 替代了 PasswordForm）
          │     ├─ 无 VerificationCodeLink（类型 VerificationCodeIdentifier 不含 Username）
          │     ├─ SignInVerificationMethods 页面 Username 无验证码卡片
          │     └─ VerificationCode 页面 Username 触发 ErrorPage
          │
          │  唯一出口：浏览器后退按钮
          ▼
```

#### 9.7.6 代码中 Username 与验证码的三层隔离

| 隔离层 | 代码位置 | 机制 | 效果 |
|--------|---------|------|------|
| 提交路由 | [use-on-submit.ts L70-L74](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/components/IdentifierSignInForm/use-on-submit.ts#L70-L74) | Username 无条件 `navigateToPasswordPage()` | 即使 VC=T 也不走验证码分支 |
| 密码页保护 | [SignInPassword/index.tsx L29-L31](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignInPassword/index.tsx#L29-L31) | `!methodSetting?.password` → ErrorPage | P=F 时密码页不可用 |
| 类型系统 | [types/index.ts L31](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/types/index.ts#L31-L31) | `VerificationCodeIdentifier = Email \| Phone` | 编译期排除 Username |
| 切换链接 | [PasswordForm/index.tsx L122](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignInPassword/PasswordForm/index.tsx#L122-L122) | `identifier !== Username && isVCEnabled` | 运行时隐藏 Username 的验证码入口 |
| 方式选择页 | [SignInVerificationMethods/index.tsx L80](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignInVerificationMethods/index.tsx#L80-L80) | `type !== Username && hasVC` | 运行时不渲染 Username 的验证码卡片 |
| 验证码页 | [VerificationCode/index.tsx L27](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/VerificationCode/index.tsx#L27-L27) | `type !== Username` 类型守卫 | Username 进入验证码页 → ErrorPage |

**结论**：Username 在代码中被设计为"只能密码登录"的标识符。这个设计假设贯穿了从提交路由到类型系统的每一层。当配置出现 `[{username, P=F, VC=T}]` 时，没有任何一层能纠正或降级——每层都只做了自己的防守（useOnSubmit 强制跳密码、SignInPassword 校验密码是否启用、类型系统排除 Username 的验证码），但它们组合起来产生了一条死路：useOnSubmit 把用户送进密码页，而密码页又因为 P=F 拒绝渲染，且不提供任何其它出口。

#### 9.7.7 对比：Email 仅开启验证码的正常路径

配置 `[{email, P=F, VC=T}]` 的走向完全不同：

```
① isPasswordOnly = false → IdentifierSignInForm
② SmartInputField 接受 email
③ 用户输入 email → 点继续
④ useOnSubmit:
    - identifier === Email（不是 Username）→ 不触发 L70-L74
    - SSO 检测（若有 ssoConnectors）
    - Passkey 检测
    - password=F → 不触发 L76 的密码分支
    - verificationCode=T → sendVerificationCode({ identifier: email, value })
⑤ 验证码发送成功 → Navigate("/sign-in/verification-code")
⑥ VerificationCode 页面正常渲染
```

两相对比，useOnSubmit L70-L74 的 Username 无条件跳转是唯一将"正常配置路径"变为"死路"的代码点。

### 9.8 三个验证页对 Username 验证码的控制细节

`SwitchToVerificationMethodsLink` 是三个验证页（密码页、验证码页、Passkey 验证页）共用的切换入口组件。每个页面调用它时传入的参数不同，对 Username 验证码的控制策略也不同。本小节逐一拆解三个调用点。

#### 9.8.1 调用点一：密码页 PasswordForm

**调用位置**：[PasswordForm/index.tsx L121-L126](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignInPassword/PasswordForm/index.tsx#L121-L126)

```jsx
<SwitchToVerificationMethodsLink
  hasVerificationCode={identifier !== SignInIdentifier.Username && isVerificationCodeEnabled}
  className={styles.switch}
  identifier={cond(identifier !== SignInIdentifier.Username && identifier)}
  value={value}
/>
```

控制 Username 验证码的有三个参数：

| 参数 | Username 时的值 | 作用 |
|------|----------------|------|
| `hasVerificationCode` | `false`（因为 `identifier !== Username` 为 false） | 告诉组件"验证码方式不可用"，验证码链接不会渲染 |
| `identifier` | `undefined`（`cond(...)` 返回 undefined） | `VerificationCodeLink` 的必填 prop，undefined 时验证码链接不渲染 |
| `value` | 正常传值 | 验证码链接的参数，但 identifier 为 undefined 时整体不生效 |

**双重保险**：`hasVerificationCode` 是功能开关，`identifier` 是类型约束。两者都对 Username 做了硬编码排除，任何一个为假都会导致验证码切换入口不出现。

**前置条件**：能到达 PasswordForm 意味着 `methodSetting?.password === true`（SignInPassword/index.tsx L29 的校验已通过）。所以 Username 场景下，密码页本身是可正常使用的，只是底部没有验证码切换链接。

#### 9.8.2 调用点二：Passkey 验证页 SignInPasskeyVerification

**调用位置**：[SignInPasskeyVerification/index.tsx L74-L80](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignInPasskeyVerification/index.tsx#L74-L80)

```jsx
<SwitchToVerificationMethodsLink
  className={styles.switchLink}
  identifier={cond(type !== SignInIdentifier.Username && type)}
  value={identifierInputValue.value}
  hasPassword={methodSetting?.password}
  hasVerificationCode={type !== SignInIdentifier.Username && methodSetting?.verificationCode}
/>
```

| 参数 | Username 时的值 | 作用 |
|------|----------------|------|
| `identifier` | `undefined` | 验证码链接和 Passkey 链接都需要它 |
| `hasPassword` | `methodSetting?.password`（正常读取配置） | 密码链接照常显示 |
| `hasVerificationCode` | `false`（`type !== Username` 为 false） | 验证码方式标记为不可用 |

**特点**：
- 密码入口不受影响（`hasPassword` 正常从配置读取）
- 验证码入口被两层条件同时排除（`identifier` 为 undefined + `hasVerificationCode` 为 false）
- Passkey 入口也受影响，因为 `identifier` 为 undefined 时 PasskeySignInLink 不渲染（`identifier` 是 VerificationCodeIdentifier 类型）

#### 9.8.3 调用点三：验证码页 VerificationCodeContainer

**调用位置**：[VerificationCode/index.tsx L54](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/VerificationCode/index.tsx#L54-L54) → [VerificationCode/index.tsx L76](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/VerificationCode/index.tsx#L76-L76) → [VerificationCode/index.tsx L132-L139](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/containers/VerificationCode/index.tsx#L132-L139)

```jsx
// VerificationCode 页面
const methodSettings = signInMethods.find((method) => method.identifier === type);
const hasPasswordButton = userFlow === UserFlow.SignIn && methodSettings?.password;

<VerificationCodeContainer
  flow={userFlow}
  identifier={cachedIdentifierInputValue}  // 类型是 VerificationCodeIdentifier
  verificationId={verificationId}
  hasPasswordButton={hasPasswordButton}
/>

// VerificationCodeContainer 内部
<SwitchToVerificationMethodsLink
  hasPassword={hasPasswordButton}
  identifier={identifier.type}
  value={identifier.value}
  className={styles.switch}
/>
```

**关键点**：Username 根本到不了这个调用点。

**第一层保护：页面入口类型守卫**

[VerificationCode/index.tsx L22-L29](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/VerificationCode/index.tsx#L22-L29)：

```typescript
const isValidVerificationCodeIdentifier = (
  identifierInputValue: IdentifierInputValue | undefined
): identifierInputValue is VerificationCodeIdentifier =>
  Boolean(
    identifierInputValue?.type &&
      identifierInputValue.type !== SignInIdentifier.Username &&
      identifierInputValue.value
  );

if (!isValidVerificationCodeIdentifier(cachedIdentifierInputValue)) {
  return <ErrorPage title="error.invalid_session" />;
}
```

`type !== Username` 直接把 Username 拦在门外。通过这个守卫后，`cachedIdentifierInputValue` 的 TypeScript 类型被收窄为 `VerificationCodeIdentifier`（即 `Email | Phone`）。

**第二层保护：TypeScript 类型系统**

[VerificationCodeContainer 的 Props](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/containers/VerificationCode/index.tsx#L18-L18) 中 `identifier` 的类型是 `VerificationCodeIdentifier`（即 `Email | Phone`），编译期就不接受 Username。

**第三层保护：SwitchToVerificationMethodsLink 的参数**

- `identifier` 是 `VerificationCodeIdentifier` 类型，天然排除 Username
- `hasPassword` 正常从配置读取，不受 Username 影响
- 未传 `hasVerificationCode`（因为用户已经在验证码页了），但这不影响 Username 的判断——Username 根本进不来

#### 9.8.4 三个调用点的对比表

| 维度 | 密码页 PasswordForm | Passkey 验证页 | 验证码页 VerificationCode |
|------|--------------------|--------------|-------------------------|
| `hasVerificationCode` | `identifier !== Username && isVCEnabled` | `type !== Username && method.verificationCode` | **未传**（用户已在验证码页） |
| `identifier` prop | `cond(identifier !== Username && identifier)` | `cond(type !== Username && type)` | `VerificationCodeIdentifier` 类型，天然排除 |
| 有几层保护？ | 2 层（hasVerificationCode + identifier） | 2 层（hasVerificationCode + identifier） | 3 层（入口守卫 + 类型系统 + identifier 类型） |
| Username 能否到达该页面？ | ✅ 能（但底部无验证码链接） | ✅ 能（但无验证码/无Passkey切换链接） | ❌ 不能（入口处 ErrorPage） |
| 密码入口是否受影响？ | 不受影响（当前页就是密码页） | 不受影响（hasPassword 正常读配置） | 不受影响（hasPasswordButton 正常读配置） |

#### 9.8.5 设计模式解读

Username 验证码的排除遵循**分层防御**模式：

```
Layer 1: 提交路由层（useOnSubmit L70-L74）
  └─ Username 无条件跳密码页，根本不进验证码分支

Layer 2: 页面入口层（SignInPassword / VerificationCode 各自的保护）
  ├─ SignInPassword: P=F → ErrorPage
  └─ VerificationCode: type===Username → ErrorPage

Layer 3: 组件 Props 层（SwitchToVerificationMethodsLink 的调用参数）
  ├─ 密码页: hasVerificationCode=false, identifier=undefined
  ├─ Passkey 页: hasVerificationCode=false, identifier=undefined
  └─ 验证码页: identifier 类型是 VerificationCodeIdentifier

Layer 4: 类型系统层（VerificationCodeIdentifier = Email | Phone）
  └─ 编译期排除 Username
```

每一层都独立有效，即使上一层出现漏洞（比如配置下发了 Username+VC=T），下一层也能兜住。代价是多层防御的组合产生了 §9.7 描述的死路——用户被第一层送进密码页，第二层因为 P=F 显示 ErrorPage，而第三层（SwitchToVerificationMethodsLink）因为 ErrorPage 替代了 PasswordForm 而不存在。

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
| Passkey 验证页 | [SignInPasskeyVerification](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/pages/SignInPasskeyVerification/index.tsx) | Passkey 验证第二屏 |
| 验证码容器 | [VerificationCodeContainer](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/containers/VerificationCode/index.tsx) | 验证码输入 + 切换密码 |
| 类型定义 | [types/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/69-logto/packages/experience/src/types/index.ts#L31-L31) | `VerificationCodeIdentifier = Email \| Phone` |

