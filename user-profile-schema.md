# 自定义用户资料字段 Schema 与校验一致性深度分析

## 一、整体架构概览

自定义用户资料字段系统采用五层架构设计：

```
┌─────────────────────────────────────────────────────────────┐
│                      前端体验层 (Experience)                │
│  ExtraProfileForm → use-validate-field → PrimitiveProfileInputField │
├─────────────────────────────────────────────────────────────┤
│                      前端管理层 (Console)                   │
│  ProfileFieldDetailsForm → ProfileFieldPartSubForm          │
│                    ↓ parseFormDataToRequestPayload          │
├─────────────────────────────────────────────────────────────┤
│                      后端 API 层 (Routes)                   │
│  koaGuard (types guard) → validateCustomProfileFieldData    │
├─────────────────────────────────────────────────────────────┤
│                      后端 Schema 层 (Schemas)               │
│  types/custom-profile-fields.ts + foundations/jsonb-types   │
├─────────────────────────────────────────────────────────────┤
│                      数据库层 (PostgreSQL)                  │
│  custom_profile_fields 表 + JSONB 存储                      │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、写入阶段校验生效层级深度分析

### 2.1 SQL 表结构与 tsType 绑定

**文件**: `packages/schemas/tables/custom_profile_fields.sql:10`

```sql
config jsonb /* @use CustomProfileFieldConfig */ not null default '{}'::jsonb,
```

**关键机制**：
- 通过 `/* @use CustomProfileFieldConfig */` 注释将 SQL 字段与 TypeScript 类型绑定
- `parseType` 函数（`gen/utils.ts:210`）提取 `tsType` 为 `CustomProfileFieldConfig`
- 代码生成时会导入 `customProfileFieldConfigGuard` 并用于 `createGuard` 和 `guard`

### 2.2 两套 schema 的定义与关系

#### foundations 层（底层基础类型）
**文件**: `packages/schemas/src/foundations/jsonb-types/custom-profile-fields.ts:29-39, 56-61`

```typescript
// 基础配置 guard - 包含强约束
export const baseConfigGuard = z.object({
  placeholder: z.string().max(256).optional(),
  minLength: z.number().int().min(0).optional(),    // ⚠️ 强约束：整数 + 非负
  maxLength: z.number().int().min(0).optional(),    // ⚠️ 强约束：整数 + 非负
  minValue: z.number().int().min(0).optional(),     // ⚠️ 强约束：整数 + 非负
  maxValue: z.number().int().min(0).optional(),     // ⚠️ 强约束：整数 + 非负
  format: z.string().max(128).optional(),
  customFormat: z.string().max(128).optional(),
  options: fieldOptionsGuard.optional(),
  defaultValue: z.string().optional(),
});

// 扩展后的配置 guard
export const customProfileFieldConfigGuard = baseConfigGuard.extend({
  parts: z.array(fieldPartGuard).optional(),
});

export type CustomProfileFieldConfig = z.infer<typeof customProfileFieldConfigGuard>;
```

#### types 层（业务类型定义）
**文件**: `packages/schemas/src/types/custom-profile-fields.ts:44-73`

导入 foundations 层的基础类型，但**独立定义 config 约束，缺失强校验**：

```typescript
// Text 字段 - 缺失 .int().min(0) 约束！
export const textProfileFieldGuard = baseProfileFieldGuard.extend({
  type: z.literal(CustomProfileFieldType.Text),
  config: z
    .object({
      placeholder: z.string().optional(),
      minLength: z.number().optional(),      // ❌ 缺失 .int().min(0)
      maxLength: z.number().optional(),      // ❌ 缺失 .int().min(0)
    })
    .optional(),
});

// Number 字段 - 同样缺失 .int().min(0) 约束！
export const numberProfileFieldGuard = baseProfileFieldGuard.extend({
  type: z.literal(CustomProfileFieldType.Number),
  config: z
    .object({
      placeholder: z.string().optional(),
      minValue: z.number().optional(),       // ❌ 缺失 .int().min(0)
      maxValue: z.number().optional(),       // ❌ 缺失 .int().min(0)
    })
    .optional(),
});

// 联合类型 - 用于 API 请求校验
export const customProfileFieldUnionGuard = z.discriminatedUnion('type', [
  textProfileFieldGuard, numberProfileFieldGuard, /* ...其他类型 */
]);
```

#### 生成的数据库 schema
**生成位置**: `src/db-entries/custom-profile-fields.ts`（自动生成）

根据 `generateSchema` 函数逻辑（`gen/schema.ts:75-99`），生成的代码如下：

```typescript
// 自动生成的 createGuard - 理论上包含 foundations 层约束
const createGuard: Guard<CreateCustomProfileField> = z.object({
  tenantId: z.string().optional(),
  id: z.string().optional(),
  name: z.string().min(1).max(128),
  type: customProfileFieldTypeGuard,  // 使用 foundations 层
  label: z.string().max(128),
  description: z.string().max(256).nullable().optional(),
  required: z.boolean(),
  config: customProfileFieldConfigGuard,  // ⚠️ 理论上使用 foundations 层！
  createdAt: z.number().optional(),
  sieOrder: z.number().optional(),
});

// 自动生成的 guard - 用于读取校验
const guard: Guard<CustomProfileField> = z.object({
  // ... 其他字段相同
  config: customProfileFieldConfigGuard,  // ⚠️ 使用 foundations 层！
});

export const CustomProfileFields: GeneratedSchema<...> = Object.freeze({
  table: 'custom_profile_fields',
  // ...
  createGuard,  // 包含 foundations 层强约束
  guard,        // 包含 foundations 层强约束
  updateGuard: guard.partial(),
});
```

---

## 三、三条写入路径的逐段核对

### 3.1 CREATE 路径完整调用链

**路由**: `POST /custom-profile-fields`
**文件**: `packages/core/src/routes/custom-profile-fields.ts:68-83`

```typescript
// 第1层：API 入口校验 - koaGuard
koaGuard({
  body: customProfileFieldUnionGuard,  // ✅ types 层，弱约束（无 .int().min(0)）
  response: CustomProfileFields.guard, // ✅ foundations 层，强约束
  status: [201, 400],
})

// 第2层：业务处理
async (ctx, next) => {
  const { body } = ctx.guard;  // 经过 types 层校验的数据
  ctx.body = await createCustomProfileField(body);  // isStrict = false
  ctx.status = 201;
  return next();
}
```

**业务层**: `packages/core/src/libraries/custom-profile-fields/index.ts:71-83`

```typescript
export const createCustomProfileField = async (data: CustomProfileFieldUnion) => {
  // 第2层：业务逻辑校验 - validateCustomProfileFieldData
  validateCustomProfileFieldData(data);  // isStrict 默认 false

  // 构造数据库记录
  const { id, ...rest } = data satisfies CustomProfileFieldUnion;
  const row: InsertableCustomProfileField = {
    id: id ?? generateStandardId(),
    ...rest,
  };

  // 第3层：数据库写入
  return insertCustomProfileFields(row);
};
```

**数据库操作层**: `packages/core/src/database/insert-into.ts:77-106`

```typescript
return async (data: OmitAutoSetFields<CreateSchema>): Promise<Schema | void> => {
  const insertingKeys = keys.filter((key) => has(data, key));
  
  // ❌ 关键：没有调用 schema.createGuard.parse(data)！
  // 数据直接转换为 SQL 值，没有 Zod 校验
  
  const { rows: [entry] } = await pool.query<Schema>(sql`
    insert into ${table} (${sql.join(
      insertingKeys.map((key) => fields[key]),
      sql`, `
    )})
    values (${sql.join(
      insertingKeys.map((key) => convertToPrimitiveOrSql(key, data[key] ?? null)),
      sql`, `
    )})
    returning *
  `);

  return entry;  // 返回数据会被 koaGuard response 校验
};
```

**CREATE 路径校验总结**:

| 阶段 | 使用的 guard | 约束强度 | Text/Number min/max | 执行与否 |
|-----|-------------|---------|---------------------|---------|
| API 入口 | `customProfileFieldUnionGuard` (types 层) | 🟡 弱 | `z.number()` | ✅ 执行 |
| 业务逻辑 | `validateTextProfileField` | 🟡 中 | `min <= max` | ✅ 执行 |
| 数据库写入前 | `CustomProfileFields.createGuard` | 🔴 强 | `z.number().int().min(0)` | ❌ **不执行** |
| 数据库写入后（response） | `CustomProfileFields.guard` | 🔴 强 | `z.number().int().min(0)` | ✅ 执行 |

### 3.2 BATCH 路径完整调用链

**路由**: `POST /custom-profile-fields/batch`
**文件**: `packages/core/src/routes/custom-profile-fields.ts:85-101`

```typescript
// 第1层：API 入口校验
koaGuard({
  body: z.array(customProfileFieldUnionGuard).max(20),  // ✅ types 层，弱约束
  response: z.array(CustomProfileFields.guard),          // ✅ foundations 层，强约束
  status: [201, 400],
})

// 第2层：业务处理
async (ctx, next) => {
  const { body } = ctx.guard;
  const created = await libraries.customProfileFields.createCustomProfileFieldsBatch(body);
  ctx.body = created;
  ctx.status = 201;
  return next();
}
```

**业务层**: `packages/core/src/libraries/custom-profile-fields/index.ts:85-99`

```typescript
export const createCustomProfileFieldsBatch = async (data: CustomProfileFieldUnion[]) => {
  // 第2层：循环校验每个 item
  for (const item of data) {
    validateCustomProfileFieldData(item);  // isStrict = false
  }

  // 构造数据库记录
  const rows = data.map<InsertableCustomProfileField>((item) => ({
    ...item,
    id: item.id ?? generateStandardId(),
  }));

  // 第3层：批量数据库写入
  return bulkInsertCustomProfileFields(rows);
};
```

**数据库操作层**: `packages/core/src/database/insert-into.ts:134-173`

```typescript
return async (data: ReadonlyArray<OmitAutoSetFields<CreateSchema>>) => {
  // ❌ 同样：没有调用 schema.createGuard.parse()！
  // 每个 item 都直接转换为 SQL 值
  
  const valuesTuples = data.map(
    (row) => sql`(${sql.join(
      insertingKeys.map((key) =>
        has(row, key) ? convertToPrimitiveOrSql(key, row[key] ?? null) : sql`default`
      ),
      sql`, `
    )})`
  );

  const { rows: inserted } = await pool.query<Schema>(sql`
    insert into ${table} (...) values ${sql.join(valuesTuples, sql`, `)}
    returning *
  `);

  return inserted;  // 返回数据会被 koaGuard response 校验
};
```

**BATCH 路径校验总结**:

与 CREATE 路径完全相同，只是循环处理多个 item。

### 3.3 UPDATE 路径完整调用链

**路由**: `PUT /custom-profile-fields/:name`
**文件**: `packages/core/src/routes/custom-profile-fields.ts:103-122`

```typescript
// 第1层：API 入口校验
koaGuard({
  params: z.object({ name: z.string().min(1) }),
  body: updateCustomProfileFieldDataGuard,  // ✅ types 层，omit name，弱约束
  response: CustomProfileFields.guard,       // ✅ foundations 层，强约束
  status: [200, 400, 404],
})

// 第2层：业务处理
async (ctx, next) => {
  const { params, body } = ctx.guard;
  const customProfileField = await updateCustomProfileField(params.name, body);
  ctx.body = customProfileField;
  ctx.status = 200;
  return next();
}
```

**业务层**: `packages/core/src/libraries/custom-profile-fields/index.ts:101-118`

```typescript
export const updateCustomProfileField = async (
  name: string,
  data: UpdateCustomProfileFieldData
) => {
  // 第2层：业务逻辑校验 - ⚠️ isStrict = true
  validateCustomProfileFieldData({ ...data, name }, true);

  // 第3层：数据库更新
  return updateCustomProfileFieldsByName({
    where: { name },
    set: data,
    jsonbMode: 'replace',  // ⚠️ 完全替换 config
  });
};
```

**数据库操作层**: `packages/core/src/database/update-where.ts:79-96`

```typescript
return async <SetKey extends Key, WhereKey extends Key>({
  set,
  where,
  jsonbMode,
}: UpdateWhereData<SetKey, WhereKey>) => {
  // ❌ 关键：没有调用 schema.updateGuard.parse(set)！
  // 数据直接转换为 SQL SET 语句
  
  const { rows: [data] } = await pool.query<Schema>(sql`
    update ${table}
    set ${sql.join(connectKeyValueWithEqualSign(set, jsonbMode), sql`, `)}
    where ${sql.join(connectKeyValueWithEqualSign(where, jsonbMode), sql` and `)}
    returning *
  `);

  return data;  // 返回数据会被 koaGuard response 校验
};
```

**UPDATE 路径校验总结**:

| 阶段 | 使用的 guard | 约束强度 | Text/Number min/max | isStrict | 执行与否 |
|-----|-------------|---------|---------------------|----------|---------|
| API 入口 | `updateCustomProfileFieldDataGuard` (types 层) | 🟡 弱 | `z.number()` | - | ✅ 执行 |
| 业务逻辑 | `validateTextProfileField` | 🟡 中 | `min <= max` | `true` | ✅ 执行 |
| 数据库写入前 | `CustomProfileFields.updateGuard` | 🔴 强 | `z.number().int().min(0)` | - | ❌ **不执行** |
| 数据库写入后（response） | `CustomProfileFields.guard` | 🔴 强 | `z.number().int().min(0)` | - | ✅ 执行 |

⚠️ **注意**: UPDATE 路径的 `isStrict=true` 只影响 Select、Regex、Checkbox、复合类型，对 Text 和 Number 没有额外约束。

---

## 四、foundations 强约束的真实生效边界

### 4.1 生效位置：仅在读取时校验

**核心发现**：`CustomProfileFields.createGuard` 和 `CustomProfileFields.updateGuard` 在整个代码库中**从未被调用过**！

```bash
$ grep -r "CustomProfileFields\.createGuard" .
# 无结果！
```

**foundations 层约束仅在以下位置生效**：

1. **Response 校验**（`koa-guard.ts:231-242`）：
   ```typescript
   if (response !== undefined) {
     const result = response.safeParse(ctx.body);
     if (result.success) {
       ctx.body = result.data;  // 会 strip 掉额外字段
     } else {
       throw new ResponseBodyError(result.error);
     }
   }
   ```
   - 所有写入操作的 response 都使用 `CustomProfileFields.guard`
   - 这个 guard 包含 `customProfileFieldConfigGuard`（有 `.int().min(0)`）

2. **数据库读取后的类型断言**：
   - `pool.query<Schema>` 只是 TypeScript 泛型，没有运行时校验
   - 实际运行时校验只在 koaGuard 的 response 阶段

### 4.2 可绕过点分析

#### 可绕过点 1：不检查返回结果
**场景**：如果 API 路由不设置 `response: CustomProfileFields.guard`，或者调用方不检查返回结果，那么 foundations 层的约束完全不生效。

**当前情况**：所有路由都设置了 response 校验，所以写入后读取时会校验。

#### 可绕过点 2：写入成功但读取失败（最严重）
**场景**：
```javascript
// 写入请求 - 成功通过 API 校验（types 层允许负数）
POST /api/custom-profile-fields
{
  "name": "test",
  "type": "Text",
  "required": false,
  "config": {
    "minLength": -5,   // 负数！
    "maxLength": 3.14  // 小数！
  }
}

// 数据库写入成功 - 没有 Zod 校验
// 但返回时触发 response 校验失败！
// 错误："Number must be an integer" 或 "Number must be greater than or equal to 0"
```

**结果**：
- ✅ 数据已成功写入数据库
- ❌ API 返回 500 错误（ResponseBodyError）
- ⚠️ 数据库中存在无效数据，下次读取时也会失败

**这是一个"写入成功但读取失败"的严重不一致问题！**

#### 可绕过点 3：直接数据库操作
**场景**：通过其他路径直接操作数据库（如数据迁移、修复脚本），跳过所有应用层校验。

#### 可绕过点 4：绕过前端校验
**场景**：
- 前端 `parseFormDataToRequestPayload` 会强制修正一些值（如 Checkbox 的 `required=false`）
- 但直接调用 API 可以绕过这些修正

---

## 五、真实生效边界总结

### 5.1 Text 和 Number 类型的真实约束

| 约束 | types 层 (API 入口) | foundations 层 (理论) | 实际生效 |
|-----|-------------------|----------------------|---------|
| `minLength` 类型 | `z.number()` | `z.number().int().min(0)` | `z.number()` |
| `maxLength` 类型 | `z.number()` | `z.number().int().min(0)` | `z.number()` |
| `minValue` 类型 | `z.number()` | `z.number().int().min(0)` | `z.number()` |
| `maxValue` 类型 | `z.number()` | `z.number().int().min(0)` | `z.number()` |
| `min <= max` 逻辑 | ❌ | ❌ | ✅ (业务层) |
| `.int()` 整数约束 | ❌ | ✅ | ❌ |
| `.min(0)` 非负约束 | ❌ | ✅ | ❌ |

**实际生效 = types 层约束 + 业务层 `min <= max` 校验**

### 5.2 读写不对称问题

| 阶段 | 使用的 guard | 约束强度 |
|-----|-------------|---------|
| **写入** | types 层 `customProfileFieldUnionGuard` | 🟡 弱 |
| **读取** | foundations 层 `CustomProfileFields.guard` | 🔴 强 |

**后果**：可能写入成功但读取失败，导致数据不一致和 500 错误。

### 5.3 三条路径的约束对比

| 约束项 | CREATE | BATCH | UPDATE |
|-------|--------|-------|--------|
| types 层 guard | ✅ | ✅ | ✅ |
| `min <= max` 校验 | ✅ | ✅ | ✅ |
| `isStrict` 模式 | `false` | `false` | `true` |
| Select options 非空 | ❌ | ❌ | ✅ |
| Regex 合法性 | ❌ | ❌ | ✅ |
| foundations `.int().min(0)` | ❌ | ❌ | ❌ |
| 数据库写入前 Zod 校验 | ❌ | ❌ | ❌ |
| 读取时 foundations 校验 | ✅ | ✅ | ✅ |

---

## 六、Checkbox 的 required 和 description 前端提交链路分析

### 6.1 后端 Schema 层面的强制约束

**文件**: `packages/schemas/src/types/custom-profile-fields.ts:95-111`

```typescript
// 类型定义层面就强制约束
export type CheckboxProfileField = Omit<BaseProfileField, 'description'> & {
  type: CustomProfileFieldType.Checkbox;
  required: false;  // 字面量类型，必须为 false
  config?: {
    defaultValue: 'true' | 'false';
  };
};

// Zod guard 层面强制执行
export const checkboxProfileFieldGuard = baseProfileFieldGuard
  .omit({ description: true })  // 1. 从类型中彻底排除 description 字段
  .extend({
    type: z.literal(CustomProfileFieldType.Checkbox),
    required: z.literal(false),  // 2. 强制 required 必须等于 false
    config: z
      .object({
        defaultValue: z.literal('true').or(z.literal('false')),
      })
      .optional(),
  }) satisfies ToZodObject<CheckboxProfileField>;
```

### 6.2 前端管理端的三层防护机制

前端管理端采用 **UI 控制 + Payload 强制 + 类型定义** 三层防护：

#### 第一层：UI 控制（视觉隐藏）
**文件**: `packages/console/src/pages/SignInExperience/PageContent/components/ProfileFieldPartSubForm/index.tsx`

通过条件渲染隐藏不相关字段：

```typescript
// L147-L158: placeholder 字段 - Checkbox 类型不渲染
{type !== CustomProfileFieldType.Checkbox && (
  <FormField title="sign_in_exp.custom_profile_fields.details.placeholder">
    <TextInput {...register(`${fieldPrefix}placeholder`)} />
  </FormField>
)}

// L159-L170: description 字段 - Checkbox 类型不渲染 ⚠️
{type !== CustomProfileFieldType.Checkbox && (
  <FormField title="sign_in_exp.custom_profile_fields.details.description">
    <TextInput {...register(`${fieldPrefix}description`)} />
  </FormField>
)}

// L236-L243: required 开关 - Checkbox 类型不渲染 ⚠️
{type !== CustomProfileFieldType.Checkbox && (
  <FormField title="sign_in_exp.custom_profile_fields.details.required">
    <Switch
      label={t('sign_in_exp.custom_profile_fields.details.required_description')}
      {...register(`${fieldPrefix}required`)}
    />
  </FormField>
)}
```

**职责**：用户体验优化，防止误操作。**可绕过**（通过浏览器 DevTools）。

#### 第二层：Payload 强制（提交前修正）
**文件**: `packages/console/src/pages/SignInExperience/PageContent/CollectUserProfile/data-parser.ts:151-216`

在 `parseFormDataToRequestPayload` 函数中强制修正：

```typescript
export const parseFormDataToRequestPayload = (
  data: ProfileFieldForm
): Partial<CustomProfileField> => {
  const { name, type, label, description, required, ...rest } = data;

  return cleanDeep(
    {
      name,
      type,
      label: cond(label),
      description,  // description 会被传递，但后端 Zod guard 会过滤掉
      
      // 1. 强制 required 为 false ⚠️
      required: type === CustomProfileFieldType.Checkbox ? false : required,
      
      config: {
        // ... 其他配置
        defaultValue:
          // 2. 强制 defaultValue 为字符串 'true'/'false'
          type === CustomProfileFieldType.Checkbox
            ? String(defaultValue === 'true')
            : defaultValue,
      },
    },
    { emptyStrings: false, emptyObjects: false }
  );
};
```

**职责**：数据一致性保证，即使 UI 被绕过也能修正。**可绕过**（通过直接调用 API）。

#### 第三层：后端 Schema 强制（终极防线）
**文件**: `packages/schemas/src/types/custom-profile-fields.ts:103-111`

```typescript
export const checkboxProfileFieldGuard = baseProfileFieldGuard
  .omit({ description: true })  // 类型层面排除
  .extend({
    type: z.literal(CustomProfileFieldType.Checkbox),
    required: z.literal(false),  // 字面量类型约束
  });
```

**职责**：终极防线，无论前端如何处理都强制执行。**不可绕过**。

### 6.3 三层防护对比

| 防护层级 | 实现方式 | 可绕过 | `required=false` | `无 description` | `defaultValue` 格式 |
|---------|---------|-------|-----------------|----------------|--------------------|
| **UI 控制** | 条件渲染 | ✅ | 隐藏开关 | 隐藏输入框 | 下拉选择 |
| **Payload 强制** | 数据转换 | ✅ | `type === Checkbox ? false : required` | 不处理（后端过滤） | `String(defaultValue === 'true')` |
| **Schema 强制** | Zod guard | ❌ | `z.literal(false)` | `.omit({ description: true })` | `z.literal('true').or(z.literal('false'))` |

---

## 七、UI 控制和 Payload 强制的职责划分

### 7.1 UI 控制的职责

**定义**: 通过条件渲染、禁用等方式控制用户可见的界面元素

**位置**: `ProfileFieldPartSubForm.tsx` 中的 `{type !== Checkbox && (...)}` 模式

**承担的职责**:
1. **用户体验优化**: 只展示与当前字段类型相关的配置项，避免信息过载
2. **误操作预防**: 防止用户看到或修改不应该修改的字段
3. **输入引导**: 通过标签、提示、占位符等引导用户正确填写
4. **即时反馈**: 前端表单校验（必填、格式等）提供即时用户反馈

**局限性**:
- 只能防止正常用户的误操作
- 可以通过浏览器开发者工具绕过
- 无法防止直接 API 调用

### 7.2 Payload 强制的职责

**定义**: 在发送 API 请求前，对数据进行强制转换和修正

**位置**: `parseFormDataToRequestPayload` 函数中的三元表达式

**承担的职责**:
1. **数据一致性保证**: 即使 UI 被绕过，也能在提交前强制修正数据
2. **类型安全转换**: 如将字符串转换为数字、将布尔值转换为特定字符串格式
3. **业务规则执行**: 如 Checkbox 必须 `required=false`
4. **数据清洗**: 移除空值、无效值，使用 `cleanDeep` 清理数据

**局限性**:
- 仍在前端执行，可以通过直接调用 API 绕过
- 依赖开发人员正确实现，容易遗漏
- 增加了前端代码复杂度

### 7.3 后端 Schema 强制的职责

**定义**: 在 Zod guard 中通过类型系统强制执行约束

**位置**: `checkboxProfileFieldGuard` 中的 `.omit()` 和 `z.literal()`

**承担的职责**:
1. **终极防线**: 无论前端如何处理，后端都强制执行
2. **类型安全**: 在类型层面就排除无效组合
3. **文档价值**: 代码即文档，清晰表达业务规则
4. **可测试性**: Zod guard 可以独立测试

**局限性**:
- 错误提示可能不够友好
- 需要前端配合做更好的用户体验

### 7.4 三层防护在 Checkbox 案例中的协作

| 约束项 | UI 控制 | Payload 强制 | Schema 强制 | 协作关系 |
|-------|---------|-------------|------------|---------|
| **required = false** | 隐藏开关，用户无法修改 | 即使被篡改也强制设为 false | 字面量类型校验，确保最终正确 | 三层防护，最安全 |
| **无 description** | 隐藏输入框，用户无法输入 | 不主动处理，但传递的值会被后端过滤 | `.omit()` 从类型中彻底排除 | UI + Schema 两层，Payload 层不处理 |
| **defaultValue 格式** | 下拉选择，限制输入范围 | 转换为标准字符串格式 | 字面量类型校验 | 三层防护 |

---

## 八、代码引用速查

| 功能 | 文件路径 | 关键行 |
|-----|---------|-------|
| SQL 表 tsType 绑定 | `packages/schemas/tables/custom_profile_fields.sql` | L10 |
| parseType 提取 tsType | `packages/schemas/src/gen/utils.ts` | L210 |
| generateSchema 生成 createGuard | `packages/schemas/src/gen/schema.ts` | L75-L99 |
| foundations baseConfigGuard | `packages/schemas/src/foundations/jsonb-types/custom-profile-fields.ts` | L29-L39 |
| types textProfileFieldGuard | `packages/schemas/src/types/custom-profile-fields.ts` | L44-L53 |
| types numberProfileFieldGuard | `packages/schemas/src/types/custom-profile-fields.ts` | L64-L73 |
| koaGuard 中间件实现 | `packages/core/src/middleware/koa-guard.ts` | L130-L250 |
| koaGuard response 校验 | `packages/core/src/middleware/koa-guard.ts` | L231-L242 |
| buildInsertIntoWithPool 实现 | `packages/core/src/database/insert-into.ts` | L61-L107 |
| buildUpdateWhereWithPool 实现 | `packages/core/src/database/update-where.ts` | L36-L97 |
| CREATE 路由 | `packages/core/src/routes/custom-profile-fields.ts` | L68-L83 |
| BATCH 路由 | `packages/core/src/routes/custom-profile-fields.ts` | L85-L101 |
| UPDATE 路由 | `packages/core/src/routes/custom-profile-fields.ts` | L103-L122 |
| validateCustomProfileFieldData | `packages/core/src/libraries/custom-profile-fields/utils.ts` | L168-L214 |
| 前端 UI 控制 (Checkbox 隐藏字段) | `packages/console/src/.../ProfileFieldPartSubForm/index.tsx` | L147-L243 |
| 前端 Payload 强制 | `packages/console/src/.../data-parser.ts` | L178, L188-L189 |
| parseFormDataToRequestPayload | `packages/console/src/.../data-parser.ts` | L151-L216 |

---

## 九、核心结论与改进建议

### 9.1 核心结论

1. **foundations 层强约束在写入时不生效**：
   - `CustomProfileFields.createGuard` 和 `updateGuard` 从未被调用
   - 仅在读取时通过 `CustomProfileFields.guard` 做 response 校验
   - 导致"写入成功但读取失败"的不一致问题

2. **Text/Number 类型约束弱于预期**：
   - 实际生效：`z.number()` + `min <= max` 校验
   - 缺失 `.int().min(0)` 约束，允许负数和小数

3. **读写不对称**：
   - 写入：types 层弱约束
   - 读取：foundations 层强约束
   - 风险：写入无效数据后无法正常读取

4. **Checkbox 三层防护完善**：
   - UI 控制 + Payload 强制 + Schema 强制
   - 职责划分清晰，防护到位

### 9.2 高优先级改进

1. **数据库写入前增加 Zod 校验**：
   在 `buildInsertIntoWithPool` 和 `buildUpdateWhereWithPool` 中调用 `schema.createGuard.parse()` 或 `schema.updateGuard.parse()`

   ```typescript
   // 在 insert-into.ts 中增加
   const validatedData = schema.createGuard.parse(data);
   // 然后使用 validatedData 构建 SQL
   ```

2. **统一 Text/Number 约束**：
   在 types 层的 guard 中增加 `.int().min(0)` 约束

   ```typescript
   // 修改前
   minLength: z.number().optional(),
   // 修改后
   minLength: z.number().int().min(0).optional(),
   ```

3. **修复读写不对称**：
   确保写入校验与读取校验的强度一致，避免写入成功但读取失败

### 9.3 中优先级改进

4. **CREATE/BATCH 增加 isStrict 校验**：
   对 Select、Regex 等类型在创建时就做严格校验，与 UPDATE 保持一致

5. **移除冗余的 Payload 强制**：
   既然后端有 Zod guard 做终极校验，前端 Payload 强制可以简化为只做类型转换

6. **增加集成测试**：
   测试边界情况：负数 minLength、小数值、缺失必填配置等
