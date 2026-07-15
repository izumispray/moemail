import { describe, expect, it } from "bun:test"
import { parseEmailAddress, validateEmailLocalPart } from "./email-address"

describe("validateEmailLocalPart", () => {
  it("accepts a common ASCII dot-atom local part", () => {
    expect(validateEmailLocalPart("first.last+tag")).toEqual({
      success: true,
      value: "first.last+tag",
    })
  })

  it.each([
    ["", "emptyLocalPart"],
    ["has space", "localPartWhitespace"],
    [".leading", "localPartDots"],
    ["trailing.", "localPartDots"],
    ["double..dot", "localPartDots"],
    ["bad@character", "invalidLocalPartCharacters"],
    ["a".repeat(65), "localPartTooLong"],
  ] as const)("rejects %p with %p", (value, error) => {
    expect(validateEmailLocalPart(value)).toEqual({ success: false, error })
  })
})

describe("parseEmailAddress", () => {
  const domains = ["example.com", "mail.example.com", "deep.mail.example.com"]

  it("normalizes the domain and preserves the local part", () => {
    expect(parseEmailAddress("User.Name@DEEP.MAIL.EXAMPLE.COM", domains)).toEqual({
      success: true,
      localPart: "User.Name",
      domain: "deep.mail.example.com",
      address: "User.Name@deep.mail.example.com",
    })
  })

  it("applies the shared domain trimming and trailing-dot normalization", () => {
    expect(parseEmailAddress("user@ EXAMPLE.COM. ", domains)).toEqual({
      success: true,
      localPart: "user",
      domain: "example.com",
      address: "user@example.com",
    })
  })

  it.each(["missing-at.example.com", "two@@example.com", "@example.com"])(
    "rejects malformed address %p",
    (value) => {
      expect(parseEmailAddress(value, domains).success).toBe(false)
    }
  )

  it("requires an exact configured domain", () => {
    expect(parseEmailAddress("user@unknown.example.com", domains)).toEqual({
      success: false,
      error: "domainNotAllowed",
    })
  })

  it("accepts an unconfigured descendant that can be auto-provisioned", () => {
    expect(
      parseEmailAddress("User@NNNN.mail.example.com", domains, {
        "example.com": "zone-root",
      })
    ).toEqual({
      success: true,
      localPart: "User",
      domain: "nnnn.mail.example.com",
      address: "User@nnnn.mail.example.com",
    })
  })

  it("still rejects an unconfigured domain outside the provisionable zones", () => {
    expect(
      parseEmailAddress("user@unknown.example.net", domains, {
        "example.com": "zone-root",
      })
    ).toEqual({
      success: false,
      error: "domainNotAllowed",
    })
  })

  it("rejects an address longer than 254 characters", () => {
    const domain = `${"d".repeat(63)}.${"d".repeat(63)}.${"d".repeat(58)}.com`
    expect(domain.length).toBe(190)
    expect(parseEmailAddress(`${"a".repeat(64)}@${domain}`, [domain])).toEqual({
      success: false,
      error: "addressTooLong",
    })
  })
})
