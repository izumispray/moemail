import { afterEach, describe, expect, mock, test } from "bun:test"
import NextAuth from "next-auth"
import GitHub from "next-auth/providers/github"
import { NextRequest } from "next/server"

const origin = "https://auth.example.test"
const githubIssuer = "https://github.com/login/oauth"
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

async function startSignIn() {
  const errors: Error[] = []
  const cookies = new Map<string, string>()
  const { handlers } = NextAuth(() => ({
    secret: "github-callback-regression-test-secret",
    trustHost: true,
    session: { strategy: "jwt" },
    providers: [GitHub({ clientId: "test-client", clientSecret: "test-secret" })],
    logger: { error: (error) => errors.push(error) },
  }))

  async function request(path: string, init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = {}) {
    const headers = new Headers(init.headers)
    headers.set("cookie", Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; "))
    const handler = init.method === "POST" ? handlers.POST : handlers.GET
    const response = await handler(new NextRequest(`${origin}${path}`, { ...init, headers }))

    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]
      const separator = pair.indexOf("=")
      const name = pair.slice(0, separator)
      const value = pair.slice(separator + 1)
      if (value) cookies.set(name, value)
      else cookies.delete(name)
    }
    return response
  }

  const csrfResponse = await request("/api/auth/csrf")
  const { csrfToken } = await csrfResponse.json() as { csrfToken: string }
  const signInResponse = await request("/api/auth/signin/github", {
    method: "POST",
    body: new URLSearchParams({ csrfToken, callbackUrl: `${origin}/signed-in` }),
  })
  expect(signInResponse.status).toBe(302)
  const authorizationUrl = new URL(signInResponse.headers.get("location")!)
  expect(authorizationUrl.origin).toBe("https://github.com")
  expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256")

  return { request, cookies, errors, authorizationUrl }
}

function mockGitHub(authorizationUrl: URL) {
  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === `${githubIssuer}/access_token`) {
      const body = new URLSearchParams(init?.body as string)
      expect(body.get("code")).toBe("synthetic-authorization-code")
      expect(body.get("redirect_uri")).toBe(`${origin}/api/auth/callback/github`)
      const verifier = body.get("code_verifier")
      expect(verifier).toBeTruthy()
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier!))
      expect(Buffer.from(digest).toString("base64url"))
        .toBe(authorizationUrl.searchParams.get("code_challenge")!)
      return Response.json({
        access_token: "synthetic-access-token",
        token_type: "bearer",
        scope: "read:user user:email",
      })
    }
    if (url === "https://api.github.com/user") {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-access-token")
      return Response.json({
        id: 123,
        login: "test-user",
        name: "Test User",
        email: "test-user@example.test",
        avatar_url: "https://avatars.githubusercontent.com/u/123",
      })
    }
    throw new Error(`Unexpected OAuth request: ${url}`)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

function callbackPath(issuer: string) {
  const params = new URLSearchParams({ code: "synthetic-authorization-code", iss: issuer })
  return `/api/auth/callback/github?${params}`
}

describe("GitHub OAuth callback", () => {
  test("accepts GitHub's issuer, exchanges the PKCE code and creates a readable session", async () => {
    const flow = await startSignIn()
    const fetchMock = mockGitHub(flow.authorizationUrl)
    const response = await flow.request(callbackPath(githubIssuer))

    expect(flow.errors).toEqual([])
    expect(response.headers.get("location")).toBe(`${origin}/signed-in`)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(flow.cookies.has("__Secure-authjs.session-token")).toBe(true)

    const session = await flow.request("/api/auth/session")
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({
      user: { name: "Test User", email: "test-user@example.test" },
    })
    expect(flow.errors).toEqual([])
  })

  test("rejects an unexpected issuer before exchanging the code", async () => {
    const flow = await startSignIn()
    const fetchMock = mockGitHub(flow.authorizationUrl)
    const response = await flow.request(callbackPath("https://untrusted.example.test"))

    expect(response.headers.get("location")).toBe(`${origin}/api/auth/error?error=Configuration`)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(flow.cookies.has("__Secure-authjs.session-token")).toBe(false)
    expect(flow.errors).toHaveLength(1)
  })

  test("still requires the PKCE cookie when the issuer is correct", async () => {
    const flow = await startSignIn()
    const fetchMock = mockGitHub(flow.authorizationUrl)
    flow.cookies.delete("__Secure-authjs.pkce.code_verifier")
    const response = await flow.request(callbackPath(githubIssuer))

    expect(response.headers.get("location")).toBe(`${origin}/api/auth/error?error=Configuration`)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(flow.cookies.has("__Secure-authjs.session-token")).toBe(false)
    expect(flow.errors).toHaveLength(1)
  })
})
