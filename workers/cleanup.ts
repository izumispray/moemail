interface Env {
  DB: D1Database
  SITE_CONFIG: KVNamespace
  DNS_WORKER_URL?: string
  DNS_WORKER_SECRET?: string
}

interface DomainRow {
  id: string
  name: string
  status: string
  zoneId: string
  mxRecordIds: string | null
  txtRecordId: string | null
}

const CLEANUP_CONFIG = {
  // Whether to delete expired emails
  DELETE_EXPIRED_EMAILS: true,

  // Whether to delete auto-created subdomains after their emails expire
  DELETE_AUTO_DOMAINS: true,

  // Batch processing size
  BATCH_SIZE: 100,
  DOMAIN_BATCH_SIZE: 20,
} as const

const AUTO_DOMAIN_CLEANUP_GRACE_MS = 30 * 60 * 1000
const PERMANENT_EXPIRY_YEAR = 9999

interface ActiveEmailSummary {
  count: number
  latestExpiresAt: number | null
}

interface DnsWorkerResult {
  success?: boolean
  error?: string
  results?: Array<{ id: string; success: boolean; error?: string }>
}

function normalizeDomainName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "")
}

function describeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  return {
    message: String(error),
  }
}

function truncateForLog(value: string, maxLength = 1000): string {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}...`
}

function parseJsonForLog<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function summarizeUrlForLog(value: string) {
  try {
    const url = new URL(value)
    return {
      origin: url.origin,
      pathname: url.pathname,
      hasSearch: url.search.length > 0,
    }
  } catch (error) {
    return {
      origin: "invalid-url",
      pathname: "invalid-url",
      parseError: describeError(error).message,
    }
  }
}

function parseRecordIds(domain: DomainRow): string[] {
  const recordIds: string[] = []

  if (domain.mxRecordIds) {
    try {
      recordIds.push(...(JSON.parse(domain.mxRecordIds) as string[]))
    } catch (error) {
      console.warn("Invalid MX record IDs", {
        domain: domain.name,
        domainId: domain.id,
        error: describeError(error),
      })
    }
  }

  if (domain.txtRecordId) {
    recordIds.push(domain.txtRecordId)
  }

  return recordIds.filter(Boolean)
}

async function setDomainStatus(env: Env, domainId: string, status: string) {
  await env.DB
    .prepare("UPDATE domain SET status = ? WHERE id = ?")
    .bind(status, domainId)
    .run()
}

async function clearDomainRecordIds(env: Env, domainId: string) {
  await env.DB
    .prepare("UPDATE domain SET mx_record_ids = NULL, txt_record_id = NULL WHERE id = ?")
    .bind(domainId)
    .run()
}

function getCleanupAfterFromExpiry(expiresAt: number | null): number | null {
  if (!expiresAt) {
    return null
  }

  if (new Date(expiresAt).getUTCFullYear() >= PERMANENT_EXPIRY_YEAR) {
    return null
  }

  return expiresAt + AUTO_DOMAIN_CLEANUP_GRACE_MS
}

async function setDomainActive(env: Env, domainId: string, cleanupAfter: number | null) {
  await env.DB
    .prepare("UPDATE domain SET status = 'active', cleanup_after = ? WHERE id = ?")
    .bind(cleanupAfter, domainId)
    .run()
}

async function getActiveEmailSummary(env: Env, domainName: string, now: number): Promise<ActiveEmailSummary> {
  const result = await env.DB
    .prepare(`
      SELECT
        COUNT(*) AS count,
        MAX(expires_at) AS latestExpiresAt
      FROM email
      WHERE address LIKE ?
        AND expires_at >= ?
    `)
    .bind(`%@${domainName}`, now)
    .first<{ count: number; latestExpiresAt: number | null }>()

  return {
    count: Number(result?.count ?? 0),
    latestExpiresAt: result?.latestExpiresAt == null ? null : Number(result.latestExpiresAt),
  }
}

async function deleteExpiredEmailsForDomain(env: Env, domainName: string, now: number): Promise<number> {
  const result = await env.DB
    .prepare(`
      DELETE FROM email
      WHERE address LIKE ?
        AND expires_at < ?
    `)
    .bind(`%@${domainName}`, now)
    .run()

  return result.meta?.changes ?? 0
}

async function deprovisionDomainDns(env: Env, domain: DomainRow, recordIds: string[]) {
  if (recordIds.length === 0) {
    return
  }

  if (!env.DNS_WORKER_URL || !env.DNS_WORKER_SECRET) {
    throw new Error("DNS Worker is not configured")
  }

  const requestUrl = `${env.DNS_WORKER_URL}/deprovision`
  const endpoint = summarizeUrlForLog(requestUrl)

  console.log("DNS deprovision request", {
    domain: domain.name,
    domainId: domain.id,
    zoneId: domain.zoneId,
    recordCount: recordIds.length,
    endpoint,
  })

  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DNS_WORKER_SECRET}`,
    },
    body: JSON.stringify({
      zoneId: domain.zoneId,
      recordIds,
    }),
  })

  const responseBody = await response.text().catch((error) => {
    console.error("Failed to read DNS deprovision response body", {
      domain: domain.name,
      domainId: domain.id,
      endpoint,
      error: describeError(error),
    })
    return ""
  })
  const result = parseJsonForLog<DnsWorkerResult>(responseBody)

  if (!response.ok || !result?.success) {
    console.error("DNS deprovision response failed", {
      domain: domain.name,
      domainId: domain.id,
      zoneId: domain.zoneId,
      recordCount: recordIds.length,
      endpoint,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type"),
      cfRay: response.headers.get("cf-ray"),
      responseBody: truncateForLog(responseBody),
      parsedResult: result,
    })
    throw new Error(result?.error || `DNS cleanup failed with status ${response.status}`)
  }

  console.log("DNS deprovision response succeeded", {
    domain: domain.name,
    domainId: domain.id,
    zoneId: domain.zoneId,
    recordCount: recordIds.length,
    endpoint,
    status: response.status,
    cfRay: response.headers.get("cf-ray"),
  })
}

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

async function cleanupAutoDomains(env: Env, now: number) {
  if (!CLEANUP_CONFIG.DELETE_AUTO_DOMAINS) {
    console.log("Auto domain cleanup is disabled")
    return
  }

  const candidates = await env.DB
    .prepare(`
      SELECT
        id,
        name,
        status,
        zone_id AS zoneId,
        mx_record_ids AS mxRecordIds,
        txt_record_id AS txtRecordId
      FROM domain
      WHERE cleanup_policy = 'auto'
        AND cleanup_after IS NOT NULL
        AND cleanup_after <= ?
        AND status IN ('active', 'cleanup_failed', 'cleanup_pending')
      ORDER BY cleanup_after ASC
      LIMIT ?
    `)
    .bind(now, CLEANUP_CONFIG.DOMAIN_BATCH_SIZE)
    .all<DomainRow>()

  const domains = candidates.results ?? []
  let cleaned = 0

  console.log("Auto domain cleanup candidates loaded", {
    count: domains.length,
    limit: CLEANUP_CONFIG.DOMAIN_BATCH_SIZE,
    now: new Date(now).toISOString(),
    firstCandidate: domains[0]
      ? {
          domain: domains[0].name,
          status: domains[0].status,
        }
      : null,
  })

  for (const domain of domains) {
    let dnsCleaned = false
    let recordCount = 0

    try {
      const markResult = await env.DB
        .prepare(`
          UPDATE domain
          SET status = 'cleanup_pending'
          WHERE id = ?
            AND cleanup_policy = 'auto'
            AND status = ?
        `)
        .bind(domain.id, domain.status)
        .run()

      if ((markResult.meta?.changes ?? 0) === 0) {
        continue
      }

      const activeEmails = await getActiveEmailSummary(env, domain.name, now)
      if (activeEmails.count > 0) {
        await setDomainActive(env, domain.id, getCleanupAfterFromExpiry(activeEmails.latestExpiresAt))
        console.log("Skipped auto domain cleanup because active emails remain", {
          domain: domain.name,
          domainId: domain.id,
          activeEmailCount: activeEmails.count,
          latestExpiresAt: activeEmails.latestExpiresAt
            ? new Date(activeEmails.latestExpiresAt).toISOString()
            : null,
        })
        continue
      }

      const recordIds = parseRecordIds(domain)
      recordCount = recordIds.length
      await deprovisionDomainDns(env, domain, recordIds)
      dnsCleaned = true
      await clearDomainRecordIds(env, domain.id)
      await removeDomainFromKv(env, domain.name)
      const deletedEmails = await deleteExpiredEmailsForDomain(env, domain.name, now)

      await env.DB
        .prepare("DELETE FROM domain WHERE id = ?")
        .bind(domain.id)
        .run()

      cleaned += 1
      console.log("Cleaned auto domain", {
        domain: domain.name,
        domainId: domain.id,
        deletedEmails,
        recordCount,
      })
    } catch (error) {
      console.error(`Failed to cleanup auto domain ${domain.name}:`, {
        domain: domain.name,
        domainId: domain.id,
        previousStatus: domain.status,
        recordCount,
        error: describeError(error),
      })
      if (dnsCleaned) {
        try {
          await clearDomainRecordIds(env, domain.id)
        } catch (clearError) {
          console.error(`Failed to clear DNS record IDs for ${domain.name}:`, {
            domain: domain.name,
            domainId: domain.id,
            error: describeError(clearError),
          })
        }
      }
      await setDomainStatus(env, domain.id, "cleanup_failed")
    }
  }

  console.log(`Cleaned ${cleaned} auto domain(s)`)
}

const main = {
  async scheduled(event: ScheduledEvent, env: Env) {
    const now = Date.now()

    try {
      console.log("Cleanup scheduled run started", {
        scheduledTime: new Date(event.scheduledTime).toISOString(),
        now: new Date(now).toISOString(),
        deleteExpiredEmails: CLEANUP_CONFIG.DELETE_EXPIRED_EMAILS,
        deleteAutoDomains: CLEANUP_CONFIG.DELETE_AUTO_DOMAINS,
      })

      if (CLEANUP_CONFIG.DELETE_EXPIRED_EMAILS) {
        const result = await env.DB
          .prepare(`
            DELETE FROM email
            WHERE expires_at < ?
            LIMIT ?
          `)
          .bind(now, CLEANUP_CONFIG.BATCH_SIZE)
          .run()

        if (result.success) {
          console.log(`Deleted ${result?.meta?.changes ?? 0} expired emails and their associated messages`)
        } else {
          console.error("Failed to delete expired emails")
        }
      } else {
        console.log("Expired email deletion is disabled")
      }

      await cleanupAutoDomains(env, now)
      console.log("Cleanup scheduled run completed", {
        scheduledTime: new Date(event.scheduledTime).toISOString(),
        now: new Date(Date.now()).toISOString(),
      })
    } catch (error) {
      console.error("Failed to cleanup:", {
        scheduledTime: new Date(event.scheduledTime).toISOString(),
        error: describeError(error),
      })
      throw error
    }
  }
}

export default main
