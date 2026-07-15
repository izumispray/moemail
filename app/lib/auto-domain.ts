import { normalizeDomainName, validateSubdomainPrefix } from "./domain-utils"

export interface ExistingEmailDomainResolution {
  kind: "existing"
  domain: string
}

export interface ProvisionEmailDomainResolution {
  kind: "provision"
  domain: string
  rootDomain: string
  subdomain: string
  zoneId: string
}

export interface InvalidEmailDomainResolution {
  kind: "invalid"
  error: string
}

export type EmailDomainResolution =
  | ExistingEmailDomainResolution
  | ProvisionEmailDomainResolution
  | InvalidEmailDomainResolution

/**
 * Resolve a requested mailbox domain against the configured domain list and
 * Cloudflare zones. Exact configured domains are reused. A valid descendant
 * of a configured zone is returned as a domain that must be provisioned.
 */
export function resolveEmailDomain(
  value: unknown,
  configuredDomains: readonly string[],
  domainZones: Readonly<Record<string, string>>
): EmailDomainResolution {
  if (typeof value !== "string") {
    return { kind: "invalid", error: "无效的域名" }
  }

  const domain = normalizeDomainName(value)
  if (!domain) {
    return { kind: "invalid", error: "无效的域名" }
  }

  const normalizedConfiguredDomains = new Set(
    configuredDomains.map(normalizeDomainName).filter(Boolean)
  )
  if (normalizedConfiguredDomains.has(domain)) {
    return { kind: "existing", domain }
  }

  const matchingZone = Object.entries(domainZones)
    .map(([rootDomain, zoneId]) => ({
      rootDomain: normalizeDomainName(rootDomain),
      zoneId: typeof zoneId === "string" ? zoneId.trim() : "",
    }))
    .filter(({ rootDomain, zoneId }) =>
      Boolean(rootDomain && zoneId) &&
      (domain === rootDomain || domain.endsWith(`.${rootDomain}`))
    )
    .sort((left, right) => right.rootDomain.length - left.rootDomain.length)[0]

  if (!matchingZone) {
    return { kind: "invalid", error: "邮箱域名不属于已配置的根域名" }
  }

  // Zone roots are configured mailbox domains even if an older KV value has
  // not yet been synchronized.
  if (domain === matchingZone.rootDomain) {
    return { kind: "existing", domain }
  }

  const subdomain = domain.slice(0, -(matchingZone.rootDomain.length + 1))
  const validation = validateSubdomainPrefix(subdomain, matchingZone.rootDomain)
  if (!validation.success) {
    return { kind: "invalid", error: validation.error }
  }

  return {
    kind: "provision",
    domain,
    rootDomain: matchingZone.rootDomain,
    subdomain: validation.value,
    zoneId: matchingZone.zoneId,
  }
}
