import { NextResponse } from "next/server"
import { createDb } from "@/lib/db"
import { domains } from "@/lib/schema"
import { eq } from "drizzle-orm"
import { getRequestContext } from "@cloudflare/next-on-pages"
import { checkPermission } from "@/lib/auth"
import { PERMISSIONS } from "@/lib/permissions"
import { getUserId } from "@/lib/apiKey"
import {
  provisionSubdomainEmail,
  verifySubdomainReady,
  findZoneId,
} from "@/lib/cloudflare-dns"

export const runtime = "edge"

/**
 * GET /api/domains
 * 获取所有已配置的子域名列表（仅皇帝可访问）
 */
export async function GET() {
  const canAccess = await checkPermission(PERMISSIONS.MANAGE_CONFIG)
  if (!canAccess) {
    return NextResponse.json({ error: "权限不足" }, { status: 403 })
  }

  const db = createDb()
  const env = getRequestContext().env

  const allDomains = await db.query.domains.findMany({
    orderBy: (domains, { desc }) => [desc(domains.createdAt)],
  })

  // 可选：为每个域名检查 DNS 就绪状态
  const domainsWithStatus = await Promise.all(
    allDomains.map(async (domain) => {
      try {
        const status = await verifySubdomainReady(
          domain.zoneId,
          env.CLOUDFLARE_API_TOKEN,
          domain.subdomain,
          domain.rootDomain
        )
        return {
          ...domain,
          dnsReady: status.ready,
          mxCount: status.mxCount,
          hasSpf: status.hasSpf,
        }
      } catch {
        return {
          ...domain,
          dnsReady: false,
          mxCount: 0,
          hasSpf: false,
        }
      }
    })
  )

  return NextResponse.json({ domains: domainsWithStatus })
}

/**
 * POST /api/domains
 * 添加新子域名（自动创建 DNS 记录 + 更新 KV 域名列表）
 *
 * Request body:
 * {
 *   subdomain: string  // 子域名前缀，如 "newsletter"
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
    const { subdomain, domain: rootDomain } = await request.json<{ subdomain: string; domain: string }>()

    // 参数校验
    if (!subdomain || typeof subdomain !== "string") {
      return NextResponse.json({ error: "子域名不能为空" }, { status: 400 })
    }

    if (!rootDomain || typeof rootDomain !== "string") {
      return NextResponse.json({ error: "基础域名不能为空" }, { status: 400 })
    }

    // 验证子域名格式：只允许字母、数字、连字符，不能以连字符开头或结尾
    const subdomainRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i
    if (!subdomainRegex.test(subdomain)) {
      return NextResponse.json(
        { error: "子域名格式不正确，只允许字母、数字和连字符" },
        { status: 400 }
      )
    }

    // 限制子域名长度
    if (subdomain.length > 63) {
      return NextResponse.json(
        { error: "子域名长度不能超过63个字符" },
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

    // 自动检测域名对应的 Zone ID
    const zoneId = await findZoneId(rootDomain, apiToken)

    const fullDomain = `${subdomain.toLowerCase()}.${rootDomain}`

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

    // 1. 调用 Cloudflare DNS API 创建 MX + SPF 记录
    const result = await provisionSubdomainEmail(
      zoneId,
      apiToken,
      subdomain.toLowerCase(),
      rootDomain
    )

    if (!result.success) {
      return NextResponse.json(
        { error: `DNS 记录创建失败: ${result.error}` },
        { status: 502 }
      )
    }

    // 2. 在 D1 数据库中记录域名信息
    const [newDomain] = await db
      .insert(domains)
      .values({
        name: fullDomain,
        subdomain: subdomain.toLowerCase(),
        rootDomain,
        zoneId,
        mxRecordIds: JSON.stringify(result.mxRecordIds),
        txtRecordId: result.txtRecordId,
        status: "active",
        createdBy: userId,
      })
      .returning()

    // 3. 更新 KV 中的 EMAIL_DOMAINS，追加新域名
    const currentDomains = await env.SITE_CONFIG.get("EMAIL_DOMAINS")
    const domainList = currentDomains ? currentDomains.split(",") : []

    if (!domainList.includes(fullDomain)) {
      domainList.push(fullDomain)
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
  } catch (error) {
    console.error("Failed to create subdomain:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "创建子域名失败" },
      { status: 500 }
    )
  }
}
