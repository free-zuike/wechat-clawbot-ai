// 轻量级请求验证工具 - 零依赖、TypeScript 友好

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface StringSchema {
  type: "string";
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  required?: boolean;
  allowed?: string[];
  trim?: boolean;
}

export interface NumberSchema {
  type: "number";
  min?: number;
  max?: number;
  integer?: boolean;
  required?: boolean;
}

export interface ObjectSchema {
  [key: string]: StringSchema | NumberSchema;
}

export function validateString(value: unknown, field: string, schema: StringSchema): string[] {
  const errors: string[] = [];

  // 检查是否缺失
  if (value === undefined || value === null || value === "") {
    if (schema.required) errors.push(`${field} 必填`);
    return errors;
  }

  // 检查类型
  if (typeof value !== "string") {
    errors.push(`${field} 必须是字符串`);
    return errors;
  }

  const str = schema.trim !== false ? value.trim() : value;

  if (schema.minLength !== undefined && str.length < schema.minLength) {
    errors.push(`${field} 至少 ${schema.minLength} 字符`);
  }
  if (schema.maxLength !== undefined && str.length > schema.maxLength) {
    errors.push(`${field} 最多 ${schema.maxLength} 字符`);
  }
  if (schema.pattern && !schema.pattern.test(str)) {
    errors.push(`${field} 格式不正确`);
  }
  if (schema.allowed && !schema.allowed.includes(str)) {
    errors.push(`${field} 必须是 [${schema.allowed.join(", ")}] 之一`);
  }

  return errors;
}

export function validateNumber(value: unknown, field: string, schema: NumberSchema): string[] {
  const errors: string[] = [];

  if (value === undefined || value === null) {
    if (schema.required) errors.push(`${field} 必填`);
    return errors;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    errors.push(`${field} 必须是数字`);
    return errors;
  }

  if (schema.integer && !Number.isInteger(value)) {
    errors.push(`${field} 必须是整数`);
  }
  if (schema.min !== undefined && value < schema.min) {
    errors.push(`${field} 不能小于 ${schema.min}`);
  }
  if (schema.max !== undefined && value > schema.max) {
    errors.push(`${field} 不能大于 ${schema.max}`);
  }

  return errors;
}

export function validateObject(obj: unknown, schema: ObjectSchema): ValidationResult {
  const errors: string[] = [];

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { valid: false, errors: ["请求体必须是 JSON 对象"] };
  }

  const record = obj as Record<string, unknown>;

  for (const [key, fieldSchema] of Object.entries(schema)) {
    const value = record[key];
    if (value === undefined || value === null || value === "") {
      if (fieldSchema.required) errors.push(`${key} 必填`);
      continue;
    }
    if (fieldSchema.type === "string") {
      errors.push(...validateString(value, key, fieldSchema));
    } else if (fieldSchema.type === "number") {
      errors.push(...validateNumber(value, key, fieldSchema));
    }
  }

  return { valid: errors.length === 0, errors };
}

// 安全解析 JSON - 限制大小和深度
export function safeJsonParse(text: string, maxSize = 1024 * 1024): unknown {
  if (text.length > maxSize) {
    throw new Error(`JSON 过大 (${text.length} 字节)`);
  }

  // 简单深度检查：括号嵌套超过 100 层拒绝
  let depth = 0;
  let maxDepth = 0;
  for (const ch of text) {
    if (ch === "{" || ch === "[") {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      if (maxDepth > 100) throw new Error("JSON 嵌套过深");
    } else if (ch === "}" || ch === "]") {
      depth--;
    }
  }

  return JSON.parse(text);
}

// AI 模型名称验证
export function validateModelName(model: string): ValidationResult {
  return validateString(model, "aiModel", {
    type: "string",
    maxLength: 128,
    pattern: /^[a-zA-Z0-9/_-]*$/,
    trim: true,
  });
}

// 人设提示词验证
export function validatePrompt(prompt: string): ValidationResult {
  return validateString(prompt, "aiSystemPrompt", {
    type: "string",
    maxLength: 4096,
    trim: true,
  });
}

// Chat 消息验证
export function validateChatMessage(message: string): ValidationResult {
  return validateString(message, "message", {
    type: "string",
    required: true,
    minLength: 1,
    maxLength: 2000,
    trim: true,
  });
}

// 管理密码验证
export function validateAdminPassword(pwd: string): ValidationResult {
  return validateString(pwd, "pwd", {
    type: "string",
    required: true,
    minLength: 4,
    maxLength: 256,
    trim: true,
  });
}
