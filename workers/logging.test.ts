import { describe, expect, test } from "bun:test"
import {
  describeError,
  parseJsonForLog,
  summarizeUrlForLog,
  truncateForLog,
} from "./logging"

describe("worker logging helpers", () => {
  test("normalizes Error and non-Error values", () => {
    expect(describeError(new TypeError("broken"))).toMatchObject({
      name: "TypeError",
      message: "broken",
    })
    expect(describeError("broken")).toEqual({ message: "broken" })
  })

  test("truncates long response bodies", () => {
    expect(truncateForLog("short", 10)).toBe("short")
    expect(truncateForLog("0123456789", 5)).toBe("01234...")
  })

  test("parses JSON without throwing", () => {
    expect(parseJsonForLog<{ success: boolean }>("{\"success\":true}")).toEqual({ success: true })
    expect(parseJsonForLog("not-json")).toBeNull()
  })

  test("summarizes URLs without exposing credentials or query values", () => {
    const summary = summarizeUrlForLog("https://user:password@example.com/deprovision?token=secret")

    expect(summary).toEqual({
      origin: "https://example.com",
      pathname: "/deprovision",
      hasSearch: true,
    })
    expect(JSON.stringify(summary)).not.toContain("password")
    expect(JSON.stringify(summary)).not.toContain("secret")
  })

  test("does not echo invalid URL input", () => {
    const summary = summarizeUrlForLog("secret-value")

    expect(summary.origin).toBe("invalid-url")
    expect(JSON.stringify(summary)).not.toContain("secret-value")
  })
})
