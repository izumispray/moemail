interface ProvisionedDnsRecords {
  mxRecordIds?: string[] | null
  txtRecordId?: string | null
}

interface DnsWorkerEnv {
  DNS_WORKER_URL?: string
  DNS_WORKER_SECRET?: string
}

export function getProvisionedDnsRecordIds(records: ProvisionedDnsRecords): string[] {
  return [
    ...(Array.isArray(records.mxRecordIds) ? records.mxRecordIds : []),
    records.txtRecordId,
  ].filter((id): id is string => typeof id === "string" && id.length > 0)
}

export async function bestEffortDeprovisionDns(
  env: DnsWorkerEnv,
  zoneId: string,
  recordIds: string[],
  context: string
): Promise<boolean> {
  const uniqueRecordIds = Array.from(new Set(recordIds.filter(Boolean)))
  if (uniqueRecordIds.length === 0) {
    return true
  }

  if (!env.DNS_WORKER_URL || !env.DNS_WORKER_SECRET) {
    console.warn(`Skipping DNS rollback for ${context}: DNS Worker is not configured`)
    return false
  }

  try {
    const response = await fetch(`${env.DNS_WORKER_URL}/deprovision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.DNS_WORKER_SECRET}`,
      },
      body: JSON.stringify({ zoneId, recordIds: uniqueRecordIds }),
    })

    const result = await response.json().catch(() => null) as { success?: boolean; error?: string } | null
    if (!response.ok || !result?.success) {
      console.warn(`DNS rollback failed for ${context}: ${result?.error || response.status}`)
      return false
    }
    return true
  } catch (error) {
    console.warn(`DNS rollback failed for ${context}:`, error)
    return false
  }
}
