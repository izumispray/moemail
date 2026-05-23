import { DOMAIN_CLEANUP_POLICIES } from "@/lib/domain-cleanup"
import { PERMISSIONS, Role, ROLES } from "@/lib/permissions"
import { getRequestContext } from "@cloudflare/next-on-pages"
import { EMAIL_CONFIG } from "@/config"
import { checkPermission } from "@/lib/auth"
import { getRegistrationStatus, REGISTRATION_ENABLED_KEY } from "@/lib/registration"
import { createDb } from "@/lib/db"
import { domains } from "@/lib/schema"
import { and, eq } from "drizzle-orm"
import { normalizeDomainName } from "@/lib/domain-utils"

export const runtime = "edge"

function parseDomainList(value: string | null | undefined): string[] {
  if (!value) return []

  return Array.from(new Set(
    value
      .split(",")
      .map((domain) => normalizeDomainName(domain))
      .filter(Boolean)
  ))
}

function stringifyDomainList(domainList: string[]): string {
  return domainList.join(",")
}

function hasConfiguredAncestor(domain: string, candidates: string[]): boolean {
  const candidateSet = new Set(candidates)
  const parts = domain.split(".")

  for (let index = 1; index < parts.length - 1; index++) {
    const ancestor = parts.slice(index).join(".")
    if (candidateSet.has(ancestor)) {
      return true
    }
  }

  return false
}

async function getActiveManualDomainNames(): Promise<string[]> {
  const db = createDb()
  const activeDomains = await db
    .select({ name: domains.name })
    .from(domains)
    .where(and(
      eq(domains.cleanupPolicy, DOMAIN_CLEANUP_POLICIES.MANUAL),
      eq(domains.status, "active")
    ))

  return activeDomains.map((domain) => normalizeDomainName(domain.name)).filter(Boolean)
}

async function getActiveAutoDomainNames(): Promise<string[]> {
  const db = createDb()
  const activeDomains = await db
    .select({ name: domains.name })
    .from(domains)
    .where(and(
      eq(domains.cleanupPolicy, DOMAIN_CLEANUP_POLICIES.AUTO),
      eq(domains.status, "active")
    ))

  return activeDomains.map((domain) => normalizeDomainName(domain.name)).filter(Boolean)
}

async function getAutoDomainNames(): Promise<string[]> {
  const db = createDb()
  const autoDomains = await db
    .select({ name: domains.name })
    .from(domains)
    .where(eq(domains.cleanupPolicy, DOMAIN_CLEANUP_POLICIES.AUTO))

  return autoDomains.map((domain) => normalizeDomainName(domain.name)).filter(Boolean)
}

function normalizeDomainZones(value: Record<string, string> | null | undefined): Record<string, string> {
  if (!value) return {}

  return Object.fromEntries(
    Object.entries(value)
      .map(([domain, zoneId]) => [normalizeDomainName(domain), zoneId] as const)
      .filter(([domain, zoneId]) => domain && typeof zoneId === "string" && zoneId.length > 0)
  )
}

function sanitizeEmailDomains(
  requestedDomains: string[],
  domainZones: Record<string, string>,
  activeDomainNames: string[],
  hiddenDomainNames: string[] = []
): string[] {
  const activeDomainSet = new Set(activeDomainNames)
  const hiddenDomainSet = new Set(hiddenDomainNames)
  const zoneDomainSet = new Set(Object.keys(domainZones))
  const mergedDomains = Array.from(new Set([...requestedDomains, ...activeDomainNames]))

  return mergedDomains.filter((domain) => {
    if (hiddenDomainSet.has(domain)) {
      return false
    }

    if (activeDomainSet.has(domain) || zoneDomainSet.has(domain)) {
      return true
    }

    return !hasConfiguredAncestor(domain, mergedDomains)
  })
}

export async function GET() {
  const env = getRequestContext().env
  const canManageConfig = await checkPermission(PERMISSIONS.MANAGE_CONFIG)

  const [
    defaultRole,
    emailDomains,
    adminContact,
    maxEmails,
    turnstileEnabled,
    turnstileSiteKey,
    turnstileSecretKey,
    domainZones,
    registration,
    activeManualDomainNames,
    autoDomainNames
  ] = await Promise.all([
    env.SITE_CONFIG.get("DEFAULT_ROLE"),
    env.SITE_CONFIG.get("EMAIL_DOMAINS"),
    env.SITE_CONFIG.get("ADMIN_CONTACT"),
    env.SITE_CONFIG.get("MAX_EMAILS"),
    env.SITE_CONFIG.get("TURNSTILE_ENABLED"),
    env.SITE_CONFIG.get("TURNSTILE_SITE_KEY"),
    env.SITE_CONFIG.get("TURNSTILE_SECRET_KEY"),
    env.SITE_CONFIG.get("EMAIL_DOMAIN_ZONES"),
    getRegistrationStatus(),
    getActiveManualDomainNames(),
    getAutoDomainNames()
  ])
  const parsedDomainZones = normalizeDomainZones(domainZones ? JSON.parse(domainZones) : {})
  const requestedEmailDomains = parseDomainList(emailDomains || "moemail.app")
  const sanitizedEmailDomains = sanitizeEmailDomains(
    requestedEmailDomains,
    parsedDomainZones,
    activeManualDomainNames,
    autoDomainNames
  )
  const sanitizedEmailDomainsString = stringifyDomainList(sanitizedEmailDomains)

  return Response.json({
    defaultRole: defaultRole || ROLES.CIVILIAN,
    emailDomains: sanitizedEmailDomainsString,
    adminContact: adminContact || "",
    maxEmails: maxEmails || EMAIL_CONFIG.MAX_ACTIVE_EMAILS.toString(),
    domainZones: parsedDomainZones,
    registrationEnabled: registration.enabled,
    turnstile: canManageConfig ? {
      enabled: turnstileEnabled === "true",
      siteKey: turnstileSiteKey || "",
      secretKey: turnstileSecretKey || "",
    } : undefined
  }, {
    headers: {
      "Cache-Control": "no-store",
    },
  })
}

export async function POST(request: Request) {
  const canAccess = await checkPermission(PERMISSIONS.MANAGE_CONFIG)

  if (!canAccess) {
    return Response.json({
      error: "权限不足"
    }, { status: 403 })
  }

  const {
    defaultRole,
    emailDomains,
    adminContact,
    maxEmails,
    domainZones,
    registrationEnabled,
    turnstile
  } = await request.json() as { 
    defaultRole: Exclude<Role, typeof ROLES.EMPEROR>,
    emailDomains: string,
    adminContact: string,
    maxEmails: string,
    domainZones?: Record<string, string>,
    registrationEnabled?: boolean,
    turnstile?: {
      enabled: boolean,
      siteKey: string,
      secretKey: string
    }
  }
  
  if (![ROLES.DUKE, ROLES.KNIGHT, ROLES.CIVILIAN].includes(defaultRole)) {
    return Response.json({ error: "无效的角色" }, { status: 400 })
  }

  const turnstileConfig = turnstile ?? {
    enabled: false,
    siteKey: "",
    secretKey: ""
  }

  if (turnstileConfig.enabled && (!turnstileConfig.siteKey || !turnstileConfig.secretKey)) {
    return Response.json({ error: "Turnstile 启用时需要提供 Site Key 和 Secret Key" }, { status: 400 })
  }

  if (registrationEnabled !== undefined && typeof registrationEnabled !== "boolean") {
    return Response.json({ error: "无效的注册开关配置" }, { status: 400 })
  }

  const env = getRequestContext().env
  const normalizedDomainZones = normalizeDomainZones(domainZones || {})
  const [activeManualDomainNames, activeAutoDomainNames, autoDomainNames] = await Promise.all([
    getActiveManualDomainNames(),
    getActiveAutoDomainNames(),
    getAutoDomainNames(),
  ])
  const sanitizedEmailDomains = sanitizeEmailDomains(
    parseDomainList(emailDomains),
    normalizedDomainZones,
    activeManualDomainNames,
    autoDomainNames
  )
  const persistedEmailDomains = Array.from(new Set([...sanitizedEmailDomains, ...activeAutoDomainNames]))
  const updates = [
    env.SITE_CONFIG.put("DEFAULT_ROLE", defaultRole),
    env.SITE_CONFIG.put("EMAIL_DOMAINS", stringifyDomainList(persistedEmailDomains)),
    env.SITE_CONFIG.put("ADMIN_CONTACT", adminContact),
    env.SITE_CONFIG.put("MAX_EMAILS", maxEmails),
    env.SITE_CONFIG.put("EMAIL_DOMAIN_ZONES", JSON.stringify(normalizedDomainZones)),
    env.SITE_CONFIG.put("TURNSTILE_ENABLED", turnstileConfig.enabled.toString()),
    env.SITE_CONFIG.put("TURNSTILE_SITE_KEY", turnstileConfig.siteKey),
    env.SITE_CONFIG.put("TURNSTILE_SECRET_KEY", turnstileConfig.secretKey)
  ]

  if (registrationEnabled !== undefined) {
    updates.push(env.SITE_CONFIG.put(REGISTRATION_ENABLED_KEY, registrationEnabled.toString()))
  }

  await Promise.all(updates)

  return Response.json({ success: true })
} 
