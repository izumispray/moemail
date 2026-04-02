import { NextResponse } from "next/server"
import { createDb } from "@/lib/db"
import { domains } from "@/lib/schema"
import { eq } from "drizzle-orm"
import { getRequestContext } from "@cloudflare/next-on-pages"
import { checkPermission } from "@/lib/auth"
import { PERMISSIONS } from "@/lib/permissions"

export const runtime = "edge"

/**
 * DELETE /api/domains/[id]
 * 删除子域名（清理 DNS 记录 + 从 KV 域名列表中移除）
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const canAccess = await checkPermission(PERMISSIONS.MANAGE_CONFIG)
  if (!canAccess) {
    return NextResponse.json({ error: "权限不足" }, { status: 403 })
  }

  const db = createDb()
  const env = getRequestContext().env

  try {
    const { id } = await params

    // 查找域名记录
    const domain = await db.query.domains.findFirst({
      where: eq(domains.id, id),
    })

    if (!domain) {
      return NextResponse.json({ error: "域名不存在" }, { status: 404 })
    }

    // 1. 清理 DNS 记录
    const recordIds: string[] = []

    if (domain.mxRecordIds) {
      try {
        const mxIds = JSON.parse(domain.mxRecordIds) as string[]
        recordIds.push(...mxIds)
      } catch {
        // mxRecordIds 格式异常，跳过
      }
    }

    if (domain.txtRecordId) {
      recordIds.push(domain.txtRecordId)
    }

    if (recordIds.length > 0) {
      const dnsWorkerUrl = env.DNS_WORKER_URL
      const dnsWorkerSecret = env.DNS_WORKER_SECRET
      if (dnsWorkerUrl && dnsWorkerSecret) {
        try {
          const dnsRes = await fetch(`${dnsWorkerUrl}/deprovision`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${dnsWorkerSecret}`,
            },
            body: JSON.stringify({ zoneId: domain.zoneId, recordIds }),
          })
          const dnsResult = await dnsRes.json() as { success: boolean }
          if (!dnsResult.success) {
            console.warn(`DNS cleanup partially failed for ${domain.name}`)
          }
        } catch {
          console.warn(`DNS cleanup via worker failed for ${domain.name}`)
        }
      }
    }

    // 2. 从 KV 的 EMAIL_DOMAINS 中移除该域名
    const currentDomains = await env.SITE_CONFIG.get("EMAIL_DOMAINS")
    if (currentDomains) {
      const domainList = currentDomains
        .split(",")
        .filter((d) => d !== domain.name)
      await env.SITE_CONFIG.put("EMAIL_DOMAINS", domainList.join(","))
    }

    // 3. 删除数据库记录
    await db.delete(domains).where(eq(domains.id, id))

    return NextResponse.json({
      success: true,
      message: `子域名 ${domain.name} 已删除`,
    })
  } catch (error) {
    console.error("Failed to delete subdomain:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "删除子域名失败" },
      { status: 500 }
    )
  }
}

/**
 * GET /api/domains/[id]
 * 获取单个域名的详细信息及 DNS 状态
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const canAccess = await checkPermission(PERMISSIONS.MANAGE_CONFIG)
  if (!canAccess) {
    return NextResponse.json({ error: "权限不足" }, { status: 403 })
  }

  const db = createDb()
  const { id } = await params

  const domain = await db.query.domains.findFirst({
    where: eq(domains.id, id),
  })

  if (!domain) {
    return NextResponse.json({ error: "域名不存在" }, { status: 404 })
  }

  return NextResponse.json({ domain })
}
