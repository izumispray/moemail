import { describe, expect, test } from "bun:test"
import {
  PERMANENT_EXPIRY_ISO,
  PERMANENT_EXPIRY_MS,
  isPermanentExpiry,
  resolveEmailExpiry,
  resolveEmailRenewal,
} from "./email-expiry"
import {
  AUTO_DOMAIN_CLEANUP_GRACE_MS,
  DOMAIN_CLEANUP_POLICIES,
  getCleanupAfter,
} from "./domain-cleanup"

const BASE_DATE = new Date("2026-01-01T00:00:00.000Z")

describe("resolveEmailExpiry", () => {
  test.each([
    60 * 60 * 1000,
    24 * 60 * 60 * 1000,
    3 * 24 * 60 * 60 * 1000,
    90 * 60 * 1000,
  ])("accepts preset and custom duration %d", (expiryTime) => {
    const result = resolveEmailExpiry(expiryTime, BASE_DATE)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.expiresAt.getTime()).toBe(BASE_DATE.getTime() + expiryTime)
      expect(result.permanent).toBe(false)
    }
  })

  test("keeps zero as permanent", () => {
    const result = resolveEmailExpiry(0, BASE_DATE)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.expiresAt.toISOString()).toBe(PERMANENT_EXPIRY_ISO)
      expect(isPermanentExpiry(result.expiresAt)).toBe(true)
    }
  })

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3600000", undefined])(
    "rejects invalid value %p",
    (value) => {
      expect(resolveEmailExpiry(value, BASE_DATE)).toMatchObject({
        success: false,
        code: "invalidExpiryTime",
      })
    }
  )

  test("rejects a duration that exceeds the permanent sentinel", () => {
    const result = resolveEmailExpiry(
      2,
      new Date(PERMANENT_EXPIRY_MS - 1)
    )

    expect(result).toMatchObject({ success: false, code: "expiryOverflow" })
  })
})

describe("resolveEmailRenewal", () => {
  const now = new Date("2026-01-01T00:00:00.000Z")
  const currentExpiry = new Date("2026-01-02T00:00:00.000Z")

  test("extends from the current expiry instead of the current time", () => {
    const result = resolveEmailRenewal(currentExpiry, 24 * 60 * 60 * 1000, now)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.expiresAt.toISOString()).toBe("2026-01-03T00:00:00.000Z")
    }
  })

  test("converts an active email to permanent with zero", () => {
    const result = resolveEmailRenewal(currentExpiry, 0, now)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.permanent).toBe(true)
    }
  })

  test("successive renewals keep accumulating from the latest expiry", () => {
    const first = resolveEmailRenewal(currentExpiry, 60 * 60 * 1000, now)
    expect(first.success).toBe(true)
    if (!first.success) return

    const second = resolveEmailRenewal(first.expiresAt, 60 * 60 * 1000, now)
    expect(second.success).toBe(true)
    if (second.success) {
      expect(second.expiresAt.getTime()).toBe(currentExpiry.getTime() + 2 * 60 * 60 * 1000)
    }
  })

  test("rejects an expired email", () => {
    expect(resolveEmailRenewal(now, 60_000, now)).toMatchObject({
      success: false,
      code: "emailExpired",
    })
  })

  test("rejects a permanent email", () => {
    expect(
      resolveEmailRenewal(new Date(PERMANENT_EXPIRY_MS), 60_000, now)
    ).toMatchObject({ success: false, code: "emailPermanent" })
  })
})

describe("renewal cleanup scheduling", () => {
  test("schedules auto-domain cleanup after the renewed expiry", () => {
    const renewedExpiry = new Date("2026-01-03T00:00:00.000Z")
    const cleanupAfter = getCleanupAfter(DOMAIN_CLEANUP_POLICIES.AUTO, renewedExpiry)

    expect(cleanupAfter?.getTime()).toBe(
      renewedExpiry.getTime() + AUTO_DOMAIN_CLEANUP_GRACE_MS
    )
  })

  test("keeps permanent auto-domain mailboxes unscheduled", () => {
    expect(
      getCleanupAfter(
        DOMAIN_CLEANUP_POLICIES.AUTO,
        new Date(PERMANENT_EXPIRY_MS)
      )
    ).toBeNull()
  })
})
