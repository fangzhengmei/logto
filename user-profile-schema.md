# 自定义用户资料字段 Schema 与校验一致性分析

## 一、整体架构概览

自定义用户资料字段系统采用三层架构设计：

```
┌─────────────────────────────────────────────────────────────┐
│                      前端体验层 (Experience)                │
│  ExtraProfileForm → use-validate-field → PrimitiveProfileInputField │
├─────────────────────────────────────────────────────────────┤
│                      前端管理层 (Console)                   │
│  ProfileFieldDetailsForm → ProfileFieldPartSubForm          │
├─────────────────────────────────────────────────────────────┤
│                      后端 Schema 层 (Schemas)               │
│  custom-profile-fields.ts (types) + foundations/jsonb-types │
├─────────────────────────────────────────────────────────────┤
│                      后端校验层 (Core)                      │
│  validateCustomProfileFieldData + ProfileValidator          │
├─────────────────────────────────────────────────────────────┤
│                      数据库层 (PostgreSQL)                  │
│  custom_profile_fields 表 + JSONB 存储                      │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、后端 Schema 定义详解

### 2.1 数据库表结构

**文件**: `packages/schemas/tables/custom_profile_fields.sql`

```sql
create table custom_profile_fields (
  tenant_id varchar(21) not null,
  id varchar(21) not null,
  name varchar(128) not null,           -- 字段唯一标识
  type varchar(128) not null,           -- 字段类型枚举
  label varchar(128) not null default '',
  description varchar(256),
  required boolean not null default false,
  config jsonb not null default '{}'::jsonb,  -- 动态配置
  created_at timestamptz not null default(now()),
  sie_order int2 not null default 0,    -- 展示顺序
  primary key (id),
  constraint custom_profile_fields__name unique (tenant_id, name)
);
```

**关键约束**:
- `name` 字段在租户内唯一
- `config` 为 JSONB 类型，存储各类型特有的配置
- `type` 字段使用字符串存储，由应用层枚举约束

### 2.2 TypeScript 类型定义

**文件**: `packages/schemas/src/types/custom-profile-fields.ts`

#### 字段类型枚举
```typescript
enum CustomProfileFieldType {
  Text = 'Text',
  Number = 'Number',
  Date = 'Date',
  Checkbox = 'Checkbox',
  Select = 'Select',
  Url = 'Url',
  Regex = 'Regex',
  Address = 'Address',    // 复合类型
  Fullname = 'Fullname',  // 复合类型
}
```

#### 基础字段结构
```typescript
type BaseProfileField = {
  name: string;           // 字段标识
  label?: string;         // 显示标签
  description?: string;   // 描述
  type: CustomProfileFieldType;
  required: boolean;      // 是否必填
};
```

#### 各字段类型的 config 结构

| 字段类型 | 必填 config 字段 | 可选 config 字段 |
|---------|----------------|----------------|
| Text | - | placeholder, minLength, maxLength |
| Number | - | placeholder, minValue, maxValue |
| Date | **format** | placeholder, customFormat |
| Checkbox | - | defaultValue ('true'/'false') |
| Select | **options** (Array<{label, value}>) | placeholder |
| Url | - | placeholder |
| Regex | **format** (正则字符串) | placeholder |
| Address | **parts** (子字段数组) | - |
| Fullname | **parts** (子字段数组) | - |

**注意**: Checkbox 类型有特殊约束：`required` 强制为 `false`，且不包含 `description` 字段。

### 2.3 JSONB 基础配置类型

**文件**: `packages/schemas/src/foundations/jsonb-types/custom-profile-fields.ts`

```typescript
const baseConfigGuard = z.object({
  placeholder: z.string().max(256).optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(0).optional(),
  minValue: z.number().int().min(0).optional(),
  maxValue: z.number().int().min(0).optional(),
  format: z.string().max(128).optional(),
  customFormat: z.string().max(128).optional(),
  options: fieldOptionsGuard.optional(),
  defaultValue: z.string().optional(),
});

const fieldPartGuard = z.object({
  enabled: z.boolean(),
  name: z.string(),
  type: customProfileFieldTypeGuard,
  label: z.string().min(1).optional(),
  description: z.string().optional(),
  required: z.boolean(),
  config: baseConfigGuard.optional(),
});
```

**这是所有字段配置的底层基础类型**，所有上层类型都由此派生。

---

## 三、后端写入校验逻辑

### 3.1 字段定义创建/更新校验

**文件**: `packages/core/src/libraries/custom-profile-fields/utils.ts`

核心函数：`validateCustomProfileFieldData(data, isStrict)`

```typescript
switch (type) {
  case CustomProfileFieldType.Text:
    validateTextProfileField(data);    // 校验 minLength <= maxLength
    break;
  case CustomProfileFieldType.Number:
    validateNumberProfileField(data);  // 校验 minValue <= maxValue
    break;
  case CustomProfileFieldType.Checkbox:
    validateCheckboxProfileField(data, isStrict);  // Strict 模式下 defaultValue 必填
    break;
  case CustomProfileFieldType.Select:
    validateSelectProfileField(data, isStrict);    // Strict 模式下 options 不能为空
    break;
  case CustomProfileFieldType.Regex:
    validateRegexProfileField(data, isStrict);     // Strict 模式下校验正则合法性
    break;
  case CustomProfileFieldType.Address:
  case CustomProfileFieldType.Fullname:
    validateAddressProfileField(data, isStrict);   // 校验 parts 非空，且子类型不是复合类型
    break;                                         // Strict 模式下递归校验子字段
  case CustomProfileFieldType.Url:
  case CustomProfileFieldType.Date:
    // 仅通过 Zod guard 做类型校验
    break;
}
```

**字段名称校验** (`validateFieldName`):
1. 必须匹配正则 `/^[a-zA-Z0-9]+$/`
2. 不能与内置 profile key 冲突 (preferredUsername)
3. 不能与保留 customData key 冲突 (onboarding data, guide requests 等)
4. 不能与登录标识 key 冲突 (username, primaryEmail, primaryPhone, email, phone)

### 3.2 用户资料值写入校验

**文件**: `packages/core/src/routes/experience/classes/libraries/profile-validator.ts`

核心方法：`validateAndParseCustomProfile(values)`

```typescript
// 1. 检查与内置字段冲突
const conflictedReservedBuiltInProfileKeys = Object.keys(
  reservedBuiltInProfileKeyGuard.parse(values)
);

// 2. 检查与登录标识冲突
const conflictedSignInIdentifierKeys = Object.keys(
  signInIdentifierKeyGuard.parse(values)
);

// 3. 检查与保留 customData key 冲突
const conflictedCustomDataKeys = Object.keys(
  reservedCustomDataKeyGuard.parse(values)
);

// 4. 解析内置字段和自定义字段
const { name, avatar } = nameAndAvatarGuard.parse(values);
const profile = userProfileGuard.parse(values);  // 内置 profile 字段

// 5. 分离自定义字段到 customData
const customData = jsonObjectGuard.parse(
  Object.fromEntries(
    Object.entries(values).filter(([key]) => !builtInProfileKeys.has(key))
  )
);
```

**注意**: 后端在校验用户填写的资料值时，**没有针对自定义字段类型的具体值校验**（如文本长度、数值范围、日期格式等）。这些校验只在前端进行，后端仅做字段级别的隔离和冲突检查。

---

## 四、前端编辑组件派生关系

### 4.1 体验端 (Experience) - 用户填写表单

**文件**: `packages/experience/src/pages/Continue/ExtraProfileForm/index.tsx`

#### 组件派生树
```
ExtraProfileForm
├── useValidateField (自定义校验 Hook)
├── FullnameSubForm (复合类型：全名)
├── AddressSubForm (复合类型：地址)
└── PrimitiveProfileInputField (基础类型)
    ├── SelectField (Select 类型)
    ├── CheckboxField (Checkbox 类型)
    ├── DateField (Date 类型)
    └── InputField (Text/Number/Url/Regex 类型)
```

#### 前端校验逻辑 (`use-validate-field.ts`)

**注意**: 前端使用 `superstruct` 库进行校验，而后端使用 `zod` 库，这是**技术栈不一致**的根源。

```typescript
const validate = (value: unknown, field: Omit<FieldPart, 'enabled'>) => {
  // 1. 必填校验
  if (!value) {
    return !required || generalRequireMessage;
  }

  // 2. 按类型校验
  if (type === CustomProfileFieldType.Date) {
    return isValidDateField(value, config) || generalInvalidMessage;
  }
  if (type === CustomProfileFieldType.Regex) {
    return isValidRegexField(value, config) || generalInvalidMessage;
  }
  if (type === CustomProfileFieldType.Url) {
    return isValidUrlField(value) || generalInvalidMessage;
  }
  if (type === CustomProfileFieldType.Number) {
    if (Number.isNaN(Number(value))) return generalInvalidMessage;
    return isValidNumberRange(value, config) || minMaxErrorMessage;
  }
  if (type === CustomProfileFieldType.Text) {
    return isValidTextLengthRange(value, config) || minMaxLengthMessage;
  }
  return true;
};
```

#### 前端 guard 类型定义

**文件**: `packages/experience/src/types/guard.ts`

```typescript
// 前端独立定义的 guard（使用 superstruct）
export const dateFieldConfigGuard = s.object({
  format: dateFormatEnumGuard,
  placeholder: s.optional(s.string()),
  customFormat: s.optional(s.string()),
});

const baseConfigPartGuard = s.object({
  placeholder: s.optional(s.string()),
  minLength: s.optional(s.number()),
  maxLength: s.optional(s.number()),
  minValue: s.optional(s.number()),
  maxValue: s.optional(s.number()),
  // ... 其他字段
});
```

### 4.2 管理端 (Console) - 字段配置表单

**文件**: `packages/console/src/pages/SignInExperience/PageContent/CollectUserProfile/ProfileFieldDetails/ProfileFieldDetailsForm/index.tsx`

#### 组件派生树
```
ProfileFieldDetailsForm
├── CompositionPartsSelector (复合类型子字段选择器)
├── ProfileFieldPartSubForm (字段配置子表单)
│   ├── CustomDataProfileNameField (字段名输入)
│   ├── DateFormatSelector (日期格式选择器)
│   ├── RangedNumberInputs (数值范围输入)
│   └── 各类型动态配置表单
├── parseResponseToFormData (API 响应 → 表单数据)
└── parseFormDataToRequestPayload (表单数据 → API 请求)
```

#### 管理端表单类型

**文件**: `packages/console/src/pages/SignInExperience/PageContent/CollectUserProfile/types.ts`

```typescript
type ProfileFieldPartSubForm = {
  enabled: boolean;
  name: string;
  type: CustomProfileFieldType;
  label: string;
  description?: string;
  required: boolean;
  options?: string;        // 注意：这里是 string，不是数组！
  placeholder?: string;
  minLength?: string;      // 注意：这里是 string，不是 number！
  maxLength?: string;
  minValue?: string;
  maxValue?: string;
  format?: string;
  customFormat?: string;
  defaultValue?: string;
};
```

**关键差异**: 管理端表单将数值类型字段（minLength, maxLength, minValue, maxValue）和数组类型字段（options）都存储为字符串，在提交时通过 `parseFormDataToRequestPayload` 转换为正确类型。

---

## 五、前后端约束差异对比

### 5.1 校验库差异

| 层面 | 校验库 | 类型定义来源 |
|-----|-------|------------|
| 后端 Schema 层 | Zod | `@logto/schemas` 包 |
| 后端业务层 | Zod | `@logto/schemas` 包 |
| 前端体验层 | superstruct | 本地 `guard.ts` 独立定义 |
| 前端管理层 | react-hook-form + 自定义 | 本地 `types.ts` 独立定义 |

### 5.2 字段配置约束对比表

| 约束项 | 后端 Schema (Zod) | 后端校验 | 前端体验 (superstruct) | 前端管理 (表单) |
|-------|------------------|----------|----------------------|----------------|
| **Text.minLength** | `z.number().int().min(0)` | 校验 `<= maxLength` | `s.optional(s.number())` | `string` 类型，提交时转换 |
| **Text.maxLength** | `z.number().int().min(0)` | 校验 `>= minLength` | `s.optional(s.number())` | `string` 类型，提交时转换 |
| **Number.minValue** | `z.number().int().min(0)` | 校验 `<= maxValue` | `s.optional(s.number())` | `string` 类型，提交时转换 |
| **Number.maxValue** | `z.number().int().min(0)` | 校验 `>= minValue` | `s.optional(s.number())` | `string` 类型，提交时转换 |
| **Date.format** | 无额外约束（仅 string） | 无额外校验 | 强约束为枚举 `SupportedDateFormat` | 下拉选择器 |
| **Select.options** | `z.array(...)` | Strict 模式下不能为空 | 无（直接使用后端数据） | `string` 类型，逐行解析为数组 |
| **Regex.format** | 无额外约束（仅 string） | Strict 模式下校验正则合法性 | 无 guard 约束，仅运行时校验 | `string` 类型 |
| **Checkbox.required** | 强制 `z.literal(false)` | 创建时校验 | 无（仅 CheckboxField 组件） | 隐藏字段，强制 false |
| **字段名格式** | `z.string()` | 正则 `/^[a-zA-Z0-9]+$/` | 无（仅展示） | CustomDataProfileNameField 组件内校验 |

### 5.3 用户填写值校验对比

| 校验项 | 后端 | 前端体验 |
|-------|-----|---------|
| 必填字段检查 | ✓ (hasMissingExtraProfileFields) | ✓ (useValidateField) |
| 文本长度检查 | ✗ | ✓ |
| 数值范围检查 | ✗ | ✓ |
| 日期格式检查 | ✗ | ✓ (date-fns parse + format) |
| URL 格式检查 | ✗ | ✓ (isValidUrl) |
| 正则匹配检查 | ✗ | ✓ (运行时 RegExp) |
| 字段名冲突检查 | ✓ | ✗ |
| 数据类型转换 | ✓ (JSON parse) | ✗ (全字符串提交) |

### 5.4 关键不一致点

#### 1. **Date.format 约束强度不一致**
- 后端：`format: z.string()` —— 任意字符串都可通过
- 前端：`format: dateFormatEnumGuard` —— 必须是 `SupportedDateFormat` 枚举值

**风险**: 直接调用 API 可传入任意 format 字符串，前端可能无法正确解析。

#### 2. **Select.options 非空校验时机不一致**
- 后端：仅 `isStrict=true`（即更新时）才校验 `options.length > 0`
- 前端：管理端创建时就强制要求填写 options

**风险**: 通过 batch 创建 API 可创建无 options 的 Select 字段。

#### 3. **数值字段类型不一致**
- 后端 Schema: `minLength`, `maxLength`, `minValue`, `maxValue` 都是 `number` 类型
- 前端管理表单: 这些字段都是 `string` 类型，提交时才转换

**风险**: 转换过程可能出错，且前端表单没有针对数值的强类型校验。

#### 4. **用户值校验缺失（最严重）**
后端在校验用户提交的自定义资料值时，**完全没有针对字段类型的校验**。所有的业务规则校验（长度、范围、格式等）都只在前端进行。

**风险**: 绕过前端直接调用 API 可提交任意格式的数据，破坏数据一致性。

#### 5. **Checkbox 字段的特殊约束丢失**
后端 `checkboxProfileFieldGuard` 强制 `required: false` 且没有 `description` 字段，但前端没有对应的 guard 约束，仅通过 UI 隐藏相关字段。

---

## 六、类型派生关系链

### 6.1 后端类型派生链

```
baseConfigGuard (foundations/jsonb-types)
├── fieldPartGuard
│   ├── addressProfileFieldGuard.config.parts
│   └── fullnameProfileFieldGuard.config.parts
└── customProfileFieldConfigGuard

baseProfileFieldGuard (types/custom-profile-fields)
├── textProfileFieldGuard
├── numberProfileFieldGuard
├── dateProfileFieldGuard
├── checkboxProfileFieldGuard (omit description, required = false)
├── selectProfileFieldGuard
├── urlProfileFieldGuard
├── regexProfileFieldGuard
├── addressProfileFieldGuard
└── fullnameProfileFieldGuard
    └── customProfileFieldUnionGuard (discriminated union)
```

### 6.2 前端类型派生链

```
后端 Zod 类型 (@logto/schemas)
├── 体验端 superstruct 类型 (guard.ts) —— 独立重定义
│   ├── dateFieldConfigGuard
│   ├── baseConfigPartGuard
│   ├── addressFieldConfigGuard
│   └── fullnameFieldConfigGuard
└── 管理端表单类型 (types.ts) —— 独立重定义
    └── ProfileFieldForm (所有数值字段转为 string)
```

**问题**: 前端没有直接复用后端的 Zod 类型，而是用 superstruct 独立定义了一套，导致类型定义分叉。

---

## 七、数据流向与校验节点

```
用户填写表单 (Experience)
    │
    ▼
useValidateField (前端校验：长度/范围/格式/正则)
    │
    ▼
API 请求 (全字符串格式)
    │
    ▼
ProfileValidator.validateAndParseCustomProfile (后端校验)
    ├── 检查字段名冲突
    ├── 分离内置字段和自定义字段
    └── ✗ 跳过字段类型值校验
    │
    ▼
写入数据库 (users.customData JSONB)
    │
    ▼
字段配置修改 (Console)
    │
    ▼
parseFormDataToRequestPayload (类型转换：string → number/array)
    │
    ▼
validateCustomProfileFieldData (后端校验)
    ├── 字段名格式校验
    ├── min/max 逻辑校验
    ├── 正则合法性校验 (Strict 模式)
    └── 复合类型子字段递归校验 (Strict 模式)
    │
    ▼
写入数据库 (custom_profile_fields.config JSONB)
```

---

## 八、代码引用速查

| 功能 | 文件路径 | 关键行 |
|-----|---------|-------|
| 数据库表定义 | `packages/schemas/tables/custom_profile_fields.sql` | L1-L31 |
| 字段类型枚举 | `packages/schemas/src/foundations/jsonb-types/custom-profile-fields.ts` | L3-L15 |
| 基础配置 Zod guard | `packages/schemas/src/foundations/jsonb-types/custom-profile-fields.ts` | L29-L39 |
| 各字段类型 Zod guard | `packages/schemas/src/types/custom-profile-fields.ts` | L27-L249 |
| 字段定义校验 | `packages/core/src/libraries/custom-profile-fields/utils.ts` | L168-L214 |
| 用户资料值校验 | `packages/core/src/routes/experience/classes/libraries/profile-validator.ts` | L270-L314 |
| 前端值校验 Hook | `packages/experience/src/pages/Continue/ExtraProfileForm/use-validate-field.ts` | L63-L119 |
| 前端 superstruct guard | `packages/experience/src/types/guard.ts` | L221-L283 |
| 管理端表单类型 | `packages/console/src/pages/SignInExperience/PageContent/CollectUserProfile/types.ts` | L1-L24 |
| 基础输入组件 | `packages/experience/src/components/InputFields/PrimitiveProfileInputField/index.tsx` | L1-L112 |

---

## 九、改进建议（潜在问题点）

1. **后端值校验缺失**: 应在 `ProfileValidator.validateAndParseCustomProfile` 中增加针对自定义字段类型的值校验，与前端 `useValidateField` 保持一致。

2. **Date.format 约束**: 后端应增加对 `SupportedDateFormat` 枚举的校验，或允许任意格式但前端需做兼容处理。

3. **校验库统一**: 考虑将前端 superstruct 替换为 zod，或使用 `@logto/schemas` 导出的 zod 类型在前端生成校验器，避免重复定义。

4. **管理端表单类型**: 应直接使用 number 类型而非 string，避免类型转换风险。

5. **Select.options 非空校验**: 后端创建时也应强制 options 非空，与前端管理端保持一致。
