import { NextResponse } from "next/server"
import { nanoid } from "nanoid"
import { createDb } from "@/lib/db"
import { emails, domains } from "@/lib/schema"
import { eq, and, sql } from "drizzle-orm"
import { getRequestContext } from "@cloudflare/next-on-pages"
import { getUserId } from "@/lib/apiKey"
import { getUserRole } from "@/lib/auth"
import { ROLES } from "@/lib/permissions"
import { buildFullDomain, normalizeDomainName, validateSubdomainPrefix } from "@/lib/domain-utils"
import { DOMAIN_CLEANUP_POLICIES, getCleanupAfter, isDomainCleanupPolicy } from "@/lib/domain-cleanup"
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
 * POST /api/emails/subdomain
 *
 * 一键式子域名邮箱创建 API（自动化专用）
 *
 * 流程：
 * 1. 生成随机子域名前缀（如 "k3x9"）
 * 2. 调用 Cloudflare DNS API 创建该子域名的 MX + SPF 记录
 * 3. 将新域名加入 KV 的 EMAIL_DOMAINS
 * 4. 在 D1 中创建 domain 记录
 * 5. 在 D1 中创建 email 记录
 * 6. 返回完整的邮箱地址
 *
 * Request body:
 * {
 *   prefix?: string   // 可选，子域名前缀，支持多级（不传则随机生成）
 *   name?: string     // 可选，邮箱名（不传则随机生成）
 *   domain: string    // 必填，根域名
 *   cleanupPolicy?: "auto" | "manual" // 可选，默认 auto
 * }
 *
 * Response:
 * {
 *   email: "abc123@k3x9.example.com",
 *   subdomain: "k3x9.example.com",
 *   domainId: "uuid",
 *   emailId: "uuid"
 * }
 */
export async function POST(request: Request) {
  try {
  const userId = await getUserId()
  if (!userId) {
    return NextResponse.json({ error: "未登录或 API Key 无效" }, { status: 401 })
  }

  const userRole = await getUserRole(userId)
  if (userRole !== ROLES.EMPEROR) {
    return NextResponse.json({ error: "仅皇帝可使用此 API" }, { status: 403 })
  }

  const db = createDb()
  const env = getRequestContext().env

  try {
    const body = await request.json() as {
      prefix?: string
      name?: string
      domain: string
      expiryTime?: number  // 过期时间（毫秒），0 或不传 = 永不过期
      cleanupPolicy?: string
    }

    if (body.cleanupPolicy !== undefined && !isDomainCleanupPolicy(body.cleanupPolicy)) {
      return NextResponse.json(
        { error: "cleanupPolicy 只能是 auto 或 manual" },
        { status: 400 }
      )
    }
    const cleanupPolicy = body.cleanupPolicy ?? DOMAIN_CLEANUP_POLICIES.AUTO

    const rootDomain = typeof body.domain === "string" ? normalizeDomainName(body.domain) : ""
    if (!rootDomain) {
      return NextResponse.json(
        { error: "缺少基础域名参数 domain" },
        { status: 400 }
      )
    }

    // 验证 domain 是否在 EMAIL_DOMAINS 列表中
    const domainString = await env.SITE_CONFIG.get("EMAIL_DOMAINS")
    const allowedDomains = domainString
      ? domainString.split(",").map((domain) => normalizeDomainName(domain)).filter(Boolean)
      : []
    if (!allowedDomains.includes(rootDomain)) {
      return NextResponse.json(
        { error: `域名 ${rootDomain} 不在允许列表中，请先在前端配置中添加` },
        { status: 400 }
      )
    }

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


    if (body.prefix !== undefined && typeof body.prefix !== "string") {
      return NextResponse.json({ error: "子域名前缀必须是字符串" }, { status: 400 })
    }

    // 生成或使用指定的子域名前缀
    const subdomainPrefix = body.prefix || nanoid(6)

    const subdomainValidation = validateSubdomainPrefix(subdomainPrefix, rootDomain)
    if (!subdomainValidation.success) {
      return NextResponse.json({ error: subdomainValidation.error }, { status: 400 })
    }
    const normalizedSubdomainPrefix = subdomainValidation.value

    const fullDomain = buildFullDomain(normalizedSubdomainPrefix, rootDomain)

    // 检查子域名是否已存在
    const existingDomain = await db.query.domains.findFirst({
      where: eq(domains.name, fullDomain),
    })

    if (existingDomain) {
      return NextResponse.json(
        { error: `子域名 ${fullDomain} 已存在` },
        { status: 409 }
      )
    }

    const emailName = body.name || nanoid(8)
    const address = `${emailName}@${fullDomain}`

    // 确认邮箱地址未被占用，再创建 DNS 和域名记录，避免冲突时留下孤立子域名。
    const existingEmail = await db.query.emails.findFirst({
      where: eq(sql`LOWER(${emails.address})`, address.toLowerCase()),
    })

    if (existingEmail) {
      if (existingEmail.expiresAt < new Date()) {
        await db.delete(emails).where(eq(emails.id, existingEmail.id))
      } else {
        return NextResponse.json(
          { error: `邮箱地址 ${address} 已被使用` },
          { status: 409 }
        )
      }
    }

    // 1. 通过 DNS Worker 创建 MX + SPF 记录
    const dnsWorkerUrl = env.DNS_WORKER_URL
    const dnsWorkerSecret = env.DNS_WORKER_SECRET
    if (!dnsWorkerUrl || !dnsWorkerSecret) {
      return NextResponse.json(
        { error: "DNS Worker 未配置，请设置 DNS_WORKER_URL 和 DNS_WORKER_SECRET" },
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
        subdomain: normalizedSubdomainPrefix,
        rootDomain,
      }),
    })
    const dnsResult = await dnsRes.json() as {
      success: boolean
      domain: string
      mxRecordIds: string[]
      txtRecordId: string | null
      error?: string
    }
    const provisionedRecordIds = getProvisionedDnsRecordIds(dnsResult)

    if (!dnsResult.success) {
      await bestEffortDeprovisionDns(env, zoneId, provisionedRecordIds, fullDomain)
      return NextResponse.json(
        { error: `DNS 记录创建失败: ${dnsResult.error}` },
        { status: 502 }
      )
    }

    let createdDomainId: string | null = null
    let domainAddedToKv = false

    try {
    const now = new Date()
    const expiresAt = body.expiryTime && body.expiryTime > 0
      ? new Date(now.getTime() + body.expiryTime)
      : new Date("9999-01-01T00:00:00.000Z")
    const cleanupAfter = getCleanupAfter(cleanupPolicy, expiresAt)

    // 2. D1：保存 domain 记录
    const [newDomain] = await db
      .insert(domains)
      .values({
        name: fullDomain,
        subdomain: normalizedSubdomainPrefix,
        rootDomain,
        zoneId,
        mxRecordIds: JSON.stringify(dnsResult.mxRecordIds),
        txtRecordId: dnsResult.txtRecordId,
        status: "active",
        cleanupPolicy,
        cleanupAfter,
        lastUsedAt: now,
        createdBy: userId,
      })
      .returning()
    createdDomainId = newDomain.id


    // 3. 更新 KV 中的 EMAIL_DOMAINS，追加子域名
    const currentDomains = await env.SITE_CONFIG.get("EMAIL_DOMAINS")
    const domainList = currentDomains
      ? currentDomains.split(",").map((domain) => normalizeDomainName(domain)).filter(Boolean)
      : []
    if (!domainList.includes(fullDomain)) {
      domainList.push(fullDomain)
      domainAddedToKv = true
      await env.SITE_CONFIG.put("EMAIL_DOMAINS", domainList.join(","))
    }

    const [newEmail] = await db
      .insert(emails)
      .values({
        address,
        userId,
        createdAt: now,
        expiresAt,
      })
      .returning({ id: emails.id, address: emails.address })

    return NextResponse.json(
      {
        email: newEmail.address,
        emailId: newEmail.id,
        subdomain: fullDomain,
        domainId: newDomain.id,
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
    console.error("Failed to create subdomain email:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "创建子域名邮箱失败" },
      { status: 500 }
    )
  }
  } catch (outerError) {
    console.error("FATAL POST handler error:", outerError)
    return NextResponse.json(
      { error: "Internal crash: " + (outerError instanceof Error ? outerError.message : String(outerError)) },
      { status: 500 }
    )
  }
}

/**
 * GET /api/emails/subdomain
 *
 * 列出所有子域名邮箱（按子域名分组）
 */
export async function GET(request: Request) {
  const userId = await getUserId()
  if (!userId) {
    return NextResponse.json({ error: "未登录或 API Key 无效" }, { status: 401 })
  }

  const userRole = await getUserRole(userId)
  if (userRole !== ROLES.EMPEROR) {
    return NextResponse.json({ error: "仅皇帝可使用此 API" }, { status: 403 })
  }

  const db = createDb()

  const { searchParams } = new URL(request.url)
  const rawRootDomainFilter = searchParams.get("rootDomain")
  const rootDomainFilter = rawRootDomainFilter ? normalizeDomainName(rawRootDomainFilter) : ""

  // 获取子域名（支持按根域名筛选）
  const domainConditions = [eq(domains.status, "active")]
  if (rootDomainFilter) {
    domainConditions.push(eq(domains.rootDomain, rootDomainFilter))
  }

  const allDomains = await db.query.domains.findMany({
    where: and(...domainConditions),
    orderBy: (domains, { desc }) => [desc(domains.createdAt)],
  })

  // 获取所有子域名邮箱
  const subdomainEmails = []
  for (const domain of allDomains) {
    const domainEmails = await db.query.emails.findMany({
      where: and(
        sql`${emails.address} LIKE ${'%@' + domain.name}`,
        eq(emails.userId, userId)
      ),
    })

    subdomainEmails.push({
      domain: domain.name,
      domainId: domain.id,
      subdomain: domain.subdomain,
      rootDomain: domain.rootDomain,
      createdAt: domain.createdAt,
      emails: domainEmails.map((e) => ({
        id: e.id,
        address: e.address,
        createdAt: e.createdAt,
        expiresAt: e.expiresAt,
      })),
    })
  }

  return NextResponse.json({ subdomainEmails })
}

/**
 * DELETE /api/emails/subdomain
 *
 * 删除整个子域名及其所有邮箱
 *
 * Request body:
 * {
 *   domainId: string  // 要删除的子域名 ID
 * }
 */
export async function DELETE(request: Request) {
  const userId = await getUserId()
  if (!userId) {
    return NextResponse.json({ error: "未登录或 API Key 无效" }, { status: 401 })
  }

  const userRole = await getUserRole(userId)
  if (userRole !== ROLES.EMPEROR) {
    return NextResponse.json({ error: "仅皇帝可使用此 API" }, { status: 403 })
  }

  const db = createDb()
  const env = getRequestContext().env

  try {
    const { domainId } = await request.json() as { domainId: string }

    if (!domainId) {
      return NextResponse.json({ error: "缺少 domainId 参数" }, { status: 400 })
    }

    // 查找域名
    const domain = await db.query.domains.findFirst({
      where: eq(domains.id, domainId),
    })

    if (!domain) {
      return NextResponse.json({ error: "子域名不存在" }, { status: 404 })
    }

    // 1. 删除该域名下的所有邮箱
    const domainEmails = await db.query.emails.findMany({
      where: sql`${emails.address} LIKE ${'%@' + domain.name}`,
    })

    for (const email of domainEmails) {
      await db.delete(emails).where(eq(emails.id, email.id))
    }

    // 2. 清理 DNS 记录
    const recordIds: string[] = []
    if (domain.mxRecordIds) {
      try {
        recordIds.push(...(JSON.parse(domain.mxRecordIds) as string[]))
      } catch { /* ignore */ }
    }
    if (domain.txtRecordId) {
      recordIds.push(domain.txtRecordId)
    }

    if (recordIds.length > 0) {
      const dnsWorkerUrl = env.DNS_WORKER_URL
      const dnsWorkerSecret = env.DNS_WORKER_SECRET
      if (dnsWorkerUrl && dnsWorkerSecret) {
        try {
          await fetch(`${dnsWorkerUrl}/deprovision`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${dnsWorkerSecret}`,
            },
            body: JSON.stringify({ zoneId: domain.zoneId, recordIds }),
          })
        } catch {
          // DNS cleanup failure is non-fatal
          console.warn("DNS cleanup via worker failed")
        }
      }
    }

    // 3. 从 KV 移除域名
    const currentDomains = await env.SITE_CONFIG.get("EMAIL_DOMAINS")
    if (currentDomains) {
      const normalizedDomainName = normalizeDomainName(domain.name)
      const domainList = currentDomains
        .split(",")
        .map((d) => normalizeDomainName(d))
        .filter((d) => d && d !== normalizedDomainName)
      await env.SITE_CONFIG.put("EMAIL_DOMAINS", domainList.join(","))
    }

    // 4. 删除域名记录
    await db.delete(domains).where(eq(domains.id, domainId))

    return NextResponse.json({
      success: true,
      message: `子域名 ${domain.name} 及其 ${domainEmails.length} 个邮箱已删除`,
      deletedEmails: domainEmails.length,
    })
  } catch (error) {
    console.error("Failed to delete subdomain:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "删除子域名邮箱失败" },
      { status: 500 }
    )
  }
}
