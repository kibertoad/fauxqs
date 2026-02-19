import type { MessageAttributeValue } from "../sqs/sqsTypes.ts";

/**
 * Evaluates an SNS filter policy against message attributes.
 *
 * Filter policy is a JSON object where:
 * - Top-level keys are AND'd together (all must match)
 * - Values for each key are OR'd (any can match)
 *
 * Value patterns can be:
 * - Exact string: "value"
 * - Exact number: 123
 * - Prefix: { "prefix": "val" }
 * - Anything-but: { "anything-but": ["x", "y"] } or { "anything-but": "x" }
 * - Numeric: { "numeric": [">=", 0, "<", 100] }
 * - Exists: { "exists": true } or { "exists": false }
 */
export function matchesFilterPolicy(
  policy: Record<string, unknown>,
  attributes: Record<string, MessageAttributeValue>,
): boolean {
  // All top-level keys must match (AND)
  for (const [key, conditions] of Object.entries(policy)) {
    if (!matchesKeyConditions(key, conditions, attributes)) {
      return false;
    }
  }
  return true;
}

function matchesKeyConditions(
  key: string,
  conditions: unknown,
  attributes: Record<string, MessageAttributeValue>,
): boolean {
  if (!Array.isArray(conditions)) {
    conditions = [conditions];
  }

  const attr = attributes[key];

  // Check each condition (OR)
  for (const condition of conditions as unknown[]) {
    if (matchesSingleCondition(condition, attr)) {
      return true;
    }
  }

  return false;
}

function matchesSingleCondition(
  condition: unknown,
  attr: MessageAttributeValue | undefined,
): boolean {
  // Null condition — matches if attribute is not present
  if (condition === null || condition === undefined) {
    return attr === undefined;
  }

  // String exact match
  if (typeof condition === "string") {
    return attr !== undefined && getStringValue(attr) === condition;
  }

  // Number exact match
  if (typeof condition === "number") {
    return attr !== undefined && getNumericValue(attr) === condition;
  }

  // Boolean (treat as string)
  if (typeof condition === "boolean") {
    return attr !== undefined && getStringValue(attr) === String(condition);
  }

  // Object operators
  if (typeof condition === "object" && condition !== null) {
    const op = condition as Record<string, unknown>;

    // { "exists": true/false }
    if ("exists" in op) {
      return op.exists ? attr !== undefined : attr === undefined;
    }

    // { "prefix": "value" }
    if ("prefix" in op) {
      if (attr === undefined) return false;
      return getStringValue(attr).startsWith(op.prefix as string);
    }

    // { "suffix": "value" }
    if ("suffix" in op) {
      if (attr === undefined) return false;
      return getStringValue(attr).endsWith(op.suffix as string);
    }

    // { "anything-but": "value" | ["value1", "value2"] | { "prefix": "..." } }
    if ("anything-but" in op) {
      if (attr === undefined) return false;
      const value = getStringValue(attr);
      const numValue = getNumericValue(attr);
      const excluded = op["anything-but"];

      if (Array.isArray(excluded)) {
        return !excluded.some((e) => {
          if (typeof e === "string") return value === e;
          if (typeof e === "number") return numValue === e;
          return false;
        });
      }

      if (
        typeof excluded === "object" &&
        excluded !== null &&
        "prefix" in (excluded as Record<string, unknown>)
      ) {
        return !value.startsWith((excluded as Record<string, string>).prefix);
      }

      if (typeof excluded === "string") return value !== excluded;
      if (typeof excluded === "number") return numValue !== excluded;
      return true;
    }

    // { "numeric": [">=", 0, "<", 100] }
    if ("numeric" in op) {
      if (attr === undefined) return false;
      const numValue = getNumericValue(attr);
      if (numValue === undefined) return false;
      return evaluateNumeric(numValue, op.numeric as unknown[]);
    }
  }

  return false;
}

function getStringValue(attr: MessageAttributeValue): string {
  return attr.StringValue ?? "";
}

function getNumericValue(attr: MessageAttributeValue): number | undefined {
  if (attr.DataType === "Number" || attr.DataType.startsWith("Number.")) {
    const num = Number(attr.StringValue);
    return isNaN(num) ? undefined : num;
  }
  // Try parsing string as number
  if (attr.StringValue) {
    const num = Number(attr.StringValue);
    return isNaN(num) ? undefined : num;
  }
  return undefined;
}

function evaluateNumeric(value: number, conditions: unknown[]): boolean {
  let i = 0;
  while (i < conditions.length) {
    const operator = conditions[i] as string;
    const operand = conditions[i + 1] as number;
    i += 2;

    switch (operator) {
      case "=":
        if (value !== operand) return false;
        break;
      case ">":
        if (value <= operand) return false;
        break;
      case ">=":
        if (value < operand) return false;
        break;
      case "<":
        if (value >= operand) return false;
        break;
      case "<=":
        if (value > operand) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/**
 * Parses a JSON message body into attribute-like format for filter policy evaluation.
 * Returns undefined if the body is not valid JSON or not an object.
 */
export function parseBodyAsAttributes(
  messageBody: string,
): Record<string, MessageAttributeValue> | undefined {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(messageBody);
  } catch {
    return undefined;
  }

  if (typeof body !== "object" || body === null) {
    return undefined;
  }

  const attrs: Record<string, MessageAttributeValue> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") {
      attrs[key] = { DataType: "String", StringValue: value };
    } else if (typeof value === "number") {
      attrs[key] = { DataType: "Number", StringValue: String(value) };
    } else if (typeof value === "boolean") {
      attrs[key] = { DataType: "String", StringValue: String(value) };
    }
  }

  return attrs;
}

/**
 * Evaluates a filter policy against the message body (when FilterPolicyScope is "MessageBody").
 * The message body is parsed as JSON, and the policy is matched against it.
 */
export function matchesFilterPolicyOnBody(
  policy: Record<string, unknown>,
  messageBody: string,
): boolean {
  const attrs = parseBodyAsAttributes(messageBody);
  if (!attrs) return false;
  return matchesFilterPolicy(policy, attrs);
}
