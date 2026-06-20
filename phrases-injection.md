# i18n 词条与 phrases 后端注入流程理解

## 概述

Logto 的 i18n 体系由 **内置短语包（phrases packages）** + **后端自定义短语（custom phrases）** + **前端 i18next 运行时** 三部分组成。后端负责将内置短语与自定义短语合并后，通过两种方式注入前端：

1. **SSR 注入**：在 HTML 响应中直接注入 `window.logtoSsr`
2. **API 接口**：通过 `/.well-known/phrases` 接口动态获取

---

## 一、词条资源包（Phrases Packages）

项目中有两个独立的 phrases npm 包：

### 1. `@logto/phrases`

- **路径**：[packages/phrases/](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/phrases)
- **用途**：通用短语包，包含 Admin Console、错误码、OIDC 等翻译
- **命名空间**：`translation`（含 `admin_console` 子树）、`errors`
- **入口**：[packages/phrases/src/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/phrases/src/index.ts#L80-L98)

```typescript
// 导出所有语言的完整资源
const resource: Resource = {
  ar, de, en, es, fr, it, ja, ko,
  'pl-PL': plPL, 'pt-BR': ptBR, 'pt-PT': ptPT,
  ru, th, 'tr-TR': trTR, 'zh-CN': zhCN, 'zh-HK': zhHK, 'zh-TW': zhTW,
};
export default resource;
```

每个语言目录结构：
```
locales/en/
  ├── index.ts          # 组装 translation + errors
  ├── translation/
  │   ├── index.ts      # 汇总各模块
  │   ├── admin-console/
  │   ├── demo-app.ts
  │   └── oidc.ts
  └── errors/
      └── index.ts
```

### 2. `@logto/phrases-experience`

- **路径**：[packages/phrases-experience/](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/phrases-experience)
- **用途**：体验端（登录注册页、账户中心）专用短语包
- **命名空间**：`translation`（包含 `input`、`action`、`error`、`mfa`、`profile` 等子树）
- **入口**：[packages/phrases-experience/src/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/phrases-experience/src/index.ts#L64-L84)

> **注意**：experience 包的语言数量比 phrases 包多（如 `cs`、`uk-UA` 等），两者独立维护。

---

## 二、后端词条加载与合并

### 核心：`createPhraseLibrary`

位置：[packages/core/src/libraries/phrase.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/libraries/phrase.ts#L9-L23)

```typescript
export const createPhraseLibrary = (queries: Queries) => {
  const { findCustomPhraseByLanguageTag, findAllCustomLanguageTags } = queries.customPhrases;

  const getPhrases = async (forLanguage: string): Promise<LocalePhrase> => {
    return deepmerge<LocalePhrase>(
      resource[isBuiltInLanguageTag(forLanguage) ? forLanguage : 'en'],
      cleanDeep((await trySafe(findCustomPhraseByLanguageTag(forLanguage))) ?? {})
    );
  };

  return { getPhrases, findAllCustomLanguageTags };
};
```

**合并逻辑**：
1. 取内置短语作为基底（如果语言 tag 不是内置的，fallback 到 `en`）
2. 从数据库查询该语言的自定义短语（可能不存在）
3. 用 `cleanDeep` 清除空值后，通过 `deepmerge` 深度合并到内置短语上
4. 自定义短语优先级 > 内置短语

### 自定义短语存储

- **数据表**：`custom_phrases`，字段：`id`、`tenantId`、`languageTag`、`translation`
- **查询层**：[packages/core/src/queries/custom-phrase.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/queries/custom-phrase.ts)
- **管理 API**：[packages/core/src/routes/custom-phrase.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/routes/custom-phrase.ts)（CRUD，验证翻译结构必须是内置短语的严格子集）

### 缓存机制

自定义短语查询通过 `WellKnownCache` 缓存：

- 缓存 key：`custom-phrases:{languageTag}`、`custom-phrases-tags`
- 位置：[packages/core/src/caches/well-known.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/caches/well-known.ts)
- upsert/delete 操作会自动失效对应缓存

---

## 三、语言检测与匹配

### 语言解析优先级

位置：[packages/core/src/utils/i18n.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/utils/i18n.ts#L36-L82)

`getExperienceLanguage` 函数按以下优先级匹配语言：

1. 明确传入的 `lng` 参数
2. 自动检测（来自请求 header `Accept-Language` 或 query `locale`）
3. sign-in experience 配置的 `fallbackLanguage`

对每个候选语言，按以下顺序尝试匹配：
1. 自定义语言的精确匹配
2. 内置语言的精确匹配
3. 内置语言的基础语言匹配（如 `zh` 匹配到 `zh-CN`）
4. 自定义语言的基础语言匹配

### 请求端语言检测

位置：[packages/core/src/i18n/detect-language.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/i18n/detect-language.ts)

从以下位置提取语言：
- query 参数：`locale`
- header：`Accept-Language`（解析 q 值并排序）

---

## 四、后端注入前端的两种方式

### 方式一：SSR 注入（首选）

位置：[packages/core/src/middleware/koa-experience-ssr.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/middleware/koa-experience-ssr.ts)

**工作原理**：
1. 中间件在 `await next()` 之后执行（后置处理）
2. 检查响应体是否为字符串、是否为 index path、是否包含 `ssrPlaceholder`
3. 如果满足条件，预加载 sign-in experience 和 phrases 数据
4. 用 `JSON.stringify` 序列化后替换 HTML 中的 `"__LOGTO_SSR__"` 占位符

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
    lng: string;
    data: LocalePhrase;
  };
};
```

**HTML 中的占位符**（[index.html](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/experience/index.html#L9-L12)）：

```html
<script>
  window.logtoSsr = "__LOGTO_SSR__";
</script>
```

**特点**：
- 首屏无请求延迟，直接可用
- 防止主题闪屏（theme flash）
- 只在访问 experience 应用的 index 页面时触发

### 方式二：`.well-known/phrases` API

位置：[packages/core/src/routes/well-known/index.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/core/src/routes/well-known/index.ts#L60-L83)

```typescript
router.get('/.well-known/phrases',
  koaGuard({
    query: z.object({ lng: z.string().optional() }),
    response: z.record(z.string().or(z.record(z.unknown()))),
    status: 200,
  }),
  async (ctx, next) => {
    const { lng } = ctx.guard.query;
    const { languageInfo } = await findDefaultSignInExperience();
    const customLanguages = await findAllCustomLanguageTags();
    const language = getExperienceLanguage({ ctx, languageInfo, customLanguages, lng });

    ctx.set('Content-Language', language);
    ctx.body = await getPhrases(language);
    return next();
  }
);
```

**特点**：
- 用于动态切换语言时获取新的短语包
- 返回 `Content-Language` header 标识实际返回的语言
- 前端用于语言切换场景

---

## 五、前端接收与使用

### Experience 端

**初始化流程**（[packages/experience/src/i18n/utils.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/experience/src/i18n/utils.ts)）：

1. **优先使用 SSR 数据**：检查 `window.logtoSsr` 是否为对象且语言匹配
2. **否则请求 API**：调用 `/.well-known/phrases` 获取
3. **加载失败 fallback**：使用内置的英文包

```typescript
const getPhrases = async (language?: string) => {
  // 1. 尝试 SSR 数据
  if (isObject(logtoSsr) && (!preferredLanguage || logtoSsr.phrases.lng === (language ?? uiLocalesFirst))) {
    return { phrases: logtoSsr.phrases.data, lng: logtoSsr.phrases.lng };
  }

  // 2. 请求 API
  const response = await getPhrasesApi({ localLanguage, language: preferredLanguage });
  const remotePhrases = await response.json<LocalePhrase>();
  const lng = response.headers.get('Content-Language');

  return { phrases: remotePhrases, lng };
};
```

**语言切换**：`changeLanguage` 函数重新获取资源并添加到 i18next，然后切换语言。

**全局类型声明**：[packages/experience/src/include.d/global.d.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/experience/src/include.d/global.d.ts#L13-L17)

### Account 端

位置：[packages/account/src/i18n/utils.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/account/src/i18n/utils.ts)

- 初始化时不加载任何短语资源（空 resources）
- 在 `PageContextProvider` 中通过 `changeLanguage()` 异步加载
- 同样调用 `/.well-known/phrases` API 获取

### Console 端

位置：[packages/console/src/i18n/init.ts](file:///d:/fz/0601-2/solo-dogfeeding/code/70-logto/packages/console/src/i18n/init.ts)

- **不依赖后端注入**，直接从 npm 包加载所有语言资源
- 加载 `@logto/phrases`（translation + errors 命名空间）和 `@logto/phrases-experience`（experience 命名空间）
- 使用浏览器语言检测（localStorage / sessionStorage）

```typescript
// 加载所有语言的 phrases
for (const [language, values] of Object.entries(resources)) {
  i18next.addResourceBundle(language, 'translation', values.translation, true);
  i18next.addResourceBundle(language, 'errors', values.errors, true);
}

// 加载 experience 短语到独立的 namespace
for (const [language, values] of Object.entries(experienceResource)) {
  i18next.addResourceBundle(language, 'experience', values.translation, true);
}
```

---

## 六、完整链路总结

```
┌──────────────────────────────────────────────────────────────────┐
│                     内置短语包 (Build-time)                       │
│  @logto/phrases         @logto/phrases-experience                │
│  (console通用)           (experience登录页)                       │
└──────────────────────────────┬───────────────────────────────────┘
                               │ import
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                     后端 Phrase Library                          │
│  createPhraseLibrary(queries)                                    │
│  - getPhrases(language): deepmerge(内置, 自定义)                 │
│  - 数据源: custom_phrases 表 + WellKnownCache 缓存              │
└──────────────────────────────┬───────────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
┌─────────────────────────────┐   ┌─────────────────────────────┐
│  SSR 注入                    │   │  /.well-known/phrases API   │
│  koa-experience-ssr.ts      │   │  well-known/index.ts        │
│  替换 HTML 中的 __LOGTO_SSR__│   │  返回短语 JSON + Content-Lang│
└──────────────┬──────────────┘   └──────────────┬──────────────┘
               │                                   │
               │                                   │
               ▼                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│                     前端 i18next 运行时                           │
│                                                                  │
│  Experience / Account:                                           │
│    - 优先读 SSR (logtoSsr.phrases)                               │
│    - 否则请求 API                                                │
│    - 动态添加资源包、切换语言                                    │
│                                                                  │
│  Console:                                                        │
│    - 直接从 npm 包加载所有语言（无后端注入）                      │
│    - 含 experience namespace 供预览使用                          │
└──────────────────────────────────────────────────────────────────┘
```

---

## 七、关键设计要点

1. **自定义短语 = 增量覆盖**：只存差异，不存全量；通过 `deepmerge` 合并到内置短语
2. **双路径注入**：SSR 保证首屏性能，API 支持运行时切换
3. **语言匹配多级 fallback**：精确匹配 → 基础语言匹配 → 内置语言
4. **缓存分层**：well-known 缓存减少数据库查询
5. **Console 与 Experience 分离**：Console 全量内置，Experience 依赖后端注入（因为要支持自定义短语）
6. **命名空间隔离**：errors、translation、experience 等独立 namespace，避免冲突
