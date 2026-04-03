import { NextResponse } from "next/server"
import { getRequestContext } from "@cloudflare/next-on-pages"
import { checkPermission } from "@/lib/auth"
import { PERMISSIONS } from "@/lib/permissions"

export const runtime = "edge"

/**
 * POST /api/domains/find-zone
 * 通过 DNS Worker 自动查询域名的 Zone ID
 *
 * Request body:
 * { domain: string }
 *
 * Response:
 * { zoneId: string, zoneName: string }
 */
export async function POST(request: Request) {
  const canAccess = await checkPermission(PERMISSIONS.MANAGE_CONFIG)
  if (!canAccess) {
    return NextResponse.json({ error: "权限不足" }, { status: 403 })
  }

  const env = getRequestContext().env

  const dnsWorkerUrl = env.DNS_WORKER_URL
  const dnsWorkerSecret = env.DNS_WORKER_SECRET
  if (!dnsWorkerUrl || !dnsWorkerSecret) {
    return NextResponse.json(
      { error: "DNS Worker 未配置，请设置 DNS_WORKER_URL 和 DNS_WORKER_SECRET 环境变量" },
      { status: 500 }
    )
  }

  try {
    const { domain } = await request.json<{ domain: string }>()

    if (!domain || typeof domain !== "string") {
      return NextResponse.json({ error: "缺少 domain 参数" }, { status: 400 })
    }

    const res = await fetch(`${dnsWorkerUrl}/find-zone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${dnsWorkerSecret}`,
      },
      body: JSON.stringify({ domain }),
    })

    const data = await res.json() as { zoneId?: string; zoneName?: string; error?: string }

    if (!res.ok) {
      return NextResponse.json(
        { error: data.error || `Zone ID 查询失败 (${res.status})` },
        { status: res.status }
      )
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error("Failed to find zone:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "查询 Zone ID 失败" },
      { status: 500 }
    )
  }
}
