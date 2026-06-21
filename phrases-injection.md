# i18n 词条与 phrases 后端注入流程理解

## 概述

Logto 的 i18n 体系由**两套后端 i18n 系统**、**两个 phrases 资源包**和**前端 i18next 运行时**组成。体验端（登录页、账户中心）的词条由后端将内置短语与自定义短语合并后，通过 SSR 注入和 API 两种方式传递给前端。

自定义短语的核心设计是**增量覆盖**：数据库只存与内置短语的差异，后端通过 `deepmerge` 合并后返回完整的语言包给前端。

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
- **命名空间**：仅 `translation` 一个命名空间（含 `input`、`action`、`error`、`mfa`、`profile`、`user_scopes`、`account_center` 等子树）
- **入口**：[packages/phrases-experience/src/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/phrases-experience/src/index.ts#L64-L84)
- **语言**：20 种内置语言（比 phrases 多 cs, uk-UA 等）
- **类型定义**：`LocalePhrase = typeof en` — [types.ts#L11](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/phrases-experience/src/types.ts#L11)

> **注意**：两个包独立维护，语言数量和结构均不同。`@logto/phrases-experience` 只有 `translation` 一个 namespace，error 是 translation 下的子树，不是独立 namespace。

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
import type { LocalePhrase } from '@logto/phrases-experience';
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

---

## 三、自定义短语合并与覆盖边界

### 3.1 CustomPhrase 数据结构

**类型定义**：[packages/schemas/src/foundations/jsonb-types/phrases.ts#L3-L5](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/schemas/src/foundations/jsonb-types/phrases.ts#L3-L5)

```typescript
export type Translation = {
  [key: string]: string | Translation;
};
```

**数据库表**：`custom_phrases`
- 字段：`id`、`tenantId`、`languageTag`、`translation`
- `translation` 字段存的是 `translation` 命名空间下的内容（即 `LocalePhrase.translation` 的子集）

**示例**（[mock 数据](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/__mocks__/custom-phrase.ts#L10-L23)）：

```typescript
const mockEnCustomPhrase = {
  tenantId: 'fake_tenant',
  id: mockId,
  languageTag: 'en',
  translation: {
    input: {
      username: 'Username 1',
      password: 'Password 2',
      email: 'Email 3',
    },
  },
} satisfies CustomPhrase;
```

> **关键点**：`CustomPhrase.translation` 只对应 `LocalePhrase.translation` 这一个命名空间的内容，不包含其他 namespace。

### 3.2 合并三步曲：trySafe → cleanDeep → deepmerge

`getPhrases()` 的合并过程分三步：

**Step 1: `trySafe(findCustomPhraseByLanguageTag(forLanguage))`**
- 从数据库查询自定义短语
- 用 `trySafe` 包裹，查询失败（如 404）时返回 `undefined`
- `?? {}` 兜底为空对象

**Step 2: `cleanDeep(...)`**
- 清除空字符串 `''`、`null`、`undefined`、空对象 `{}`
- 目的：用户设置空字符串表示"恢复默认"，不参与覆盖
- 测试验证：[phrase.test.ts#L53-L87](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/libraries/phrase.test.ts#L53-L87)

**Step 3: `deepmerge(base, customPhrase)`**
- 深度合并，自定义短语优先级更高（后者覆盖前者）
- 合并是递归的，只覆盖存在的 key，未覆盖的 key 保留基底值

### 3.3 三种语言场景的合并行为

根据单元测试 [phrase.test.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/libraries/phrase.test.ts)，`getPhrases()` 对不同语言有三种行为模式：

#### 场景一：内置语言 + 有自定义短语

```
输入语言: 'zh-CN'（内置语言，且有自定义短语）

基底: resource['zh-CN']  → 完整的中文内置短语
覆盖: customPhrase        → 中文自定义短语（增量）
结果: deepmerge(zh-CN内置, 中文自定义)
     → 完整的中文短语，自定义部分覆盖内置
```

测试用例：[phrase.test.ts#L103-L107](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/libraries/phrase.test.ts#L103-L107)

#### 场景二：内置语言 + 无自定义短语

```
输入语言: 'tr-TR'（内置语言，但没有自定义短语）

基底: resource['tr-TR']  → 完整的土耳其语内置短语
覆盖: {}                 → 空对象（查询失败或不存在）
结果: 土耳其语内置短语（原样返回）
```

测试用例：[phrase.test.ts#L109-L113](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/libraries/phrase.test.ts#L109-L113)

#### 场景三：非内置语言（custom-only）+ 有自定义短语

```
输入语言: 'fo-BA'（不在内置语言列表中，但有自定义短语）

基底: resource['en']     → 完整的英文内置短语  ← 关键：回退到英文
覆盖: customPhrase        → 自定义短语（增量）
结果: deepmerge(英文内置, 自定义短语)
     → 所有 key 都有英文值，自定义的 key 被覆盖为目标语言
```

测试用例：[phrase.test.ts#L115-L119](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/libraries/phrase.test.ts#L115-L119)

> **核心结论**：custom-only language 的**基底永远是英文**，不是空的。自定义语言本质上是"英文打底 + 自定义翻译覆盖"。

### 3.4 合并后的数据形态

合并后的返回值类型标注为 `LocalePhrase`，但实际运行时包含额外字段：

```typescript
// 类型上：LocalePhrase = { translation: { ... } }
// 实际上：deepmerge 把 CustomPhrase 的所有字段都合并进去了
{
  translation: { ... },    // 合并后的翻译内容（来自内置 + 自定义）
  id: 'xxx',               // ← 来自 CustomPhrase 的元数据
  tenantId: 'xxx',         // ← 来自 CustomPhrase 的元数据
  languageTag: 'fo-BA',    // ← 来自 CustomPhrase 的元数据
}
```

**这些额外字段的影响**：
- 传给 i18next 时，i18next 只会识别 `translation` 等 namespace 对应的 key
- `id`、`tenantId`、`languageTag` 等非 namespace 字段会被 i18next 忽略
- 类型上虽然标注为 `LocalePhrase`，但运行时数据更"胖"

### 3.5 覆盖边界

**自定义短语能覆盖的范围**：
- ✅ `translation` 命名空间下的任意子树（`input`、`action`、`error`、`mfa` 等）
- ✅ 可以只覆盖部分 key，其他保留内置
- ✅ 支持嵌套深度覆盖

**自定义短语不能做的事**：
- ❌ 不能新增命名空间（如新增一个 `errors` namespace）
- ❌ 不能新增 `translation` 下不存在的顶级 key（必须是内置短语的严格子集，验证见 [isStrictlyPartial](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/utils/translation.ts#L9-L26)）
- ❌ 空字符串会被 `cleanDeep` 清除，等同于"不覆盖"

---

## 四、对 i18next 资源的影响

### 4.1 后端合并 vs 前端 fallback

**关键设计**：后端已经保证了返回的语言包是**完整可用**的，前端不依赖 i18next 的 `fallbackLng` 机制。

原因：
1. 内置语言 → 返回完整的内置短语（本身就是完整的）
2. 内置语言 + 自定义 → 返回 deepmerge 后的完整语言包
3. 自定义语言（custom-only）→ 以英文为基底 + 自定义覆盖，也是完整的

所以**每个 getPhrases 返回的语言包都是全量翻译**，没有"缺失的 key"需要 i18next 在运行时 fallback。

### 4.2 三端的 i18next 配置对比

| 端 | 初始 resources | fallbackLng | 短语来源 |
|----|---------------|-------------|---------|
| **Experience** | `{ [lng]: phrases }` 一个语言 | **未设置** | SSR 优先，fallback 到 API |
| **Account** | `{}`（空） | `'en'` | 纯 API 加载 |
| **Console** | 所有语言全量加载 | 未显式设置 | 直接从 npm 包加载 |

#### Experience 端

**初始化**：[packages/experience/src/i18n/init.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/experience/src/i18n/init.ts#L10-L19)

```typescript
const initI18n = async (initialLanguage?: string) => {
  const { resources, lng } = await getI18nResource(initialLanguage);
  const options: InitOptions = {
    resources,    // { 'zh-CN': { translation: {...} } } — 只有一个语言
    lng,          // 'zh-CN'
    interpolation: { escapeValue: false },
  };
  await i18next.init(options);
};
```

**特点**：
- 没有显式 `fallbackLng`
- 初始只加载一个语言的资源
- 但因为后端返回的语言包已经是完整的（英文打底），所以不会出现 key 缺失

**语言切换时**：`changeLanguage()` 会重新请求 API 获取新语言包，然后通过 `addResourceBundle` 添加到 i18next。

#### Account 端

**初始化**：[packages/account/src/i18n/init.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/account/src/i18n/init.ts#L15-L22)

```typescript
await i18next.init({
  resources: {},       // 空！
  fallbackLng: 'en',   // ← 有显式 fallback
  interpolation: { escapeValue: false },
});
```

**特点**：
- 初始 resources 是空的
- 有 `fallbackLng: 'en'`
- 实际翻译资源在 `PageContextProvider` 中通过 `changeLanguage()` 异步加载
- `fallbackLng: 'en'` 是防御性配置——如果 API 加载失败，至少还能显示英文 key 名？不对，实际上英文资源也没加载进来

> **注意**：Account 端虽然设置了 `fallbackLng: 'en'`，但 `resources` 初始是空的，英文资源也没有内置。这个 fallback 更多是 i18next 的默认配置，实际英文翻译同样需要通过 API 获取。

#### Console 端

**初始化**：[packages/console/src/i18n/init.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/console/src/i18n/init.ts)

- 直接从 npm 包加载所有语言的所有资源
- 包含 `translation`、`errors`（来自 `@logto/phrases`）和 `experience` 命名空间
- 不依赖后端注入，没有自定义短语的概念

### 4.3 资源加载方式对比

**Experience 端的资源加载**：

```
i18next 实例
  └── 语言: 'zh-CN'
       └── namespace: translation
            ├── input: { ... }   ← 内置中文 + 自定义覆盖（已合并）
            ├── action: { ... }
            ├── error: { ... }
            └── ...
```

只有一个语言，但这个语言的 translation namespace 是完整的。

**语言切换后**：
```
i18next 实例
  ├── 语言: 'zh-CN'
  │    └── translation: { ... }
  └── 语言: 'en'
       └── translation: { ... }  ← 新增的语言包（也是完整的）
```

**Console 端的资源加载**：

```
i18next 实例
  ├── 语言: 'en'
  │    ├── translation: { ... }
  │    ├── errors: { ... }
  │    └── experience: { ... }
  ├── 语言: 'zh-CN'
  │    └── ...
  └── ... （所有 17 种语言）
```

所有语言一次性加载，有多个 namespace。

---

## 五、语言匹配流程

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

> **注意**：语言匹配（选哪个语言 tag）和 短语合并（用什么语言做基底）是**两个独立的步骤**。
> - 语言匹配：决定 `getPhrases()` 接收什么 language 参数
> - 短语合并：在 `getPhrases()` 内部，判断这个 language 是不是内置的，不是就用英文做基底

语言匹配底层工具：[packages/toolkit/language-kit/src/utility.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/toolkit/language-kit/src/utility.ts)

---

## 六、后端注入前端的两种方式

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

## 七、前端接收与使用

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

## 八、完整链路图

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
│   - 仅 @logto/phrases        │  │   - 内置短语为基底                    │
│   - 无自定义短语              │  │   - custom-only 语言用英文打底        │
│   - 供 koaI18next 中间件用    │  │   - deepmerge + cleanDeep 合并       │
│                               │  │   - 数据源: custom_phrases 表        │
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
│    - 否则请求 /.well-known/phrases         - 初始 resources 为空          │
│    - 单语言加载，切换时新增                 - fallbackLng: 'en'（防御性）  │
│    - 无显式 fallbackLng                    - PageContextProvider 中异步    │
│                                                                          │
│  Console:                                                                 │
│    - 直接从 npm 包全量加载（无后端注入）                                    │
│    - 所有语言 + 多个 namespace                                            │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 九、关键设计要点

### 短语合并与覆盖
1. **自定义短语 = 增量覆盖**：数据库只存差异，通过 `deepmerge` 深度合并，自定义优先级更高
2. **custom-only 语言用英文打底**：不在内置列表中的语言，以英文内置短语为基底，再叠加自定义翻译
3. **空值清除**：`cleanDeep` 清除空字符串，用户可用空值表示"恢复默认"
4. **完整语言包输出**：`getPhrases` 返回的永远是完整可用的语言包，不会有缺失的 key

### 两套 i18n 系统
5. **两套 i18n 系统分离**：后端自用的全局 i18next（用 `@logto/phrases`，无自定义） vs 给前端体验端的 Phrase Library（用 `@logto/phrases-experience` + 自定义短语）
6. **请求级 i18n 实例**：`koaI18next` 为每个请求 clone 一个 i18next 实例，避免异步请求间的语言状态互相污染

### 注入与前端
7. **双路径注入**：SSR 保证首屏性能和无闪屏，API 支持运行时语言切换，前端优先使用 SSR 数据
8. **后端合并替代前端 fallback**：后端已保证语言包完整性，前端 Experience 端不需要设置 `fallbackLng`
9. **命名空间隔离**：`@logto/phrases-experience` 只有 `translation` 一个 namespace，Console 端通过 `experience` namespace 引入供预览

### 语言匹配
10. **语言匹配与短语合是两步**：先选语言 tag（考虑自定义与内置），再在 getPhrases 内部决定用什么做基底
11. **多级 fallback**：精确匹配 → 基础语言匹配 → 内置语言兜底，同时考虑自定义语言和内置语言
12. **缓存分层**：well-known 缓存减少数据库查询，upsert/delete 时主动失效
