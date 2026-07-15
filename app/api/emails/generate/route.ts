import { NextResponse } from "next/server"
import { nanoid } from "nanoid"
import { createDb } from "@/lib/db"
import { emails, domains } from "@/lib/schema"
import { eq, and, gt, sql } from "drizzle-orm"
import { EXPIRY_OPTIONS } from "@/types/email"
import { EMAIL_CONFIG } from "@/config"
import { getRequestContext } from "@cloudflare/next-on-pages"
import { getUserId } from "@/lib/apiKey"
import { getUserRole } from "@/lib/auth"
import { ROLES } from "@/lib/permissions"
import { normalizeDomainName } from "@/lib/domain-utils"
import {
  AUTO_DOMAIN_CLEANUP_GRACE_MS,
  DOMAIN_CLEANUP_POLICIES,
  getCleanupAfter,
} from "@/lib/domain-cleanup"
import { validateEmailLocalPart } from "@/lib/email-address"
import { resolveEmailDomain } from "@/lib/auto-domain"
import { bestEffortDeprovisionDns, getProvisionedDnsRecordIds } from "@/lib/dns-worker-client"

export const runtime = "edge"

function domainUnavailableResponse(status: string) {
  const provisioning = status === "provisioning"
  return NextResponse.json(
    {
      error: provisioning
        ? "该子域名正在创建中，请稍后重试"
        : "该域名正在清理中或不可用",
      code: provisioning ? "domainProvisioning" : "domainUnavailable",
    },
    { status: 409 }
  )
}

export async function POST(request: Request) {
  const db = createDb()
  const env = getRequestContext().env
  const userId = await getUserId()

  if (!userId) {
    return NextResponse.json({ error: "未登录或 API Key 无效" }, { status: 401 })
  }

  try {
    const userRole = await getUserRole(userId)

    if (userRole !== ROLES.EMPEROR) {
      const maxEmails = await env.SITE_CONFIG.get("MAX_EMAILS") || EMAIL_CONFIG.MAX_ACTIVE_EMAILS.toString()
      const activeEmailsCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(emails)
        .where(
          and(
            eq(emails.userId, userId),
            gt(emails.expiresAt, new Date())
          )
        )

      if (Number(activeEmailsCount[0].count) >= Number(maxEmails)) {
        return NextResponse.json(
          { error: `已达到最大邮箱数量限制 (${maxEmails})` },
          { status: 403 }
        )
      }
    }

    const { name, expiryTime, domain } = await request.json<{
      name: string
      expiryTime: number
      domain: string
    }>()

    if (!EXPIRY_OPTIONS.some(option => option.value === expiryTime)) {
      return NextResponse.json({ error: "无效的过期时间" }, { status: 400 })
    }

    const domainString = await env.SITE_CONFIG.get("EMAIL_DOMAINS")
    const allowedDomains = domainString
      ? domainString.split(",").map(normalizeDomainName).filter(Boolean)
      : ["moemail.app"]

    const zonesJson = await env.SITE_CONFIG.get("EMAIL_DOMAIN_ZONES")
    let domainZones: Record<string, string> = {}
    if (zonesJson) {
      try {
        domainZones = JSON.parse(zonesJson) as Record<string, string>
      } catch (error) {
        console.error("Invalid EMAIL_DOMAIN_ZONES configuration:", error)
        return NextResponse.json(
          { error: "域名 Zone 配置无效，请联系管理员" },
          { status: 500 }
        )
      }
    }

    const domainResolution = resolveEmailDomain(domain, allowedDomains, domainZones)
    if (domainResolution.kind === "invalid") {
      return NextResponse.json(
        { error: domainResolution.error, code: "domainNotAllowed" },
        { status: 400 }
      )
    }

    const normalizedDomain = domainResolution.domain
    let activeDomainRecord = await db.query.domains.findFirst({
      where: eq(domains.name, normalizedDomain),
    })

    if (activeDomainRecord && activeDomainRecord.status !== "active") {
      return domainUnavailableResponse(activeDomainRecord.status)
    }

    if (
      domainResolution.kind === "provision" &&
      !activeDomainRecord &&
      userRole !== ROLES.EMPEROR
    ) {
      return NextResponse.json(
        { error: "仅皇帝可自动创建新子域名", code: "autoSubdomainForbidden" },
        { status: 403 }
      )
    }

    const localPart = name || nanoid(8)
    const localPartValidation = validateEmailLocalPart(localPart)
    if (!localPartValidation.success) {
      return NextResponse.json(
        { error: "无效的邮箱前缀", code: localPartValidation.error },
        { status: 400 }
      )
    }

    const address = `${localPartValidation.value}@${normalizedDomain}`
    if (address.length > 254) {
      return NextResponse.json(
        { error: "邮箱地址长度不能超过 254 个字符", code: "addressTooLong" },
        { status: 400 }
      )
    }

    const existingEmail = await db.query.emails.findFirst({
      where: eq(sql`LOWER(${emails.address})`, address.toLowerCase()),
    })
    let expiredEmailId: string | null = null
    if (existingEmail) {
      if (existingEmail.expiresAt < new Date()) {
        expiredEmailId = existingEmail.id
      } else {
        return NextResponse.json({ error: "该邮箱地址已被使用" }, { status: 409 })
      }
    }

    const now = new Date()
    const expires = expiryTime === 0
      ? new Date("9999-01-01T00:00:00.000Z")
      : new Date(now.getTime() + expiryTime)

    let reservedDomainId: string | null = null
    let domainActivated = false
    let provisionedRecordIds: string[] = []
    let provisionedZoneId: string | null = null

    try {
      if (domainResolution.kind === "provision" && !activeDomainRecord) {
        if (!env.DNS_WORKER_URL || !env.DNS_WORKER_SECRET) {
          return NextResponse.json(
            { error: "DNS Worker 未配置，无法自动创建子域名" },
            { status: 500 }
          )
        }

        // Reserve the unique D1 row before provisioning. This is a cross-request
        // lock that prevents duplicate Cloudflare DNS records for the same name.
        try {
          const [reservedDomain] = await db
            .insert(domains)
            .values({
              name: normalizedDomain,
              subdomain: domainResolution.subdomain,
              rootDomain: domainResolution.rootDomain,
              zoneId: domainResolution.zoneId,
              status: "provisioning",
              cleanupPolicy: DOMAIN_CLEANUP_POLICIES.AUTO,
              cleanupAfter: new Date(now.getTime() + AUTO_DOMAIN_CLEANUP_GRACE_MS),
              lastUsedAt: now,
              createdBy: userId,
            })
            .returning()
          reservedDomainId = reservedDomain.id
        } catch (reservationError) {
          const concurrentDomain = await db.query.domains.findFirst({
            where: eq(domains.name, normalizedDomain),
          })

          if (!concurrentDomain) {
            throw reservationError
          }
          if (concurrentDomain.status !== "active") {
            return domainUnavailableResponse(concurrentDomain.status)
          }
          activeDomainRecord = concurrentDomain
        }

        if (reservedDomainId) {
          const dnsResponse = await fetch(`${env.DNS_WORKER_URL}/provision`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${env.DNS_WORKER_SECRET}`,
            },
            body: JSON.stringify({
              zoneId: domainResolution.zoneId,
              subdomain: domainResolution.subdomain,
              rootDomain: domainResolution.rootDomain,
            }),
          })
          const dnsResult = await dnsResponse.json().catch(() => null) as {
            success?: boolean
            mxRecordIds?: string[]
            txtRecordId?: string | null
            error?: string
          } | null

          provisionedRecordIds = dnsResult ? getProvisionedDnsRecordIds(dnsResult) : []
          provisionedZoneId = domainResolution.zoneId

          if (!dnsResponse.ok || !dnsResult?.success) {
            const dnsRolledBack = await bestEffortDeprovisionDns(
              env,
              domainResolution.zoneId,
              provisionedRecordIds,
              normalizedDomain
            )

            if (dnsRolledBack) {
              await db.delete(domains).where(eq(domains.id, reservedDomainId))
            } else {
              await db.update(domains)
                .set({
                  mxRecordIds: JSON.stringify(dnsResult?.mxRecordIds || []),
                  txtRecordId: dnsResult?.txtRecordId || null,
                  status: "cleanup_failed",
                  cleanupAfter: new Date(),
                })
                .where(eq(domains.id, reservedDomainId))
            }
            reservedDomainId = null

            return NextResponse.json(
              { error: `DNS 记录创建失败: ${dnsResult?.error || dnsResponse.status}` },
              { status: 502 }
            )
          }

          const [activatedDomain] = await db
            .update(domains)
            .set({
              mxRecordIds: JSON.stringify(dnsResult.mxRecordIds || []),
              txtRecordId: dnsResult.txtRecordId || null,
              status: "active",
              cleanupAfter: getCleanupAfter(DOMAIN_CLEANUP_POLICIES.AUTO, expires),
              lastUsedAt: now,
            })
            .where(and(
              eq(domains.id, reservedDomainId),
              eq(domains.status, "provisioning")
            ))
            .returning()

          if (!activatedDomain) {
            throw new Error(`Failed to activate reserved domain ${normalizedDomain}`)
          }
          activeDomainRecord = activatedDomain
          domainActivated = true
        }
      }

      if (activeDomainRecord && !domainActivated) {
        const cleanupAfter = activeDomainRecord.cleanupPolicy === DOMAIN_CLEANUP_POLICIES.AUTO
          ? getCleanupAfter(activeDomainRecord.cleanupPolicy, expires)
          : null
        const nextCleanupAfter = cleanupAfter && activeDomainRecord.cleanupAfter && activeDomainRecord.cleanupAfter > cleanupAfter
          ? activeDomainRecord.cleanupAfter
          : cleanupAfter

        const updatedDomains = await db
          .update(domains)
          .set({ lastUsedAt: now, cleanupAfter: nextCleanupAfter })
          .where(and(eq(domains.id, activeDomainRecord.id), eq(domains.status, "active")))
          .returning({ id: domains.id })

        if (updatedDomains.length === 0) {
          return domainUnavailableResponse("cleanup_pending")
        }
      }

      if (expiredEmailId) {
        await db.delete(emails).where(eq(emails.id, expiredEmailId))
      }

      const [result] = await db.insert(emails)
        .values({
          address,
          createdAt: now,
          expiresAt: expires,
          userId,
        })
        .returning({ id: emails.id, address: emails.address })

      return NextResponse.json({
        id: result.id,
        email: result.address,
        domainCreated: domainActivated,
      })
    } catch (creationError) {
      if (reservedDomainId) {
        if (domainActivated) {
          // A concurrent request may already be using the visible domain. Let
          // the cleanup worker recheck active mailboxes before deprovisioning.
          await db.update(domains)
            .set({ cleanupAfter: new Date() })
            .where(eq(domains.id, reservedDomainId))
        } else {
          const rollbackZoneId = provisionedZoneId || (
            domainResolution.kind === "provision" ? domainResolution.zoneId : ""
          )
          const dnsRolledBack = await bestEffortDeprovisionDns(
            env,
            rollbackZoneId,
            provisionedRecordIds,
            normalizedDomain,
            true
          )

          if (dnsRolledBack) {
            await db.delete(domains).where(eq(domains.id, reservedDomainId))
          } else {
            await db.update(domains)
              .set({
                mxRecordIds: JSON.stringify(provisionedRecordIds),
                status: "cleanup_failed",
                cleanupAfter: new Date(),
              })
              .where(eq(domains.id, reservedDomainId))
          }
        }
      }

      const concurrentEmail = await db.query.emails.findFirst({
        where: eq(sql`LOWER(${emails.address})`, address.toLowerCase()),
      })
      if (concurrentEmail && concurrentEmail.expiresAt >= new Date()) {
        return NextResponse.json({ error: "该邮箱地址已被使用" }, { status: 409 })
      }

      throw creationError
    }
  } catch (error) {
    console.error("Failed to generate email:", error)
    return NextResponse.json({ error: "创建邮箱失败" }, { status: 500 })
  }
}
