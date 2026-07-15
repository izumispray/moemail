import { describe, expect, it } from "bun:test"
import { resolveEmailDomain } from "./auto-domain"

describe("resolveEmailDomain", () => {
  it("reuses an exact configured mailbox domain without provisioning", () => {
    expect(
      resolveEmailDomain(
        " MAIL.MAHOOOO.DE. ",
        ["mahoooo.de", "mail.mahoooo.de"],
        { "mahoooo.de": "zone-root" }
      )
    ).toEqual({
      kind: "existing",
      domain: "mail.mahoooo.de",
    })
  })

  it("provisions an unconfigured multi-level descendant of a configured zone", () => {
    expect(
      resolveEmailDomain(
        "NNNN.mail.mahoooo.de",
        ["mahoooo.de", "mail.mahoooo.de"],
        { "mahoooo.de": "zone-root" }
      )
    ).toEqual({
      kind: "provision",
      domain: "nnnn.mail.mahoooo.de",
      rootDomain: "mahoooo.de",
      subdomain: "nnnn.mail",
      zoneId: "zone-root",
    })
  })

  it("uses the most specific configured zone for nested zone mappings", () => {
    expect(
      resolveEmailDomain(
        "dev.mail.example.com",
        ["example.com"],
        {
          "example.com": "zone-root",
          "mail.example.com": "zone-mail",
        }
      )
    ).toEqual({
      kind: "provision",
      domain: "dev.mail.example.com",
      rootDomain: "mail.example.com",
      subdomain: "dev",
      zoneId: "zone-mail",
    })
  })

  it("accepts a configured zone root even when the email-domain KV is stale", () => {
    expect(resolveEmailDomain("example.com", [], { "example.com": "zone-root" })).toEqual({
      kind: "existing",
      domain: "example.com",
    })
  })

  it("rejects a domain outside every configured zone", () => {
    expect(
      resolveEmailDomain("user-controlled.example.net", ["example.com"], {
        "example.com": "zone-root",
      })
    ).toEqual({
      kind: "invalid",
      error: "邮箱域名不属于已配置的根域名",
    })
  })

  it.each([
    "bad_label.example.com",
    "-leading.example.com",
    "trailing-.example.com",
    "a.b.c.d.e.f.example.com",
  ])("rejects an invalid provisioned subdomain %p", (domain) => {
    expect(resolveEmailDomain(domain, ["example.com"], { "example.com": "zone-root" }).kind).toBe(
      "invalid"
    )
  })
})
