/**
 * Cloudflare DNS & Email Routing API 工具库
 *
 * 在 Cloudflare Workers/Pages edge 运行时中，
 * 必须使用原生 fetch 调用 REST API，不能使用 Node.js SDK。
 *
 * 参考文档：
 * - DNS Records: https://developers.cloudflare.com/api/resources/dns/subresources/records/
 * - Email Routing: https://developers.cloudflare.com/api/resources/email_routing/
 */

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

// Cloudflare Email Routing 标准 MX 服务器及优先级
const CF_EMAIL_MX_SERVERS = [
  { content: "route1.mx.cloudflare.net", priority: 86 },
  { content: "route2.mx.cloudflare.net", priority: 4 },
  { content: "route3.mx.cloudflare.net", priority: 24 },
];

// Cloudflare Email Routing 标准 SPF 记录
const CF_EMAIL_SPF_RECORD = "v=spf1 include:_spf.mx.cloudflare.net ~all";

// ----- 类型定义 -----

export interface CloudflareApiResponse<T = unknown> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: T;
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  ttl: number;
  proxied?: boolean;
  created_on: string;
  modified_on: string;
}

export interface SubdomainProvisionResult {
  domain: string;
  mxRecordIds: string[];
  txtRecordId: string | null;
  success: boolean;
  error?: string;
}

// ----- 内部工具函数 -----

async function cfFetch<T>(
  path: string,
  apiToken: string,
  options: RequestInit = {}
): Promise<CloudflareApiResponse<T>> {
  const url = `${CF_API_BASE}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const data = (await response.json()) as CloudflareApiResponse<T>;

  if (!data.success) {
    const errorMsg = data.errors?.map((e) => e.message).join(", ") || "Unknown CF API error";
    throw new Error(`Cloudflare API error: ${errorMsg}`);
  }

  return data;
}

// ----- Zone Auto-Detection -----

/**
 * 根据域名自动查找对应的 Cloudflare Zone ID
 *
 * 原理：对域名逐级向上查找，直到匹配到 CF 中注册的 zone。
 * 例如 `sub.example.com` 会依次尝试：
 *   1. sub.example.com
 *   2. example.com
 * 直到找到匹配的 zone。
 *
 * 结果会缓存在内存中避免重复查询。
 */
const zoneIdCache = new Map<string, string>();

export async function findZoneId(
  domain: string,
  apiToken: string
): Promise<string> {
  // 检查缓存
  const cached = zoneIdCache.get(domain);
  if (cached) return cached;

  // 将域名拆分，逐级向上查找
  const parts = domain.split(".");

  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".");

    try {
      const data = await cfFetch<Array<{ id: string; name: string }>>(
        `/zones?name=${candidate}&status=active`,
        apiToken
      );

      if (Array.isArray(data.result) && data.result.length > 0) {
        const zoneId = data.result[0].id;
        // 缓存结果（域名和找到的 zone 名都缓存）
        zoneIdCache.set(domain, zoneId);
        zoneIdCache.set(candidate, zoneId);
        return zoneId;
      }
    } catch {
      // 该候选不匹配，继续尝试上级
    }
  }

  throw new Error(
    `无法找到域名 ${domain} 对应的 Cloudflare Zone。请确认该域名已添加到你的 Cloudflare 账户。`
  );
}

// ----- DNS Records API -----

/**
 * 创建单条 DNS 记录
 */
export async function createDnsRecord(
  zoneId: string,
  apiToken: string,
  record: {
    type: string;
    name: string;
    content: string;
    priority?: number;
    ttl?: number;
    proxied?: boolean;
  }
): Promise<DnsRecord> {
  const data = await cfFetch<DnsRecord>(
    `/zones/${zoneId}/dns/records`,
    apiToken,
    {
      method: "POST",
      body: JSON.stringify({
        type: record.type,
        name: record.name,
        content: record.content,
        priority: record.priority,
        ttl: record.ttl ?? 1, // 1 = auto
        proxied: record.proxied ?? false,
      }),
    }
  );
  return data.result;
}

/**
 * 删除单条 DNS 记录
 */
export async function deleteDnsRecord(
  zoneId: string,
  apiToken: string,
  recordId: string
): Promise<void> {
  await cfFetch(`/zones/${zoneId}/dns/records/${recordId}`, apiToken, {
    method: "DELETE",
  });
}

/**
 * 列出 DNS 记录（支持过滤）
 */
export async function listDnsRecords(
  zoneId: string,
  apiToken: string,
  params?: {
    type?: string;
    name?: string;
    per_page?: number;
  }
): Promise<DnsRecord[]> {
  const searchParams = new URLSearchParams();
  if (params?.type) searchParams.set("type", params.type);
  if (params?.name) searchParams.set("name", params.name);
  if (params?.per_page) searchParams.set("per_page", params.per_page.toString());

  const query = searchParams.toString();
  const path = `/zones/${zoneId}/dns/records${query ? `?${query}` : ""}`;

  const data = await cfFetch<DnsRecord[]>(path, apiToken);
  return data.result;
}

// ----- Email Routing API -----

/**
 * 获取 Email Routing 设置
 */
export async function getEmailRoutingSettings(
  zoneId: string,
  apiToken: string
): Promise<{ enabled: boolean; tag?: string; name?: string }> {
  const data = await cfFetch<{ enabled: boolean; tag?: string; name?: string }>(
    `/zones/${zoneId}/email/routing`,
    apiToken
  );
  return data.result;
}

/**
 * 启用 Email Routing
 */
export async function enableEmailRouting(
  zoneId: string,
  apiToken: string
): Promise<void> {
  await cfFetch(`/zones/${zoneId}/email/routing/enable`, apiToken, {
    method: "POST",
  });
}

/**
 * 获取 Catch-all 规则
 */
export async function getCatchAllRule(
  zoneId: string,
  apiToken: string
): Promise<unknown> {
  const data = await cfFetch(
    `/zones/${zoneId}/email/routing/rules/catch_all`,
    apiToken
  );
  return data.result;
}

/**
 * 设置 Catch-all 规则为转发给 Worker
 */
export async function setCatchAllToWorker(
  zoneId: string,
  apiToken: string,
  workerName: string
): Promise<void> {
  await cfFetch(`/zones/${zoneId}/email/routing/rules/catch_all`, apiToken, {
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
  });
}

// ----- 高级业务函数 -----

/**
 * 为子域名创建全套 Email Routing 所需的 DNS 记录
 *
 * 创建内容：
 * 1. 三条 MX 记录（指向 Cloudflare Email Routing 服务器）
 * 2. 一条 SPF TXT 记录
 *
 * @param zoneId - Cloudflare Zone ID
 * @param apiToken - CF API Token (需要 Zone.DNS 编辑权限)
 * @param subdomain - 子域名前缀（如 "newsletter"）
 * @param rootDomain - 根域名（如 "example.com"）
 * @returns 创建结果，包含所有 DNS 记录 ID
 */
export async function provisionSubdomainEmail(
  zoneId: string,
  apiToken: string,
  subdomain: string,
  rootDomain: string
): Promise<SubdomainProvisionResult> {
  const fullDomain = `${subdomain}.${rootDomain}`;
  const mxRecordIds: string[] = [];
  let txtRecordId: string | null = null;

  try {
    // 1. 检查是否已存在该子域名的 MX 记录
    const existingMx = await listDnsRecords(zoneId, apiToken, {
      type: "MX",
      name: fullDomain,
    });

    if (existingMx.length > 0) {
      // 子域名已有 MX 记录，可能已经配置过
      return {
        domain: fullDomain,
        mxRecordIds: existingMx.map((r) => r.id),
        txtRecordId: null,
        success: true,
        error: "MX records already exist for this subdomain",
      };
    }

    // 2. 创建 MX 记录
    for (const mx of CF_EMAIL_MX_SERVERS) {
      const record = await createDnsRecord(zoneId, apiToken, {
        type: "MX",
        name: fullDomain,
        content: mx.content,
        priority: mx.priority,
      });
      mxRecordIds.push(record.id);
    }

    // 3. 创建 SPF TXT 记录
    // 先检查是否已存在
    const existingTxt = await listDnsRecords(zoneId, apiToken, {
      type: "TXT",
      name: fullDomain,
    });

    const hasSpf = existingTxt.some((r) => r.content.includes("v=spf1"));

    if (!hasSpf) {
      const txtRecord = await createDnsRecord(zoneId, apiToken, {
        type: "TXT",
        name: fullDomain,
        content: CF_EMAIL_SPF_RECORD,
      });
      txtRecordId = txtRecord.id;
    }

    return {
      domain: fullDomain,
      mxRecordIds,
      txtRecordId,
      success: true,
    };
  } catch (error) {
    // 如果部分创建成功需要回滚
    for (const id of mxRecordIds) {
      try {
        await deleteDnsRecord(zoneId, apiToken, id);
      } catch {
        // 忽略回滚错误
      }
    }
    if (txtRecordId) {
      try {
        await deleteDnsRecord(zoneId, apiToken, txtRecordId);
      } catch {
        // 忽略回滚错误
      }
    }

    return {
      domain: fullDomain,
      mxRecordIds: [],
      txtRecordId: null,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * 删除子域名的全部 Email Routing DNS 记录
 *
 * @param zoneId - Cloudflare Zone ID
 * @param apiToken - CF API Token
 * @param recordIds - 要删除的 DNS 记录 ID 列表（MX + TXT）
 */
export async function deprovisionSubdomainEmail(
  zoneId: string,
  apiToken: string,
  recordIds: string[]
): Promise<{ success: boolean; error?: string }> {
  try {
    for (const id of recordIds) {
      await deleteDnsRecord(zoneId, apiToken, id);
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * 验证子域名的 Email Routing 就绪状态
 * 检查 MX 记录是否已正确配置
 */
export async function verifySubdomainReady(
  zoneId: string,
  apiToken: string,
  subdomain: string,
  rootDomain: string
): Promise<{ ready: boolean; mxCount: number; hasSpf: boolean }> {
  const fullDomain = `${subdomain}.${rootDomain}`;

  const [mxRecords, txtRecords] = await Promise.all([
    listDnsRecords(zoneId, apiToken, { type: "MX", name: fullDomain }),
    listDnsRecords(zoneId, apiToken, { type: "TXT", name: fullDomain }),
  ]);

  const hasSpf = txtRecords.some((r) => r.content.includes("v=spf1"));
  const hasCfMx = mxRecords.some((r) =>
    r.content.includes("mx.cloudflare.net")
  );

  return {
    ready: hasCfMx && mxRecords.length >= 3,
    mxCount: mxRecords.length,
    hasSpf,
  };
}
