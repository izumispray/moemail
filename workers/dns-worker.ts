/**
 * DNS Worker - 独立的 Cloudflare Worker，负责调用 Cloudflare DNS API
 *
 * 解决了 Pages Functions 无法调用 api.cloudflare.com 的限制。
 * Pages Function 通过 HTTP 调用此 Worker 来执行 DNS 操作。
 *
 * 认证：请求必须携带 Authorization: Bearer <DNS_WORKER_SECRET> 头
 */

interface Env {
  CLOUDFLARE_API_TOKEN: string
  DNS_WORKER_SECRET: string
}

const CF_API_BASE = "https://api.cloudflare.com/client/v4"

const CF_EMAIL_MX_SERVERS = [
  { content: "route1.mx.cloudflare.net", priority: 86 },
  { content: "route2.mx.cloudflare.net", priority: 4 },
  { content: "route3.mx.cloudflare.net", priority: 24 },
]

const CF_EMAIL_SPF_RECORD = "v=spf1 include:_spf.mx.cloudflare.net ~all"

interface CloudflareApiResponse<T = unknown> {
  success: boolean
  errors: Array<{ code: number; message: string }>
  result: T
}

async function cfFetch<T>(
  path: string,
  apiToken: string,
  options: RequestInit = {}
): Promise<CloudflareApiResponse<T>> {
  const url = `${CF_API_BASE}${path}`
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  })

  const contentType = response.headers.get("content-type") || ""
  if (!contentType.includes("application/json")) {
    const text = await response.text().catch(() => "(unreadable)")
    throw new Error(`CF API non-JSON (${response.status}): ${text.substring(0, 200)}`)
  }

  const data = (await response.json()) as CloudflareApiResponse<T>
  if (!data.success) {
    const errorMsg = data.errors?.map((e) => e.message).join(", ") || "Unknown error"
    throw new Error(`CF API error: ${errorMsg}`)
  }
  return data
}

// ---- Handlers ----

async function handleProvision(body: any, apiToken: string): Promise<Response> {
  const { zoneId, subdomain, rootDomain } = body
  if (!zoneId || !subdomain || !rootDomain) {
    return Response.json({ error: "Missing zoneId, subdomain, or rootDomain" }, { status: 400 })
  }

  const fullDomain = `${subdomain}.${rootDomain}`
  const mxRecordIds: string[] = []
  let txtRecordId: string | null = null

  try {
    // Create MX records
    for (const mx of CF_EMAIL_MX_SERVERS) {
      const data = await cfFetch<{ id: string }>(
        `/zones/${zoneId}/dns_records`,
        apiToken,
        {
          method: "POST",
          body: JSON.stringify({
            type: "MX",
            name: fullDomain,
            content: mx.content,
            priority: mx.priority,
            ttl: 3600,
          }),
        }
      )
      mxRecordIds.push(data.result.id)
    }

    // Create SPF TXT record
    const spfData = await cfFetch<{ id: string }>(
      `/zones/${zoneId}/dns_records`,
      apiToken,
      {
        method: "POST",
        body: JSON.stringify({
          type: "TXT",
          name: fullDomain,
          content: CF_EMAIL_SPF_RECORD,
          ttl: 3600,
        }),
      }
    )
    txtRecordId = spfData.result.id

    return Response.json({
      success: true,
      domain: fullDomain,
      mxRecordIds,
      txtRecordId,
    })
  } catch (error) {
    return Response.json({
      success: false,
      domain: fullDomain,
      mxRecordIds,
      txtRecordId,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 502 })
  }
}

async function handleDeprovision(body: any, apiToken: string): Promise<Response> {
  const { zoneId, recordIds } = body
  if (!zoneId || !recordIds || !Array.isArray(recordIds)) {
    return Response.json({ error: "Missing zoneId or recordIds" }, { status: 400 })
  }

  const results: Array<{ id: string; success: boolean; error?: string }> = []

  for (const recordId of recordIds) {
    try {
      await cfFetch(
        `/zones/${zoneId}/dns_records/${recordId}`,
        apiToken,
        { method: "DELETE" }
      )
      results.push({ id: recordId, success: true })
    } catch (error) {
      results.push({
        id: recordId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const allSuccess = results.every((r) => r.success)
  return Response.json({ success: allSuccess, results })
}

async function handleFindZone(body: any, apiToken: string): Promise<Response> {
  const { domain } = body
  if (!domain) {
    return Response.json({ error: "Missing domain" }, { status: 400 })
  }

  const parts = domain.split(".")
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".")
    try {
      const data = await cfFetch<Array<{ id: string; name: string }>>(
        `/zones?name=${candidate}&status=active`,
        apiToken
      )
      if (Array.isArray(data.result) && data.result.length > 0) {
        return Response.json({ zoneId: data.result[0].id, zoneName: data.result[0].name })
      }
    } catch {
      // Try next level
    }
  }

  return Response.json({ error: `Zone not found for ${domain}` }, { status: 404 })
}

// ---- Main Worker ----

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      })
    }

    // Auth check
    const authHeader = request.headers.get("Authorization")
    const expectedToken = `Bearer ${env.DNS_WORKER_SECRET}`
    if (!authHeader || authHeader !== expectedToken) {
      return Response.json({ error: "Unauthorized" }, { status: 401 })
    }

    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 })
    }

    const url = new URL(request.url)
    const path = url.pathname

    try {
      const body = await request.json()
      const apiToken = env.CLOUDFLARE_API_TOKEN

      if (!apiToken) {
        return Response.json({ error: "CLOUDFLARE_API_TOKEN not configured" }, { status: 500 })
      }

      switch (path) {
        case "/provision":
          return handleProvision(body, apiToken)
        case "/deprovision":
          return handleDeprovision(body, apiToken)
        case "/find-zone":
          return handleFindZone(body, apiToken)
        default:
          return Response.json({ error: "Not found" }, { status: 404 })
      }
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Internal error" },
        { status: 500 }
      )
    }
  },
}
