import { afterEach, describe, expect, mock, test } from "bun:test"
import dnsWorker from "./dns-worker"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("DNS worker deprovision fallback", () => {
  test("finds and deletes provisioned email records when stored IDs are missing", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)

      if (url.includes("/dns_records?name=temp.example.com")) {
        return Response.json({
          success: true,
          errors: [],
          result: [
            {
              id: "mx-record",
              type: "MX",
              name: "temp.example.com",
              content: "route1.mx.cloudflare.net",
            },
            {
              id: "txt-record",
              type: "TXT",
              name: "temp.example.com",
              content: "v=spf1 include:_spf.mx.cloudflare.net ~all",
            },
            {
              id: "unrelated-record",
              type: "TXT",
              name: "temp.example.com",
              content: "unrelated",
            },
          ],
        })
      }

      if (init?.method === "DELETE") {
        return Response.json({ success: true, errors: [], result: {} })
      }

      throw new Error(`Unexpected Cloudflare request: ${url}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await dnsWorker.fetch(
      new Request("https://dns-worker.example/deprovision", {
        method: "POST",
        headers: {
          Authorization: "Bearer worker-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          zoneId: "zone-id",
          recordIds: [],
          domain: "temp.example.com",
        }),
      }),
      {
        CLOUDFLARE_API_TOKEN: "cloudflare-token",
        DNS_WORKER_SECRET: "worker-secret",
        EMAIL_WORKER_NAME: "email-worker",
      }
    )
    const result = await response.json() as {
      success: boolean
      fallbackRecordIds: string[]
    }

    expect(response.status).toBe(200)
    expect(result.success).toBe(true)
    expect(result.fallbackRecordIds).toEqual(["mx-record", "txt-record"])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
