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
  EMAIL_WORKER_NAME: string
}

const CF_API_BASE = "https://api.cloudflare.com/client/v4"

const CF_EMAIL_MX_SERVERS = [
  { content: "route1.mx.cloudflare.net", priority: 86 },
  { content: "route2.mx.cloudflare.net", priority: 4 },
  { content: "route3.mx.cloudflare.net", priority: 24 },
]

const CF_EMAIL_SPF_RECORD = "v=spf1 include:_spf.mx.cloudflare.net ~all"
const MAX_DNS_LABEL_LENGTH = 63
const MAX_DOMAIN_LENGTH = 253
const MAX_SUBDOMAIN_PREFIX_LEVELS = 5
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const NOT_FOUND_PATTERN = /not\s+found|could\s+not\s+find|does\s+not\s+exist/i

interface CloudflareApiResponse<T = unknown> {
  success: boolean
  errors: Array<{ code: number; message: string }>
  result: T
}

interface DnsDeleteResult {
  id: string
  success: boolean
  error?: string
}

type SubdomainValidationResult =
  | { success: true; value: string; fullDomain: string }
  | { success: false; error: string }

function normalizeDomainName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "")
}

function validateSubdomainPrefix(value: unknown, rootDomain: string): SubdomainValidationResult {
  if (typeof value !== "string") {
    return { success: false, error: "Subdomain prefix must be a string" }
  }

  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return { success: false, error: "Subdomain prefix is required" }
  }

  if (normalized === rootDomain || normalized.endsWith(`.${rootDomain}`)) {
    return {
      success: false,
      error: "Use a relative subdomain prefix only; do not include rootDomain",
    }
  }

  if (normalized.startsWith(".") || normalized.endsWith(".")) {
    return { success: false, error: "Subdomain prefix cannot start or end with a dot" }
  }

  if (normalized.includes("..")) {
    return { success: false, error: "Subdomain prefix cannot contain consecutive dots" }
  }

  const labels = normalized.split(".")
  if (labels.length > MAX_SUBDOMAIN_PREFIX_LEVELS) {
    return {
      success: false,
      error: `Subdomain prefix supports at most ${MAX_SUBDOMAIN_PREFIX_LEVELS} levels`,
    }
  }

  for (const label of labels) {
    if (label.length > MAX_DNS_LABEL_LENGTH || !DNS_LABEL_PATTERN.test(label)) {
      return {
        success: false,
        error: "Each subdomain label must be 1-63 chars, letters, numbers, or hyphens, and cannot start or end with a hyphen",
      }
    }
  }

  const fullDomain = `${normalized}.${rootDomain}`
  if (fullDomain.length > MAX_DOMAIN_LENGTH) {
    return { success: false, error: "Full domain cannot exceed 253 characters" }
  }

  return { success: true, value: normalized, fullDomain }
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

// ---- Email Routing Helpers ----

/**
 * 启用 Zone 的 Email Routing（幂等操作）
 * POST /zones/{zone_id}/email/routing/enable
 */
async function enableEmailRouting(
  zoneId: string,
  apiToken: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await cfFetch(
      `/zones/${zoneId}/email/routing/enable`,
      apiToken,
      { method: "POST", body: JSON.stringify({}) }
    )
    return { success: true }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    // "already enabled" is not a real error
    if (msg.includes("already enabled") || msg.includes("Email Routing is already configured")) {
      return { success: true }
    }
    return { success: false, error: msg }
  }
}

/**
 * 设置 Catch-all 规则将所有邮件路由到 Email Worker
 * PUT /zones/{zone_id}/email/routing/rules/catch_all
 */
async function setCatchAllToWorker(
  zoneId: string,
  apiToken: string,
  workerName: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await cfFetch(
      `/zones/${zoneId}/email/routing/rules/catch_all`,
      apiToken,
      {
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          actions: [
            {
              type: "worker",
              value: [workerName],
            },
          ],
          matchers: [
            {
              type: "all",
            },
          ],
        }),
      }
    )
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function deleteDnsRecords(
  zoneId: string,
  apiToken: string,
  recordIds: string[]
): Promise<DnsDeleteResult[]> {
  const results: DnsDeleteResult[] = []
  const uniqueRecordIds = Array.from(new Set(recordIds.filter(Boolean)))

  for (const recordId of uniqueRecordIds) {
    try {
      await cfFetch(
        `/zones/${zoneId}/dns_records/${recordId}`,
        apiToken,
        { method: "DELETE" }
      )
      results.push({ id: recordId, success: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (NOT_FOUND_PATTERN.test(message)) {
        results.push({ id: recordId, success: true })
        continue
      }

      results.push({
        id: recordId,
        success: false,
        error: message,
      })
    }
  }

  return results
}

// ---- Handlers ----

async function handleProvision(body: any, apiToken: string, emailWorkerName?: string): Promise<Response> {
  const { zoneId, subdomain, rootDomain } = body
  if (typeof zoneId !== "string" || !zoneId.trim() || typeof rootDomain !== "string") {
    return Response.json({ error: "Missing zoneId, subdomain, or rootDomain" }, { status: 400 })
  }

  const normalizedZoneId = zoneId.trim()
  const normalizedRootDomain = normalizeDomainName(rootDomain)
  if (!normalizedRootDomain) {
    return Response.json({ error: "Missing zoneId, subdomain, or rootDomain" }, { status: 400 })
  }

  const subdomainValidation = validateSubdomainPrefix(subdomain, normalizedRootDomain)
  if (!subdomainValidation.success) {
    return Response.json({ error: subdomainValidation.error }, { status: 400 })
  }

  const fullDomain = subdomainValidation.fullDomain
  const mxRecordIds: string[] = []
  let txtRecordId: string | null = null
  let emailRoutingEnabled = false
  let catchAllSet = false

  try {
    // 1. Create MX records
    for (const mx of CF_EMAIL_MX_SERVERS) {
      const data = await cfFetch<{ id: string }>(
        `/zones/${normalizedZoneId}/dns_records`,
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

    // 2. Create SPF TXT record
    const spfData = await cfFetch<{ id: string }>(
      `/zones/${normalizedZoneId}/dns_records`,
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

    // 3. Enable Email Routing on the zone (idempotent)
    const enableResult = await enableEmailRouting(normalizedZoneId, apiToken)
    emailRoutingEnabled = enableResult.success
    if (!enableResult.success) {
      console.warn(`Email Routing enable warning: ${enableResult.error}`)
    }

    // 4. Set catch-all rule to route emails to Email Worker
    if (emailWorkerName) {
      const catchAllResult = await setCatchAllToWorker(normalizedZoneId, apiToken, emailWorkerName)
      catchAllSet = catchAllResult.success
      if (!catchAllResult.success) {
        console.warn(`Catch-all rule warning: ${catchAllResult.error}`)
      }
    } else {
      console.warn("EMAIL_WORKER_NAME not configured, skipping catch-all rule")
    }

    return Response.json({
      success: true,
      domain: fullDomain,
      mxRecordIds,
      txtRecordId,
      emailRoutingEnabled,
      catchAllSet,
    })
  } catch (error) {
    const provisionedRecordIds = [...mxRecordIds, txtRecordId].filter((id): id is string => Boolean(id))
    const rollbackResults = await deleteDnsRecords(normalizedZoneId, apiToken, provisionedRecordIds)
    const rolledBack = rollbackResults.every((result) => result.success)

    return Response.json({
      success: false,
      domain: fullDomain,
      mxRecordIds,
      txtRecordId,
      emailRoutingEnabled,
      catchAllSet,
      rolledBack,
      rollbackResults,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 502 })
  }
}

async function handleDeprovision(body: any, apiToken: string): Promise<Response> {
  const { zoneId, recordIds } = body
  if (typeof zoneId !== "string" || !zoneId.trim() || !recordIds || !Array.isArray(recordIds)) {
    return Response.json({ error: "Missing zoneId or recordIds" }, { status: 400 })
  }
  const normalizedZoneId = zoneId.trim()

  const results = await deleteDnsRecords(normalizedZoneId, apiToken, recordIds)

  const allSuccess = results.every((r) => r.success)
  return Response.json({ success: allSuccess, results })
}

async function handleFindZone(body: any, apiToken: string): Promise<Response> {
  const { domain } = body
  if (typeof domain !== "string") {
    return Response.json({ error: "Missing domain" }, { status: 400 })
  }

  const normalizedDomain = normalizeDomainName(domain)
  if (!normalizedDomain) {
    return Response.json({ error: "Missing domain" }, { status: 400 })
  }

  const parts = normalizedDomain.split(".")
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".")
    try {
      const data = await cfFetch<Array<{ id: string; name: string }>>(
        `/zones?name=${encodeURIComponent(candidate)}&status=active`,
        apiToken
      )
      if (Array.isArray(data.result) && data.result.length > 0) {
        return Response.json({ zoneId: data.result[0].id, zoneName: data.result[0].name })
      }
    } catch {
      // Try next level
    }
  }

  return Response.json({ error: `Zone not found for ${normalizedDomain}` }, { status: 404 })
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
          return handleProvision(body, apiToken, env.EMAIL_WORKER_NAME)
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
