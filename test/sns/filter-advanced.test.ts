import { describe, it, expect } from "vitest";
import {
  matchesFilterPolicy,
  matchesFilterPolicyOnBody,
} from "../../src/sns/filter.js";

describe("SNS Filter Policy: Advanced Features", () => {
  describe("anything-but with suffix (3.8)", () => {
    it("matches when value does not end with excluded suffix", () => {
      const policy = { filename: [{ "anything-but": { suffix: ".tmp" } }] };
      const attrs = {
        filename: { DataType: "String", StringValue: "report.pdf" },
      };
      expect(matchesFilterPolicy(policy, attrs)).toBe(true);
    });

    it("does not match when value ends with excluded suffix", () => {
      const policy = { filename: [{ "anything-but": { suffix: ".tmp" } }] };
      const attrs = {
        filename: { DataType: "String", StringValue: "data.tmp" },
      };
      expect(matchesFilterPolicy(policy, attrs)).toBe(false);
    });

    it("does not match when attribute is missing", () => {
      const policy = { filename: [{ "anything-but": { suffix: ".tmp" } }] };
      expect(matchesFilterPolicy(policy, {})).toBe(false);
    });
  });

  describe("$or top-level key (3.9)", () => {
    it("matches when any $or group matches", () => {
      const policy = {
        $or: [
          { color: ["red"] },
          { size: ["large"] },
        ],
      };
      const attrs = {
        color: { DataType: "String", StringValue: "blue" },
        size: { DataType: "String", StringValue: "large" },
      };
      expect(matchesFilterPolicy(policy, attrs)).toBe(true);
    });

    it("does not match when no $or group matches", () => {
      const policy = {
        $or: [
          { color: ["red"] },
          { size: ["large"] },
        ],
      };
      const attrs = {
        color: { DataType: "String", StringValue: "blue" },
        size: { DataType: "String", StringValue: "small" },
      };
      expect(matchesFilterPolicy(policy, attrs)).toBe(false);
    });

    it("combines $or with AND keys", () => {
      const policy = {
        source: ["orderProcessor"],
        $or: [
          { priority: ["high"] },
          { type: ["urgent"] },
        ],
      };

      // Matches: source matches AND one $or group matches
      const attrs1 = {
        source: { DataType: "String", StringValue: "orderProcessor" },
        priority: { DataType: "String", StringValue: "high" },
      };
      expect(matchesFilterPolicy(policy, attrs1)).toBe(true);

      // Does not match: source does not match
      const attrs2 = {
        source: { DataType: "String", StringValue: "other" },
        priority: { DataType: "String", StringValue: "high" },
      };
      expect(matchesFilterPolicy(policy, attrs2)).toBe(false);

      // Does not match: no $or group matches
      const attrs3 = {
        source: { DataType: "String", StringValue: "orderProcessor" },
        priority: { DataType: "String", StringValue: "low" },
        type: { DataType: "String", StringValue: "normal" },
      };
      expect(matchesFilterPolicy(policy, attrs3)).toBe(false);
    });

    it("handles $or with single group", () => {
      const policy = {
        $or: [{ color: ["red"] }],
      };
      const attrs = {
        color: { DataType: "String", StringValue: "red" },
      };
      expect(matchesFilterPolicy(policy, attrs)).toBe(true);
    });

    it("handles $or with operator conditions", () => {
      const policy = {
        $or: [
          { price: [{ numeric: ["<", 10] }] },
          { discount: [{ exists: true }] },
        ],
      };

      const attrs1 = {
        price: { DataType: "Number", StringValue: "5" },
      };
      expect(matchesFilterPolicy(policy, attrs1)).toBe(true);

      const attrs2 = {
        price: { DataType: "Number", StringValue: "20" },
        discount: { DataType: "String", StringValue: "10%" },
      };
      expect(matchesFilterPolicy(policy, attrs2)).toBe(true);

      const attrs3 = {
        price: { DataType: "Number", StringValue: "20" },
      };
      expect(matchesFilterPolicy(policy, attrs3)).toBe(false);
    });
  });

  describe("nested keys for MessageBody scope (3.7)", () => {
    it("matches top-level body keys", () => {
      const policy = { status: ["active"] };
      const body = JSON.stringify({ status: "active", name: "test" });
      expect(matchesFilterPolicyOnBody(policy, body)).toBe(true);
    });

    it("matches nested body keys", () => {
      const policy = { user: { name: ["Alice"] } };
      const body = JSON.stringify({ user: { name: "Alice", age: 30 } });
      expect(matchesFilterPolicyOnBody(policy, body)).toBe(true);
    });

    it("does not match when nested key has wrong value", () => {
      const policy = { user: { name: ["Alice"] } };
      const body = JSON.stringify({ user: { name: "Bob", age: 30 } });
      expect(matchesFilterPolicyOnBody(policy, body)).toBe(false);
    });

    it("matches deeply nested keys", () => {
      const policy = { order: { item: { category: ["electronics"] } } };
      const body = JSON.stringify({
        order: { item: { category: "electronics", name: "laptop" } },
      });
      expect(matchesFilterPolicyOnBody(policy, body)).toBe(true);
    });

    it("supports operator conditions on nested keys", () => {
      const policy = {
        order: { total: [{ numeric: [">", 100] }] },
      };
      const body = JSON.stringify({ order: { total: 150 } });
      expect(matchesFilterPolicyOnBody(policy, body)).toBe(true);
    });

    it("does not match when nested key is missing", () => {
      const policy = { user: { email: ["alice@test.com"] } };
      const body = JSON.stringify({ user: { name: "Alice" } });
      expect(matchesFilterPolicyOnBody(policy, body)).toBe(false);
    });

    it("supports prefix operator on nested keys", () => {
      const policy = { event: { type: [{ prefix: "order." }] } };
      const body = JSON.stringify({ event: { type: "order.created" } });
      expect(matchesFilterPolicyOnBody(policy, body)).toBe(true);
    });

    it("supports $or with nested body matching", () => {
      const policy = {
        $or: [
          { user: { role: ["admin"] } },
          { user: { role: ["superadmin"] } },
        ],
      };
      const body = JSON.stringify({ user: { role: "admin" } });
      expect(matchesFilterPolicyOnBody(policy, body)).toBe(true);
    });

    it("returns false for non-JSON body", () => {
      const policy = { status: ["active"] };
      expect(matchesFilterPolicyOnBody(policy, "not json")).toBe(false);
    });

    it("returns false for non-object JSON body", () => {
      const policy = { status: ["active"] };
      expect(matchesFilterPolicyOnBody(policy, '"a string"')).toBe(false);
    });
  });

  describe("standalone suffix operator", () => {
    it("matches when attribute value ends with suffix", () => {
      const policy = { filename: [{ suffix: ".pdf" }] };
      const attrs = {
        filename: { DataType: "String", StringValue: "report.pdf" },
      };
      expect(matchesFilterPolicy(policy, attrs)).toBe(true);
    });

    it("does not match when attribute value does not end with suffix", () => {
      const policy = { filename: [{ suffix: ".pdf" }] };
      const attrs = {
        filename: { DataType: "String", StringValue: "report.txt" },
      };
      expect(matchesFilterPolicy(policy, attrs)).toBe(false);
    });
  });

  describe("null condition", () => {
    it("matches when attribute is absent", () => {
      const policy = { color: [null] };
      expect(matchesFilterPolicy(policy, {})).toBe(true);
    });

    it("does not match when attribute is present", () => {
      const policy = { color: [null] };
      const attrs = {
        color: { DataType: "String", StringValue: "red" },
      };
      expect(matchesFilterPolicy(policy, attrs)).toBe(false);
    });
  });

  describe("exists: false", () => {
    it("matches when attribute is absent", () => {
      const policy = { color: [{ exists: false }] };
      expect(matchesFilterPolicy(policy, {})).toBe(true);
    });

    it("does not match when attribute is present", () => {
      const policy = { color: [{ exists: false }] };
      const attrs = {
        color: { DataType: "String", StringValue: "red" },
      };
      expect(matchesFilterPolicy(policy, attrs)).toBe(false);
    });
  });
});
