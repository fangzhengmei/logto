# i18n 词条与 phrases 后端注入流程理解

## 概述

Logto 的 i18n 体系由**两套后端 i18n 系统**、**两个 phrases 资源包**和**前端 i18next 运行时**组成。体验端（登录页、账户中心）的词条由后端将内置短语与自定义短语合并后，通过 SSR 注入和 API 两种方式传递给前端。

---

## 一、两个 phrases 资源包

### 1. `@logto/phrases` — 通用短语包

- **路径**：[packages/phrases/](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/phrases)
- **用途**：后端错误消息、Admin Console、OIDC 等通用翻译
- **命名空间**：`translation`（含 `admin_console`、`oidc`、`demo-app` 等子树）、`errors`
- **入口**：[packages/phrases/src/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/phrases/src/index.ts#L80-L98)
- **语言**：17 种内置语言（ar, de, en, es, fr, it, ja, ko, pl-PL, pt-BR, pt-PT, ru, th, tr-TR, zh-CN, zh-HK, zh-TW）

### 2. `@logto/phrases-experience` — 体验端短语包

- **路径**：[packages/phrases-experience/](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/phrases-experience)
- **用途**：登录注册页、账户中心等体验端 UI 的翻译
- **命名空间**：`translation`（含 `input`、`action`、`error`、`mfa`、`profile`、`user_scopes`、`account_center` 等子树）
- **入口**：[packages/phrases-experience/src/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/phrases-experience/src/index.ts#L64-L84)
- **语言**：20 种内置语言（比 phrases 多 cs, uk-UA 等）

> **注意**：两个包独立维护，语言数量和结构均不同。

---

## 二、后端两套 i18n 系统

### 系统 A：全局 i18next（后端自用）

**初始化**：[packages/core/src/i18n/init.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/i18n/init.ts#L1-L10)

```typescript
import resources from '@logto/phrases';  // 用的是通用短语包
import i18next from 'i18next';

export default async function initI18n() {
  await i18next.init({
    fallbackLng: 'en',
    supportedLngs: Object.keys(resources),
    resources,
  });
}
```

**中间件**：[packages/core/src/middleware/koa-i18next.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/middleware/koa-i18next.ts#L19-L43)

```typescript
export default function koaI18next() {
  return async (ctx, next) => {
    const languages = detectLanguage(ctx); // 从 Accept-Language header + query.locale
    const languageUtils = i18next.services.languageUtils;
    const foundLanguage = languages
      .map((code) => languageUtils.formatLanguageCode(code))
      .find((code) => languageUtils.isSupportedCode(code));

    // 每个请求克隆一个实例，避免异步请求互相影响
    ctx.i18n = i18next.cloneInstance({ lng: foundLanguage });
    ctx.locale = ctx.i18n.language;

    return next();
  };
}
```

- **挂载位置**：[Tenant.ts#L126](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/tenants/Tenant.ts#L126) — 所有请求的最外层
- **用途**：后端内部错误消息格式化等
- **资源来源**：仅 `@logto/phrases`，**不含自定义短语**

### 系统 B：Phrase Library（给前端提供体验端短语）

**核心实现**：[packages/core/src/libraries/phrase.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/libraries/phrase.ts#L9-L23)

```typescript
import type { LocalePhrase } from '@logto/phrases-experience';  // 用的是体验端短语包
import resource, { isBuiltInLanguageTag } from '@logto/phrases-experience';
import { trySafe } from '@silverhand/essentials';
import cleanDeep from 'clean-deep';
import deepmerge from 'deepmerge';

export const createPhraseLibrary = (queries: Queries) => {
  const { findCustomPhraseByLanguageTag, findAllCustomLanguageTags } = queries.customPhrases;

  const getPhrases = async (forLanguage: string): Promise<LocalePhrase> => {
    return deepmerge<LocalePhrase>(
      // 基底：内置短语（语言 tag 不是内置的则 fallback 到 en）
      resource[isBuiltInLanguageTag(forLanguage) ? forLanguage : 'en'],
      // 覆盖：数据库中的自定义短语（清除空值后深度合并）
      cleanDeep((await trySafe(findCustomPhraseByLanguageTag(forLanguage))) ?? {})
    );
  };

  return { getPhrases, findAllCustomLanguageTags };
};
```

**创建与挂载**：[packages/core/src/tenants/Libraries.ts#L32](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/tenants/Libraries.ts#L32)

```typescript
export default class Libraries {
  phrases = createPhraseLibrary(this.queries);
  // ...
}
```

#### 自定义短语存储

- **数据表**：`custom_phrases`，字段：`id`、`tenantId`、`languageTag`、`translation`
- **查询层**：[packages/core/src/queries/custom-phrase.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/queries/custom-phrase.ts)
- **管理 API（CRUD）**：[packages/core/src/routes/custom-phrase.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/routes/custom-phrase.ts)
  - PUT 时验证：翻译结构必须是 `resource.en.translation` 的**严格子集**（[isStrictlyPartial](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/utils/translation.ts#L9-L26)）
  - 不允许删除 fallback language

#### 缓存机制

自定义短语查询通过 `WellKnownCache` 缓存：

- 缓存 key：`custom-phrases:{languageTag}`、`custom-phrases-tags`
- 位置：[packages/core/src/caches/well-known.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/caches/well-known.ts#L27-L28)
- upsert/delete 操作会自动失效对应缓存

---

## 三、语言匹配流程

### 语言检测（请求端）

**实现**：[packages/core/src/i18n/detect-language.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/i18n/detect-language.ts#L42-L47)

从两个位置提取语言，按优先级排序：
1. `ctx.query.locale`（query 参数）
2. `ctx.headers['accept-language']`（解析 q 值并排序）

### 体验端语言匹配

**核心函数**：`getExperienceLanguage` — [packages/core/src/utils/i18n.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/utils/i18n.ts#L36-L82)

```typescript
export const getExperienceLanguage = ({
  ctx,
  languageInfo: { autoDetect, fallbackLanguage },
  customLanguages,
  lng,  // 可选的显式语言参数
}: GetExperienceLanguage) => {
  const acceptableLanguageCandidates = conditionalArray(
    lng?.split(/\s+/).filter(Boolean),       // 1. 显式传入的 lng（可多个，空格分隔）
    autoDetect && detectLanguage(ctx),       // 2. 自动检测（header + query）
    fallbackLanguage                          // 3. 配置的 fallback language
  );
  const acceptableLanguages = acceptableLanguageCandidates.flat();

  for (const language of acceptableLanguages) {
    // 依次尝试：自定义精确 → 内置精确 → 内置基础 → 自定义基础
    const customExact = matchExactLanguageTag([language], customLanguages);
    if (customExact) return customExact;

    const builtInExact = matchExactLanguageTag([language], builtInLanguages);
    if (builtInExact) return builtInExact;

    const { match: builtInFallback, matchType: builtInMatchType } =
      matchSupportedLanguageTag([language], builtInLanguages);
    if (builtInMatchType === 'base' && builtInFallback) return builtInFallback;

    const { match: customFallback, matchType: customMatchType } =
      matchSupportedLanguageTag([language], customLanguages);
    if (customMatchType === 'base' && customFallback) return customFallback;
  }

  // 最终兜底：从内置语言中找默认
  return findSupportedLanguageTag([], builtInLanguages);
};
```

**匹配优先级总结**：
```
候选语言优先级（依次遍历每个候选）：
  ├── lng 参数（显式指定）
  ├── 自动检测（Accept-Language / query.locale）
  └── fallbackLanguage（sign-in experience 配置）

对每个候选语言的匹配顺序：
  1. 自定义语言 精确匹配
  2. 内置语言 精确匹配
  3. 内置语言 基础语言匹配（如 zh → zh-CN）
  4. 自定义语言 基础语言匹配

都匹配不上时 → 返回内置语言的默认值（en）
```

语言匹配底层工具：[packages/toolkit/language-kit/src/utility.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/toolkit/language-kit/src/utility.ts)

---

## 四、后端注入前端的两种方式

两种方式**都使用 Phrase Library 的 `getPhrases(language)`** 来获取合并后的体验端短语。

### 方式一：SSR 注入（首屏注入）

**中间件**：[packages/core/src/middleware/koa-experience-ssr.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/middleware/koa-experience-ssr.ts#L22-L67)

#### 挂载位置

[Tenant.ts#L241-L257](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/tenants/Tenant.ts#L241-L257)

```typescript
// Mount experience app
app.use(
  compose([
    koaExperienceSecurityHeaders(id, queries, mountedApps),
    koaExperienceSsr(libraries, queries),  // ← SSR 注入中间件
    koaSpaSessionGuard(provider, queries),
    mount(`/${experience.routes.consent}`, ...),
    koaSpaProxy({ mountedApps, queries }), // ← 静态文件服务 / Vite 代理
  ])
);
```

#### 工作原理

```
请求进入
  ↓
koaExperienceSsr 中间件执行（await next() 之后处理）
  ↓
调用 next() → 走到 koaSpaProxy → koaServeStatic
  ↓
koaServeStatic 读取 index.html，设置 ctx.body = 文件内容
  ↓
回到 koaExperienceSsr，检查三个条件：
  1. ctx.body 是字符串
  2. isIndexPath(ctx.path)（路径是 / 或 /index.html）
  3. ctx.body 包含 ssrPlaceholder（"__LOGTO_SSR__"）
  ↓
满足条件则执行注入：
  1. 读取 logtoUiCookie（含 appId, organizationId 等）
  2. 并行加载 signInExperience 和 customLanguages
  3. 调用 getExperienceLanguage() 确定语言
  4. 调用 libraries.phrases.getPhrases(language) 获取合并后的短语
  5. 设置 Content-Language header
  6. 替换 ssrPlaceholder 为 JSON 序列化的 SsrData
```

**注入数据结构**（[SsrData](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/schemas/src/types/ssr.ts#L8-L19)）：

```typescript
type SsrData = {
  signInExperience: {
    appId?: string;
    organizationId?: string;
    uiLocales?: string;
    data: FullSignInExperience;
  };
  phrases: {
    lng: string;       // 实际语言
    data: LocalePhrase; // 合并后的完整短语
  };
};
```

**HTML 中的占位符**（[index.html#L9-L12](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/experience/index.html#L9-L12)）：

```html
<script>
  window.logtoSsr = "__LOGTO_SSR__";
</script>
```

替换后变成：
```html
<script>
  window.logtoSsr = Object.freeze({"signInExperience":{...},"phrases":{"lng":"zh-CN","data":{...}}});
</script>
```

#### Account Center 的 SSR

Account Center 也有 SSR，但**只注入 sign-in experience 的颜色/主题数据**，不注入 phrases（[koa-account-center-ssr.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/middleware/koa-account-center-ssr.ts)）。

### 方式二：`/.well-known/phrases` API（运行时获取）

**路由实现**：[packages/core/src/routes/well-known/index.ts#L60-L83](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/routes/well-known/index.ts#L60-L83)

```typescript
router.get('/.well-known/phrases',
  koaGuard({
    query: z.object({ lng: z.string().optional() }),
    response: z.record(z.string().or(z.record(z.unknown()))),
    status: 200,
  }),
  async (ctx, next) => {
    const { lng } = ctx.guard.query;

    // 1. 获取 sign-in experience 的语言配置
    const { languageInfo } = await findDefaultSignInExperience();
    // 2. 获取所有自定义语言标签
    const customLanguages = await findAllCustomLanguageTags();
    // 3. 确定最终语言
    const language = getExperienceLanguage({ ctx, languageInfo, customLanguages, lng });

    // 4. 获取合并后的短语
    ctx.set('Content-Language', language);
    ctx.body = await getPhrases(language);

    return next();
  }
);
```

**挂载位置**：
- 全局：`/.well-known` 前缀下，[Tenant.ts#L159](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/tenants/Tenant.ts#L159) 调用 `initPublicWellKnownApis`（但这个只有 webauthn）
- API 路径：`/api/.well-known/phrases`，在 [routes/init.ts#L133](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/routes/init.ts#L133) 中 `wellKnownRoutes` 挂载到 `/api` 下

> **注意**：前端体验端调用的是 `/api/.well-known/phrases`（带 `/api` 前缀）。

---

## 五、前端接收与使用

### Experience 端

**初始化入口**：[use-sign-in-experience.ts#L14-L26](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/experience/src/Providers/SettingsProvider/use-sign-in-experience.ts#L14-L26)

```typescript
useEffect(() => {
  (async () => {
    // 并行加载设置和 i18n
    const [settings] = await Promise.all([getSignInExperienceSettings(), initI18n()]);
    setExperienceSettings(settings);
  })();
}, [isPreview, setExperienceSettings, setTheme]);
```

**i18n 初始化**：[packages/experience/src/i18n/init.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/experience/src/i18n/init.ts)

```typescript
const initI18n = async (initialLanguage?: string) => {
  const { resources, lng } = await getI18nResource(initialLanguage);
  await i18next.init({ resources, lng, interpolation: { escapeValue: false } });
  // ...
  return i18n;
};
```

**资源获取逻辑**：[packages/experience/src/i18n/utils.ts#L12-L38](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/experience/src/i18n/utils.ts#L12-L38)

```
getPhrases(language?):
  ├─ 读取 sessionStorage 中的 uiLocales
  ├─ 确定 preferredLanguage（参数 → uiLocales）
  │
  ├─ 检查 SSR 数据：
  │  └─ 如果 logtoSsr 是对象
  │     且 (!preferredLanguage 或语言匹配)
  │     → 直接返回 logtoSsr.phrases
  │
  └─ 否则请求 API：
     ├─ 检测浏览器语言（localStorage / navigator）
     ├─ GET /api/.well-known/phrases?lng=xxx
     │   (Accept-Language header 携带本地语言)
     ├─ 从 response.json() 取短语
     └─ 从 Content-Language header 取实际语言
```

**语言切换**：`changeLanguage(language)` 重新获取资源并添加到 i18next，然后切换语言。

**全局类型声明**：[global.d.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/experience/src/include.d/global.d.ts)

```typescript
declare global {
  const logtoSsr: LogtoSsr; // string | Readonly<SsrData> | undefined
  interface Window { logtoSsr: LogtoSsr; }
}
```

### Account 端

**特点**：无 phrases 的 SSR，纯 API 加载

- 初始化：`initI18n()` 创建空 resources 的 i18next 实例
- 实际加载：在 `PageContextProvider` 中调用 `changeLanguage()` 异步获取
- API 调用：同样请求 `/api/.well-known/phrases`

位置：[packages/account/src/i18n/utils.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/account/src/i18n/utils.ts)

### Console 端

**特点**：不依赖后端注入，直接从 npm 包加载全部资源

- 加载 `@logto/phrases` 的 `translation` 和 `errors` 命名空间
- 加载 `@logto/phrases-experience` 到 `experience` 命名空间（供预览使用）
- 使用浏览器语言检测（localStorage / sessionStorage）

位置：[packages/console/src/i18n/init.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/console/src/i18n/init.ts)

---

## 六、完整链路图

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          内置短语包（Build-time）                              │
│                                                                              │
│  @logto/phrases                      @logto/phrases-experience               │
│  (通用: console/errors/oidc)          (体验端: 登录页/账户中心)               │
│  17 种语言                             20 种语言                              │
└──────────────┬───────────────────────────────┬───────────────────────────────┘
               │                               │
               │ import                        │ import
               ▼                               ▼
┌──────────────────────────────┐  ┌──────────────────────────────────────┐
│   全局 i18next 实例          │  │   Phrase Library (前端用)            │
│   i18n/init.ts               │  │   libraries/phrase.ts                │
│   - 仅 @logto/phrases        │  │   - @logto/phrases-experience 为基底 │
│   - 无自定义短语              │  │   - deepmerge(内置, 自定义短语)       │
│   - 供 koaI18next 中间件用    │  │   - 数据源: custom_phrases 表        │
└──────────────┬───────────────┘  │     + WellKnownCache 缓存            │
               │                  └───────────────┬──────────────────────┘
               │                                  │
               ▼                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          后端 → 前端 注入                                 │
│                                                                          │
│  方式一：SSR 注入                        方式二：API 接口                 │
│  koa-experience-ssr.ts                  routes/well-known/index.ts       │
│  - 替换 index.html 中的                  - GET /api/.well-known/phrases  │
│    "__LOGTO_SSR__"                       - query: lng (可选)             │
│  - 仅 experience 应用                     - 返回: 合并后的短语 JSON       │
│  - 首屏无延迟                              + Content-Language header     │
│  - 防止主题闪屏                                                           │
└────────────────────────────┬───────────────────────────┬─────────────────┘
                             │                           │
                             ▼                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          前端 i18next 运行时                              │
│                                                                          │
│  Experience:                              Account:                        │
│    - 优先读 SSR (logtoSsr.phrases)         - 纯 API 加载                  │
│    - 否则请求 /.well-known/phrases         - PageContextProvider 中异步    │
│    - 支持运行时切换语言                                                     │
│                                                                          │
│  Console:                                                                 │
│    - 直接从 npm 包全量加载（无后端注入）                                    │
│    - 含 experience namespace 供预览                                        │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 七、关键设计要点

1. **两套 i18n 系统分离**：后端自用的全局 i18next（用 `@logto/phrases`） vs 给前端体验端的 Phrase Library（用 `@logto/phrases-experience` + 自定义短语），两者互不干扰

2. **自定义短语 = 增量覆盖**：数据库只存差异部分，通过 `deepmerge` + `cleanDeep` 合并到内置短语上，自定义优先级更高

3. **双路径注入**：SSR 保证首屏性能和无闪屏，API 支持运行时语言切换，前端优先使用 SSR 数据

4. **语言匹配多级 fallback**：精确匹配 → 基础语言匹配 → 内置语言兜底，同时考虑自定义语言和内置语言

5. **缓存分层**：well-known 缓存减少数据库查询，upsert/delete 时主动失效

6. **命名空间隔离**：`translation`、`errors`、`experience` 等独立 namespace，避免 Console 和 Experience 的短语冲突

7. **请求级 i18n 实例**：`koaI18next` 为每个请求 clone 一个 i18next 实例，避免异步请求间的语言状态互相污染
