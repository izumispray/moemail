import { NextResponse } from "next/server"
import { createDb } from "@/lib/db"
import { domains } from "@/lib/schema"
import { eq, and } from "drizzle-orm"
import { getRequestContext } from "@cloudflare/next-on-pages"
import { checkPermission } from "@/lib/auth"
import { PERMISSIONS } from "@/lib/permissions"
import { getUserId } from "@/lib/apiKey"
import { buildFullDomain, normalizeDomainName, validateSubdomainPrefix } from "@/lib/domain-utils"
import { DOMAIN_CLEANUP_POLICIES } from "@/lib/domain-cleanup"
import { bestEffortDeprovisionDns, getProvisionedDnsRecordIds } from "@/lib/dns-worker-client"

export const runtime = "edge"

async function removeDomainFromKv(env: Env, domainName: string) {
  const currentDomains = await env.SITE_CONFIG.get("EMAIL_DOMAINS")
  if (!currentDomains) return

  const normalizedDomainName = normalizeDomainName(domainName)
  const domainList = currentDomains
    .split(",")
    .map((domain) => normalizeDomainName(domain))
    .filter((domain) => domain && domain !== normalizedDomainName)

  await env.SITE_CONFIG.put("EMAIL_DOMAINS", domainList.join(","))
}

/**
 * GET /api/domains
 * 获取所有已配置的子域名列表（仅皇帝可访问）
 */
export async function GET(request: Request) {
  const canAccess = await checkPermission(PERMISSIONS.MANAGE_CONFIG)
  if (!canAccess) {
    return NextResponse.json({ error: "权限不足" }, { status: 403 })
  }

  const db = createDb()

  const { searchParams } = new URL(request.url)
  const rootDomain = searchParams.get("rootDomain")

  const conditions = []
  if (rootDomain) {
    conditions.push(eq(domains.rootDomain, rootDomain))
  }
  conditions.push(eq(domains.cleanupPolicy, DOMAIN_CLEANUP_POLICIES.MANUAL))
  conditions.push(eq(domains.status, "active"))

  const allDomains = await db.query.domains.findMany({
    where: and(...conditions),
    orderBy: (domains, { desc }) => [desc(domains.createdAt)],
  })

  return NextResponse.json({ domains: allDomains })
}

/**
 * POST /api/domains
 * 添加新子域名（自动创建 DNS 记录 + 更新 KV 域名列表）
 *
 * Request body:
 * {
 *   subdomain: string  // 子域名前缀，如 "newsletter" 或 "dev.newsletter"
 * }
 */
export async function POST(request: Request) {
  const canAccess = await checkPermission(PERMISSIONS.MANAGE_CONFIG)
  if (!canAccess) {
    return NextResponse.json({ error: "权限不足" }, { status: 403 })
  }

  const userId = await getUserId()
  if (!userId) {
    return NextResponse.json({ error: "未登录" }, { status: 401 })
  }

  const db = createDb()
  const env = getRequestContext().env

  try {
    const { subdomain, domain } = await request.json<{ subdomain: string; domain: string }>()
    const rootDomain = typeof domain === "string" ? normalizeDomainName(domain) : ""

    // 参数校验
    if (!subdomain || typeof subdomain !== "string") {
      return NextResponse.json({ error: "子域名不能为空" }, { status: 400 })
    }

    if (!rootDomain || typeof rootDomain !== "string") {
      return NextResponse.json({ error: "基础域名不能为空" }, { status: 400 })
    }

    const subdomainValidation = validateSubdomainPrefix(subdomain, rootDomain)
    if (!subdomainValidation.success) {
      return NextResponse.json({ error: subdomainValidation.error }, { status: 400 })
    }
    const normalizedSubdomain = subdomainValidation.value

    // 从 KV 读取预存的 Zone ID
    const zonesJson = await env.SITE_CONFIG.get("EMAIL_DOMAIN_ZONES")
    const zones: Record<string, string> = zonesJson ? JSON.parse(zonesJson) : {}
    const normalizedZones = Object.fromEntries(
      Object.entries(zones).map(([domain, zoneId]) => [normalizeDomainName(domain), zoneId])
    )
    const zoneId = normalizedZones[rootDomain]
    if (!zoneId) {
      return NextResponse.json(
        { error: `域名 ${rootDomain} 未配置 Zone ID，请在前端配置中填写` },
        { status: 400 }
      )
    }

    const apiToken = env.CLOUDFLARE_API_TOKEN
    if (!apiToken) {
      return NextResponse.json(
        { error: "Cloudflare 配置不完整，请检查环境变量 CLOUDFLARE_API_TOKEN" },
        { status: 500 }
      )
    }

    const fullDomain = buildFullDomain(normalizedSubdomain, rootDomain)
    const now = new Date()

    // 检查是否已存在
    const existing = await db.query.domains.findFirst({
      where: eq(domains.name, fullDomain),
    })

    if (existing) {
      return NextResponse.json(
        { error: `子域名 ${fullDomain} 已存在` },
        { status: 409 }
      )
    }

    // 1. 通过 DNS Worker 创建 MX + SPF 记录
    const dnsWorkerUrl = env.DNS_WORKER_URL
    const dnsWorkerSecret = env.DNS_WORKER_SECRET
    if (!dnsWorkerUrl || !dnsWorkerSecret) {
      return NextResponse.json(
        { error: "DNS Worker 未配置" },
        { status: 500 }
      )
    }

    const dnsRes = await fetch(`${dnsWorkerUrl}/provision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${dnsWorkerSecret}`,
      },
      body: JSON.stringify({
        zoneId,
        subdomain: normalizedSubdomain,
        rootDomain,
      }),
    })
    const result = await dnsRes.json() as {
      success: boolean
      domain: string
      mxRecordIds: string[]
      txtRecordId: string | null
      error?: string
    }
    const provisionedRecordIds = getProvisionedDnsRecordIds(result)

    if (!result.success) {
      await bestEffortDeprovisionDns(env, zoneId, provisionedRecordIds, fullDomain)
      return NextResponse.json(
        { error: `DNS 记录创建失败: ${result.error}` },
        { status: 502 }
      )
    }

    // 2. 在 D1 数据库中记录域名信息
    let createdDomainId: string | null = null
    let domainAddedToKv = false

    try {
    const [newDomain] = await db
      .insert(domains)
      .values({
        name: fullDomain,
        subdomain: normalizedSubdomain,
        rootDomain,
        zoneId,
        mxRecordIds: JSON.stringify(result.mxRecordIds),
        txtRecordId: result.txtRecordId,
        status: "active",
        cleanupPolicy: DOMAIN_CLEANUP_POLICIES.MANUAL,
        cleanupAfter: null,
        lastUsedAt: now,
        createdBy: userId,
      })
      .returning()
    createdDomainId = newDomain.id

    // 3. 更新 KV 中的 EMAIL_DOMAINS，追加新域名
    const currentDomains = await env.SITE_CONFIG.get("EMAIL_DOMAINS")
    const domainList = currentDomains
      ? currentDomains.split(",").map((domain) => normalizeDomainName(domain)).filter(Boolean)
      : []

    if (!domainList.includes(fullDomain)) {
      domainList.push(fullDomain)
      domainAddedToKv = true
      await env.SITE_CONFIG.put("EMAIL_DOMAINS", domainList.join(","))
    }

    return NextResponse.json(
      {
        id: newDomain.id,
        domain: fullDomain,
        status: "active",
        mxRecordIds: result.mxRecordIds,
        txtRecordId: result.txtRecordId,
      },
      { status: 201 }
    )
    } catch (postProvisionError) {
      const dnsRolledBack = await bestEffortDeprovisionDns(env, zoneId, provisionedRecordIds, fullDomain)
      let kvRolledBack = !domainAddedToKv

      if (dnsRolledBack && domainAddedToKv) {
        try {
          await removeDomainFromKv(env, fullDomain)
          kvRolledBack = true
        } catch (kvError) {
          console.warn(`Failed to rollback KV domain ${fullDomain}:`, kvError)
        }
      }

      if (createdDomainId) {
        try {
          if (dnsRolledBack && kvRolledBack) {
            await db.delete(domains).where(eq(domains.id, createdDomainId))
          } else {
            await db.update(domains)
              .set({
                status: "cleanup_failed",
                cleanupPolicy: DOMAIN_CLEANUP_POLICIES.AUTO,
                cleanupAfter: new Date(),
              })
              .where(eq(domains.id, createdDomainId))
          }
        } catch (dbError) {
          console.warn(`Failed to rollback domain row ${fullDomain}:`, dbError)
        }
      }

      throw postProvisionError
    }
  } catch (error) {
    console.error("Failed to create subdomain:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "创建子域名失败" },
      { status: 500 }
    )
  }
}
