# 审计日志中间件完整链路分析

## 1. 整体架构概述

审计日志系统是一个从**请求进入**到**持久化存储**再到**查询展示**的完整链路。核心设计采用了「中间件注入上下文 + 业务代码显式记录 + 自动收集上下文 + 批量持久化」的模式。

```
请求进入 → 中间件挂载 → 业务处理(createLog/append) → 异常捕获 → 上下文自动补充 → 批量持久化 → API查询 → 前端展示
```

---

## 2. 核心文件清单

| 模块 | 文件路径 | 职责 |
|------|---------|------|
| 中间件核心 | `packages/core/src/middleware/koa-audit-log.ts` | 上下文注入、日志收集、持久化触发 |
| 数据库操作 | `packages/core/src/queries/log.ts` | 日志的插入、查询、统计 |
| API 路由 | `packages/core/src/routes/log.ts` | 对外暴露审计日志查询接口 |
| 类型定义 | `packages/schemas/src/types/log/index.ts` | 日志 Key 类型、字段定义 |
| 前端面板 | `packages/console/src/components/AuditLogTable/index.tsx` | 审计日志查询 UI |
| Experience 补充 | `packages/core/src/routes/experience/middleware/koa-experience-audit-log.ts` | Experience 路由补充 applicationId 上下文 |
| 头部注入 | `packages/core/src/utils/injected-header-mapping.ts` | 从请求头提取地理位置等信息 |

---

## 3. 中间件核心实现详解

### 3.1 中间件工厂函数 (`koa-audit-log.ts:128-198)

```typescript
export default function koaAuditLog<StateT, ContextT extends IRouterParamContext, ResponseBodyT>({
  logs: { insertLog },
}: Queries): MiddlewareType<StateT, WithLogContext<ContextT>, ResponseBodyT>
```

**核心机制：**

1. **上下文注入**：向 Koa ctx 注入两个方法
   - `ctx.createLog(key: LogKey)` - 创建日志条目
   - `ctx.prependAllLogEntries(payload)` - 批量前置补充字段

2. **日志条目收集**：使用闭包数组 `entries: LogEntry[]` 收集本次请求的所有日志

3. **生命周期钩子**：
   - `try { await next() }` - 执行业务逻辑
   - `catch` - 异常时自动标记所有日志为 Error
   - `finally` - 无论成功失败都执行持久化

### 3.2 LogEntry 类 (`koa-audit-log.ts:45-70)

```typescript
export class LogEntry {
  payload: LogContextPayload;

  constructor(public readonly key: LogKey) {
    this.payload = { key, result: LogResult.Success };
  }

  prepend(data: Readonly<LogPayload>) { ... }  // 前置合并（优先级高）
  append(data: Readonly<LogPayload>) { ... }   // 后置合并（优先级低，自动脱敏）
}
```

**设计要点：**
- `prepend` 用于注入通用上下文（如 IP、UA），不脱敏
- `append` 用于业务数据，自动递归脱敏 `password` / `secret` 字段
- 合并策略：对象浅拷贝，后合并的覆盖先合并的

### 3.3 敏感数据脱敏 (`koa-audit-log.ts:16-40)

```typescript
const sensitiveDataKeys = Object.freeze(['password', 'secret']);

const filterSensitiveData = (data: Record<string, unknown>): Record<string, unknown> => {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      return [key, sensitiveDataKeys.includes(key) ? '******' : sanitise(value)];
    })
  );
};
```

- 递归遍历对象和数组
- 匹配 `password` 和 `secret` 字段替换为 `******`
- 仅在 `append` 时触发，`prepend` 不触发

---

## 4. 中间件挂载位置

### 4.1 Experience 路由 (`routes/init.ts:72)

```typescript
const experienceRouter: AnonymousRouter = new Router();
experienceRouter.use(koaAuditLog(tenant.queries));  // 挂载审计日志
experienceRouter.use(koaEmailI18n(tenant.queries));
experienceApiRoutes(experienceRouter, tenant);
```

- **覆盖范围**：所有 `/experience/** 路由

### 4.2 OIDC Provider (`oidc/init.ts:422)

```typescript
// Provide audit log context for event listeners
oidc.use(koaAuditLog(queries));
```

- **覆盖范围**：所有 OIDC 相关请求（授权、token、userinfo 等）
- **用途**：供 OIDC 事件监听器使用，如 `authorization.success`

### 4.3 Experience 审计日志补充中间件 (`routes/experience/middleware/koa-experience-audit-log.ts)

```typescript
export default function koaExperienceAuditLog() {
  return async (ctx, next) => {
    const { prependAllLogEntries, interactionDetails } = ctx;
    const applicationId = conditionalString(interactionDetails.params.client_id);

    try {
      await next();
    } finally {
      prependAllLogEntries({ applicationId });
    }
  };
}
```

- 在业务逻辑执行完成后，自动为所有日志补充 `applicationId`
- 从 `interactionDetails` 中提取 `client_id`

---

## 5. 上游身份与请求上下文挂钩

### 5.1 自动注入的上下文字段 (`koa-audit-log.ts:162-186)

在 `finally` 块中，自动为每个日志条目注入：

| 字段 | 来源 | 说明 |
|------|------|------|
| `ip` | `ctx.request.ip` | 请求 IP 地址 |
| `userAgent` | `ctx.request.headers['user-agent']` | 原始 User-Agent |
| `userAgentParsed` | `UAParser(userAgentValue).getResult()` | 解析后的 UA 信息（浏览器、OS、设备） |
| `signInContext` | `getInjectedHeaderValues()` | 从请求头提取的地理位置等信息 |

### 5.2 注入头部映射 (`utils/injected-header-mapping.ts)

```typescript
export const defaultInjectedHeaderMapping: InjectedHeaderMapping = Object.freeze({
  country: 'x-logto-cf-country',
  city: 'x-logto-cf-city',
  latitude: 'x-logto-cf-latitude',
  longitude: 'x-logto-cf-longitude',
  botScore: 'x-logto-cf-bot-score',
  botVerified: 'x-logto-cf-bot-verified',
});
```

- 从 Cloudflare 等反向代理注入的请求头中提取地理位置和风险信息
- 支持通过环境变量 `INJECTED_HEADER_MAPPING_JSON` 自定义映射
- 开发环境支持通过 `DEBUG_INJECTED_HEADERS_JSON` 模拟注入

### 5.3 业务代码显式记录示例 (`routes/experience/index.ts:74-76)

```typescript
const { createLog } = ctx;
createLog(`Interaction.${interactionEvent}.Create`);
```

业务代码通过 `ctx.createLog()` 创建日志条目，然后通过 `log.append()` 补充业务字段。

---

## 6. 日志 Key 类型系统

### 6.1 类型定义 (`schemas/src/types/log/index.ts)

```typescript
export type AuditLogKey =
  | typeof LogKeyUnknown
  | InteractionLogKey
  | TokenLogKey
  | SamlLogKey
  | JwtCustomizerLogKey;
```

### 6.2 Interaction Log Key 结构 (`schemas/src/types/log/interaction.ts)

```typescript
export type LogKey =
  | `${Prefix}.${Action.Create | Action.End}
  | `${Prefix}.${InteractionEvent}.${Action.Create | Action.Update | Action.Submit}
  | `${Prefix}.${InteractionEvent}.${Field.Profile}.${Action.Update}
  | `${Prefix}.${InteractionEvent}.${Field.Identifier}.${Method}.${Action}
  | ...
```

**命名规范**：`{Prefix}.{InteractionEvent}.{Field?}.{Method?}.{Action}`

示例：
- `Interaction.SignIn.Create`
- `Interaction.SignIn.Identifier.Password.Submit`
- `Interaction.ForgotPassword.Profile.Update`

---

## 7. 持久化层

### 7.1 数据库表结构

```sql
-- logs 表包含字段：
id (主键)
key (日志类型)
payload (JSONB 字段，存储所有日志数据)
createdAt (创建时间)
```

### 7.2 插入逻辑 (`queries/log.ts:77)

```typescript
const insertLog = buildInsertIntoWithPool(pool)(Logs);
```

使用通用插入构建器，批量插入：

```typescript
await Promise.all(
  entries.map(async ({ payload }) => {
    return insertLog({
      id: generateStandardId(),
      key: payload.key,
      payload: { ...basePayload, ...payload },
    });
  })
);
```

- 每个日志条目生成独立 ID
- `basePayload`（自动注入的上下文）与 `payload`（业务数据）合并
- 并行插入所有日志

### 7.3 查询逻辑 (`queries/log.ts:107-115)

```typescript
const findLogs = async (limit: number, offset: number, logCondition: LogCondition) =>
  pool.any<Log>(sql`
    select ${sql.join(Object.values(fields), sql`,`)}
    from ${table}
    ${buildLogConditionSql(logCondition)}
    order by ${fields.createdAt} desc
    limit ${limit}
    offset ${offset}
  `);
```

支持的过滤条件：
- `logKey` - 精确匹配日志类型
- `payload.applicationId` - JSONB 字段匹配
- `payload.userId` - JSONB 字段匹配
- `startTime` / `endTime` - 时间范围
- `includeKeyPrefix` - 日志类型前缀匹配（如 `Interaction.`、`ExchangeTokenBy.`）

### 7.4 性能优化：计数上限 (`queries/log.ts:79-105)

```typescript
const LOGS_COUNT_CAP = 10_000;

const countLogs = async (condition: LogCondition, options?: { capped?: boolean }) => {
  if (!options?.capped) {
    // 正常计数
  }

  const cappedLimit = LOGS_COUNT_CAP + 1;
  // 限制计数到 10001 条，避免大表全表扫描
};
```

- 当 `enableCap=true` 时，最多计数到 10,001 条
- 超过则返回 `isCapped: true`
- 解决大日志表 `count(*)` 性能问题

---

## 8. API 层

### 8.1 列表查询 (`routes/log.ts:24-87)

```typescript
router.get(
  '/logs',
  koaPagination(),
  koaGuard({
    query: object({
      userId: string().optional(),
      applicationId: string().optional(),
      logKey: string().optional(),
      enableCap: string().optional(),
      start_time: string().optional(),
      end_time: string().optional(),
    }),
    response: Logs.guard.array(),
    status: [200, 400],
  }),
  async (ctx, next) => {
    // ...
  }
);
```

**查询白名单** (`routes/log.ts:49-57`)：

```typescript
const includeKeyPrefix: AuditLogPrefix[] = [
  token.Type.ExchangeTokenBy,
  token.Type.RevokeToken,
  token.Type.RevokeGrants,
  interaction.prefix,
  jwtCustomizer.prefix,
  saml.prefix,
  LogKeyUnknown,
];
```

仅允许查询上述前缀的日志，避免泄露 webhook 等内部日志。

### 8.2 详情查询 (`routes/log.ts:89-101)

```typescript
router.get(
  '/logs/:id',
  koaGuard({ params: object({ id: string().min(1) }),
  response: Logs.guard,
  status: [200, 404],
}),
```

---

## 9. 前端查询面板

### 9.1 AuditLogTable 组件 (`console/src/components/AuditLogTable/index.tsx)

**核心功能：**
1. **分页查询**：使用 SWR 进行数据请求和缓存
2. **过滤条件**：
   - 事件类型（EventSelector）
   - 应用筛选（ApplicationSelector）
   - 时间范围（TimeRangePicker）
3. **表格展示**：
   - 事件名称 + 状态
   - 用户信息
   - 应用信息
   - 时间

### 9.2 查询参数构建

```typescript
const url = buildUrl('api/logs', {
  page: String(page),
  page_size: String(pageSize),
  enableCap: 'true',
  ...conditional(event && { logKey: event }),
  ...conditional(searchApplicationId && { applicationId: searchApplicationId }),
  ...conditional(userId && { userId }),
  ...conditional(isDevFeaturesEnabled && startTime !== undefined && { start_time: String(startTime) }),
  ...conditional(isDevFeaturesEnabled && endTime !== undefined && { end_time: String(endTime) }),
});
```

---

## 10. 完整调用链路示例

### 10.1 登录流程示例

```
1. 请求进入 /experience PUT /experience
   ↓
2. koaAuditLog 中间件执行
   - 注入 ctx.createLog 和 ctx.prependAllLogEntries
   ↓
3. 业务代码执行
   - ctx.createLog('Interaction.SignIn.Create')
   ↓
4. koaExperienceAuditLog 执行
   - prependAllLogEntries({ applicationId: 'app_123' })
   ↓
5. finally 块执行
   - 注入 ip、userAgent、userAgentParsed、signInContext
   - 调用 insertLog 批量插入
```

### 10.2 异常流程示例

```
1. 请求进入
   ↓
2. ctx.createLog('Interaction.SignIn.Identifier.Password.Submit')
   ↓
3. 业务抛出 RequestError
   ↓
4. catch 块执行
   - 所有日志 result = LogResult.Error
   - 附加 error 字段（message、code、data）
   ↓
5. 重新抛出异常
   ↓
6. finally 块执行
   - 注入上下文并持久化
```

---

## 11. 设计亮点

1. **非侵入式设计**：中间件注入上下文，业务代码按需记录
2. **自动脱敏**：敏感字段自动替换，避免人为遗漏
3. **批量持久化**：一次请求多个日志批量插入
4. **上下文自动补充**：IP、UA、地理位置等自动注入
5. **异常自动标记**：异常时自动标记所有日志为失败
6. **性能优化**：大表计数上限，避免全表扫描
7. **类型安全**：LogKey 采用模板字面量类型，编译时检查

---

## 12. 注意事项

1. **日志条目生命周期**：LogEntry 实例需保存好，多个地方 append 需传递
2. **prepend vs append**：prepend 不脱敏，append 脱敏
3. **中间件顺序**：koaAuditLog 需在业务中间件之前挂载
4. **查询白名单**：新增日志类型需在 includeKeyPrefix 中添加才能在管理后台查询
5. **性能考虑**：日志量大时注意日志表分区或归档策略
