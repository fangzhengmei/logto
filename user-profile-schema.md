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

## 二、types 与 foundations 两套 schema 的生效位置分析

### 2.1 两套 schema 的定义与关系

#### foundations 层（底层基础类型）
**文件**: `packages/schemas/src/foundations/jsonb-types/custom-profile-fields.ts`

这是最底层的类型定义，为 JSONB 字段存储服务：

```typescript
// 字段类型枚举
export enum CustomProfileFieldType {
  Text = 'Text', Number = 'Number', Date = 'Date', Checkbox = 'Checkbox',
  Select = 'Select', Url = 'Url', Regex = 'Regex',
  Address = 'Address', Fullname = 'Fullname',
}

// 基础配置 guard - 所有字段配置的底层约束
export const baseConfigGuard = z.object({
  placeholder: z.string().max(256).optional(),
  minLength: z.number().int().min(0).optional(),    // 注意：这里有 .int().min(0)
  maxLength: z.number().int().min(0).optional(),    // 注意：这里有 .int().min(0)
  minValue: z.number().int().min(0).optional(),     // 注意：这里有 .int().min(0)
  maxValue: z.number().int().min(0).optional(),     // 注意：这里有 .int().min(0)
  format: z.string().max(128).optional(),
  customFormat: z.string().max(128).optional(),
  options: fieldOptionsGuard.optional(),
  defaultValue: z.string().optional(),
});

// 复合类型的子字段 guard
export const fieldPartGuard = z.object({
  enabled: z.boolean(),
  name: z.string(),
  type: customProfileFieldTypeGuard,
  label: z.string().min(1).optional(),
  description: z.string().optional(),
  required: z.boolean(),
  config: baseConfigGuard.optional(),
});
```

#### types 层（业务类型定义）
**文件**: `packages/schemas/src/types/custom-profile-fields.ts`

导入 foundations 层的基础类型，定义各字段的业务类型：

```typescript
import { fieldPartGuard, CustomProfileFieldType, ... } from '../foundations/index.js';

// 基础字段结构
const baseProfileFieldGuard = z.object({
  name: z.string(),
  type: customProfileFieldTypeGuard,
  label: z.string().min(1).optional(),
  description: z.string().optional(),
  required: z.boolean(),
});

// Text 字段 - 注意：config 中没有 .int().min(0) 约束！
export const textProfileFieldGuard = baseProfileFieldGuard.extend({
  type: z.literal(CustomProfileFieldType.Text),
  config: z
    .object({
      placeholder: z.string().optional(),
      minLength: z.number().optional(),      // 缺失 .int().min(0)
      maxLength: z.number().optional(),      // 缺失 .int().min(0)
    })
    .optional(),
});

// Number 字段 - 同样缺失 .int().min(0) 约束
export const numberProfileFieldGuard = baseProfileFieldGuard.extend({
  type: z.literal(CustomProfileFieldType.Number),
  config: z
    .object({
      placeholder: z.string().optional(),
      minValue: z.number().optional(),       // 缺失 .int().min(0)
      maxValue: z.number().optional(),       // 缺失 .int().min(0)
    })
    .optional(),
});

// Checkbox 字段 - 特殊约束：强制 required=false，omit description
export const checkboxProfileFieldGuard = baseProfileFieldGuard
  .omit({ description: true })  // 类型层面排除 description
  .extend({
    type: z.literal(CustomProfileFieldType.Checkbox),
    required: z.literal(false),  // 字面量类型，必须为 false
    config: z
      .object({
        defaultValue: z.literal('true').or(z.literal('false')),
      })
      .optional(),
  });

// 联合类型 - 用于 API 请求校验
export const customProfileFieldUnionGuard = z.discriminatedUnion('type', [
  textProfileFieldGuard, numberProfileFieldGuard, dateProfileFieldGuard,
  checkboxProfileFieldGuard, selectProfileFieldGuard, urlProfileFieldGuard,
  regexProfileFieldGuard, addressProfileFieldGuard, fullnameProfileFieldGuard,
]);

// 更新用 guard - omit name
export const updateCustomProfileFieldDataGuard = z.discriminatedUnion('type', [
  textProfileFieldGuard.omit({ name: true }),
  // ... 其他类型
]);
```

### 2.2 两套 schema 在写入链路中的生效位置

```
API 请求 (JSON body)
    │
    ▼
koaGuard 中间件 (routes/custom-profile-fields.ts)
    │  使用 types 层的 guard:
    │  - POST: customProfileFieldUnionGuard
    │  - POST /batch: z.array(customProfileFieldUnionGuard)
    │  - PUT: updateCustomProfileFieldDataGuard
    │
    ▼
validateCustomProfileFieldData (libraries/custom-profile-fields/utils.ts)
    │  1. 先通过 types 层的 guard.parse() 做类型校验
    │  2. 然后做业务逻辑校验（min <= max 等）
    │
    ▼
数据库操作 (queries/custom-profile-fields.ts)
    │  使用生成的 CustomProfileFields schema:
    │  - createGuard: 插入时校验
    │  - guard: 查询结果校验
    │  config 字段使用 foundations 层的 customProfileFieldConfigGuard
    │
    ▼
PostgreSQL 数据库 (custom_profile_fields.config JSONB)
    └─ 实际存储时，由 foundations 层约束保证数据完整性
```

#### 各阶段生效的 schema：

| 阶段 | 使用的 schema | 约束强度 | 关键差异 |
|-----|-------------|---------|---------|
| API 入口校验 | types 层 guard | 较弱 | Text/Number 的 min/max 缺少 `.int().min(0)` |
| 业务逻辑校验 | types 层 guard + 自定义逻辑 | 中等 | 增加 `min <= max` 校验 |
| 数据库写入 | 生成的 CustomProfileFields + foundations | 较强 | config 字段使用 foundations 层，有 `.int().min(0)` |

**⚠️ 关键不一致点**:
- **API 入口**允许 `minLength: -1` 或 `minLength: 1.5`（非整数、负数）
- **数据库写入**时会被 foundations 层的 `baseConfigGuard` 拦截（如果生效）
- 这是一个潜在的安全漏洞：API 层校验不严格，但数据库层约束可能生效也可能不生效，取决于生成的 schema 是否正确使用了 foundations 层的 guard

---

## 三、create/batch/update 三种路径的 Text 和 Number 数值约束详解

### 3.1 三种写入路径的代码位置

| 操作 | 路由文件 | 处理函数 |
|-----|---------|---------|
| **CREATE** | `packages/core/src/routes/custom-profile-fields.ts:68-83` | `createCustomProfileField(data)` |
| **BATCH** | `packages/core/src/routes/custom-profile-fields.ts:85-101` | `createCustomProfileFieldsBatch(data[])` |
| **UPDATE** | `packages/core/src/routes/custom-profile-fields.ts:103-122` | `updateCustomProfileField(name, data)` |

### 3.2 CREATE 路径校验流程

**代码路径**: `POST /custom-profile-fields`

```typescript
// Step 1: koaGuard 校验 (L70-75)
koaGuard({
  body: customProfileFieldUnionGuard,  // types 层联合类型
  response: CustomProfileFields.guard,
  status: [201, 400],
})

// Step 2: 业务处理 (L76-82)
async (ctx, next) => {
  const { body } = ctx.guard;
  ctx.body = await createCustomProfileField(body);  // isStrict = false
  ctx.status = 201;
  return next();
}

// Step 3: validateCustomProfileFieldData (isStrict = false)
const createCustomProfileField = async (data: CustomProfileFieldUnion) => {
  validateCustomProfileFieldData(data);  // isStrict 默认 false
  return insertCustomProfileFields({ ...data, id: generateStandardId() });
};
```

**Text 类型约束 (CREATE)**:
1. `textProfileFieldGuard` (types 层):
   - `config.minLength?: number` - 可选，任意 number
   - `config.maxLength?: number` - 可选，任意 number
2. `validateTextProfileField`:
   - 校验：如果同时设置了 minLength 和 maxLength，则 `minLength <= maxLength`
3. 无 `isStrict` 额外校验

**Number 类型约束 (CREATE)**:
1. `numberProfileFieldGuard` (types 层):
   - `config.minValue?: number` - 可选，任意 number
   - `config.maxValue?: number` - 可选，任意 number
2. `validateNumberProfileField`:
   - 校验：如果同时设置了 minValue 和 maxValue，则 `minValue <= maxValue`
3. 无 `isStrict` 额外校验

### 3.3 BATCH 路径校验流程

**代码路径**: `POST /custom-profile-fields/batch`

```typescript
// Step 1: koaGuard 校验 (L88-92)
koaGuard({
  body: z.array(customProfileFieldUnionGuard).max(20),  // 批量 + 数量限制
  response: z.array(CustomProfileFields.guard),
  status: [201, 400],
})

// Step 2: 业务处理 (L93-99)
async (ctx, next) => {
  const { body } = ctx.guard;
  const created = await libraries.customProfileFields.createCustomProfileFieldsBatch(body);
  ctx.body = created;
  ctx.status = 201;
  return next();
}

// Step 3: 循环校验每个 item (isStrict = false)
const createCustomProfileFieldsBatch = async (data: CustomProfileFieldUnion[]) => {
  for (const item of data) {
    validateCustomProfileFieldData(item);  // 每个 item 独立校验，isStrict = false
  }
  const rows = data.map((item) => ({ ...item, id: generateStandardId() }));
  return bulkInsertCustomProfileFields(rows);
};
```

**Text/Number 类型约束 (BATCH)**:
- 与 CREATE 路径完全相同
- `isStrict = false`，无额外严格校验
- 只是循环处理多个 item

### 3.4 UPDATE 路径校验流程

**代码路径**: `PUT /custom-profile-fields/:name`

```typescript
// Step 1: koaGuard 校验 (L105-112)
koaGuard({
  params: z.object({ name: z.string().min(1) }),
  body: updateCustomProfileFieldDataGuard,  // types 层，omit name
  response: CustomProfileFields.guard,
  status: [200, 400, 404],
})

// Step 2: 业务处理 (L113-121)
async (ctx, next) => {
  const { params, body } = ctx.guard;
  const customProfileField = await updateCustomProfileField(params.name, body);
  ctx.body = customProfileField;
  ctx.status = 200;
  return next();
}

// Step 3: validateCustomProfileFieldData (isStrict = true) ⚠️
const updateCustomProfileField = async (name: string, data: UpdateCustomProfileFieldData) => {
  // 注意：isStrict = true，严格校验模式
  validateCustomProfileFieldData({ ...data, name }, true);

  return updateCustomProfileFieldsByName({
    where: { name },
    set: data,
    jsonbMode: 'replace',
  });
};
```

**Text 类型约束 (UPDATE)**:
1. `textProfileFieldGuard.omit({ name: true })` (types 层):
   - 同 CREATE，但 omit name
2. `validateTextProfileField`:
   - 同 CREATE：`minLength <= maxLength`
3. **无额外 `isStrict` 校验** - Text 类型不关心 isStrict

**Number 类型约束 (UPDATE)**:
1. `numberProfileFieldGuard.omit({ name: true })` (types 层):
   - 同 CREATE，但 omit name
2. `validateNumberProfileField`:
   - 同 CREATE：`minValue <= maxValue`
3. **无额外 `isStrict` 校验** - Number 类型不关心 isStrict

### 3.5 三种路径约束对比表

| 约束项 | CREATE (isStrict=false) | BATCH (isStrict=false) | UPDATE (isStrict=true) |
|-------|-----------------------|-----------------------|-----------------------|
| **Text.minLength** | `z.number().optional()` | `z.number().optional()` | `z.number().optional()` |
| **Text.maxLength** | `z.number().optional()` | `z.number().optional()` | `z.number().optional()` |
| **Text min<=max** | ✓ 校验 | ✓ 校验 | ✓ 校验 |
| **Text .int().min(0)** | ✗ 缺失 | ✗ 缺失 | ✗ 缺失 |
| **Number.minValue** | `z.number().optional()` | `z.number().optional()` | `z.number().optional()` |
| **Number.maxValue** | `z.number().optional()` | `z.number().optional()` | `z.number().optional()` |
| **Number min<=max** | ✓ 校验 | ✓ 校验 | ✓ 校验 |
| **Number .int().min(0)** | ✗ 缺失 | ✗ 缺失 | ✗ 缺失 |
| **Select options 非空** | ✗ 不校验 | ✗ 不校验 | ✓ 校验 (isStrict) |
| **Regex 合法性** | ✗ 不校验 | ✗ 不校验 | ✓ 校验 (isStrict) |
| **Checkbox defaultValue 必填** | ✗ 不校验 | ✗ 不校验 | ✓ 校验 (isStrict) |
| **复合类型递归校验子字段** | ✗ 不校验 | ✗ 不校验 | ✓ 校验 (isStrict) |

**⚠️ 关键发现**:
1. **Text 和 Number 类型在三种路径下的约束完全相同**，`isStrict` 参数对这两种类型没有影响
2. `isStrict=true` 只影响 **Select、Regex、Checkbox、复合类型（Address/Fullname）**
3. **所有路径都缺失 `.int().min(0)` 约束**，允许负数和非整数值通过 API 校验
4. foundations 层的 `baseConfigGuard` 有 `.int().min(0)`，但在 API 入口层没有被使用

---

## 四、Checkbox 的 required 和 description 在前端提交链路分析

### 4.1 后端 Schema 层面的强制约束

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

### 4.2 前端管理端的三层防护机制

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

#### 第三层：前端类型定义（编译时约束）
**文件**: `packages/console/src/pages/SignInExperience/PageContent/CollectUserProfile/types.ts`

```typescript
type ProfileFieldPartSubForm = {
  // ... 其他字段
  description?: string;  // 仍然是可选字段，没有从类型中排除
  required: boolean;     // 仍然是 boolean，没有限制为 false
  // ...
};
```

### 4.3 前端体验端的处理
**文件**: `packages/experience/src/components/InputFields/PrimitiveProfileInputField/index.tsx:62-74`

```typescript
if (type === CustomProfileFieldType.Checkbox) {
  return (
    <CheckboxField
      className={className}
      name={name}
      title={label}
      checked={value === 'true'}
      value={value}
      onChange={(checked) => {
        onChange(checked ? 'true' : 'false');  // 值转换为字符串
      }}
    />
  );
}
```

### 4.4 Checkbox 约束链路总结

```
用户在管理端选择 Checkbox 类型
    │
    ▼
UI 控制层：隐藏 description 和 required 字段
    │  (ProfileFieldPartSubForm.tsx L147-L243)
    │
    ▼
用户填写表单后点击保存
    │
    ▼
parseFormDataToRequestPayload：
    │  1. required: type === Checkbox ? false : required
    │  2. defaultValue: String(defaultValue === 'true')
    │  (data-parser.ts L178, L188-L189)
    │
    ▼
API 请求到达后端
    │
    ▼
koaGuard: checkboxProfileFieldGuard 校验
    │  1. .omit({ description: true }) - 过滤掉 description
    │  2. z.literal(false) - 强制 required 必须为 false
    │  3. z.literal('true').or(z.literal('false')) - 校验 defaultValue
    │  (types/custom-profile-fields.ts L103-L111)
    │
    ▼
validateCheckboxProfileField(data, isStrict)
    │  Strict 模式下校验 defaultValue 必填
    │  (utils.ts L52-L57)
    │
    ▼
写入数据库
```

---

## 五、UI 控制和 Payload 强制的职责划分

### 5.1 UI 控制的职责

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

### 5.2 Payload 强制的职责

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

### 5.3 后端 Schema 强制的职责

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

### 5.4 三层防护对比表

| 防护层级 | 实现方式 | 可绕过 | 性能影响 | 代码位置 |
|---------|---------|-------|---------|---------|
| **UI 控制** | 条件渲染 | 是 (DevTools) | 无 | `ProfileFieldPartSubForm.tsx:147-243` |
| **Payload 强制** | 数据转换 | 是 (直接 API) | 极小 | `data-parser.ts:178, 188-189` |
| **Schema 强制** | Zod guard | 否 | 极小 | `types/custom-profile-fields.ts:103-111` |

### 5.5 Checkbox 案例中的职责分配分析

| 约束项 | UI 控制 | Payload 强制 | Schema 强制 |
|-------|---------|-------------|------------|
| **required = false** | 隐藏开关 | `type === Checkbox ? false : required` | `z.literal(false)` |
| **无 description** | 隐藏输入框 | 不处理（后端过滤） | `.omit({ description: true })` |
| **defaultValue 格式** | 下拉选择 'true'/'false' | `String(defaultValue === 'true')` | `z.literal('true').or(z.literal('false'))` |

**发现**:
- `required` 字段有三层防护，最安全
- `description` 字段只有 UI 控制和 Schema 强制，Payload 层没有显式处理（但会被 Zod guard 过滤）
- `defaultValue` 字段有三层防护

---

## 六、前后端约束不一致汇总

### 6.1 Text 和 Number 类型约束不一致

| 约束 | foundations 层 | types 层 (API) | 实际效果 |
|-----|---------------|---------------|---------|
| `minLength` | `z.number().int().min(0)` | `z.number()` | API 允许负数和小数 |
| `maxLength` | `z.number().int().min(0)` | `z.number()` | API 允许负数和小数 |
| `minValue` | `z.number().int().min(0)` | `z.number()` | API 允许负数和小数 |
| `maxValue` | `z.number().int().min(0)` | `z.number()` | API 允许负数和小数 |

**风险示例**:
```javascript
// 这个请求可以通过 API 校验
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
```

### 6.2 Checkbox 约束不一致

| 约束 | 后端 Schema | 前端类型 | 一致性 |
|-----|-----------|---------|-------|
| `required` | `z.literal(false)` | `boolean` | 运行时一致，编译时不一致 |
| `description` | 被 omit | `string?` | 运行时一致（后端过滤），编译时不一致 |

### 6.3 校验时机不一致

| 校验项 | CREATE | BATCH | UPDATE |
|-------|--------|-------|--------|
| Select options 非空 | ✗ | ✗ | ✓ |
| Regex 合法性 | ✗ | ✗ | ✓ |
| Checkbox defaultValue 必填 | ✗ | ✗ | ✓ |
| 复合类型递归校验 | ✗ | ✗ | ✓ |

**风险**: 通过 batch 创建的字段可能缺少必要的配置，在使用时才发现问题。

---

## 七、代码引用速查

| 功能 | 文件路径 | 关键行 |
|-----|---------|-------|
| foundations 层 baseConfigGuard | `packages/schemas/src/foundations/jsonb-types/custom-profile-fields.ts` | L29-L39 |
| types 层 textProfileFieldGuard | `packages/schemas/src/types/custom-profile-fields.ts` | L44-L53 |
| types 层 numberProfileFieldGuard | `packages/schemas/src/types/custom-profile-fields.ts` | L64-L73 |
| types 层 checkboxProfileFieldGuard | `packages/schemas/src/types/custom-profile-fields.ts` | L103-L111 |
| koaGuard CREATE 路由 | `packages/core/src/routes/custom-profile-fields.ts` | L68-L83 |
| koaGuard BATCH 路由 | `packages/core/src/routes/custom-profile-fields.ts` | L85-L101 |
| koaGuard UPDATE 路由 | `packages/core/src/routes/custom-profile-fields.ts` | L103-L122 |
| validateCustomProfileFieldData | `packages/core/src/libraries/custom-profile-fields/utils.ts` | L168-L214 |
| validateTextProfileField | `packages/core/src/libraries/custom-profile-fields/utils.ts` | L32-L40 |
| validateNumberProfileField | `packages/core/src/libraries/custom-profile-fields/utils.ts` | L42-L50 |
| validateCheckboxProfileField | `packages/core/src/libraries/custom-profile-fields/utils.ts` | L52-L57 |
| 前端 UI 控制 (Checkbox 隐藏字段) | `packages/console/src/.../ProfileFieldPartSubForm/index.tsx` | L147-L243 |
| 前端 Payload 强制 | `packages/console/src/.../data-parser.ts` | L178, L188-L189 |
| parseFormDataToRequestPayload | `packages/console/src/.../data-parser.ts` | L151-L216 |

---

## 八、改进建议

### 8.1 高优先级
1. **统一 Text/Number 数值约束**: 在 types 层的 `textProfileFieldGuard` 和 `numberProfileFieldGuard` 中增加 `.int().min(0)` 约束，与 foundations 层保持一致

   ```typescript
   // 修改前
   minLength: z.number().optional(),
   // 修改后
   minLength: z.number().int().min(0).optional(),
   ```

2. **CREATE/BATCH 增加严格校验**: 考虑在 CREATE 和 BATCH 路径也使用 `isStrict=true`，或至少对 Select/Regex 等类型做基本校验

3. **前端类型定义对齐**: 在前端 `ProfileFieldForm` 类型中，为 Checkbox 类型做条件类型区分

   ```typescript
   type CheckboxProfileFieldForm = Omit<ProfileFieldPartSubForm, 'description' | 'required'> & {
     type: CustomProfileFieldType.Checkbox;
     required: false;
   };
   ```

### 8.2 中优先级
4. **考虑移除 Payload 强制层**: 既然后端有 Zod guard 做终极校验，前端 Payload 强制可以简化，只做类型转换
5. **增加 API 集成测试**: 针对各种边界情况（如负数 minLength）编写测试
6. **统一校验库**: 考虑前端也使用 Zod，直接复用后端的 guard 定义

### 8.3 低优先级
7. **文档补充**: 在代码中增加注释，说明为什么有三层防护，各自的职责是什么
8. **错误提示优化**: 当后端校验失败时，提供更友好的错误信息，帮助前端定位问题
