import { NextResponse } from "next/server"
import { nanoid } from "nanoid"
import { createDb } from "@/lib/db"
import { emails, domains } from "@/lib/schema"
import { eq, and, gt, sql } from "drizzle-orm"
import { EXPIRY_OPTIONS } from "@/types/email"
import { EMAIL_CONFIG } from "@/config"
import { getRequestContext } from "@cloudflare/next-on-pages"
import { getUserId } from "@/lib/apiKey"
import { getUserRole } from "@/lib/auth"
import { ROLES } from "@/lib/permissions"
import { normalizeDomainName } from "@/lib/domain-utils"
import { DOMAIN_CLEANUP_POLICIES, getCleanupAfter } from "@/lib/domain-cleanup"
import { validateEmailLocalPart } from "@/lib/email-address"

export const runtime = "edge"

export async function POST(request: Request) {
  const db = createDb()
  const env = getRequestContext().env

  const userId = await getUserId()
  const userRole = await getUserRole(userId!)

  try {
    if (userRole !== ROLES.EMPEROR) {
      const maxEmails = await env.SITE_CONFIG.get("MAX_EMAILS") || EMAIL_CONFIG.MAX_ACTIVE_EMAILS.toString()
      const activeEmailsCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(emails)
        .where(
          and(
            eq(emails.userId, userId!),
            gt(emails.expiresAt, new Date())
          )
        )
      
      if (Number(activeEmailsCount[0].count) >= Number(maxEmails)) {
        return NextResponse.json(
          { error: `已达到最大邮箱数量限制 (${maxEmails})` },
          { status: 403 }
        )
      }
    }

    const { name, expiryTime, domain } = await request.json<{ 
      name: string
      expiryTime: number
      domain: string
    }>()
    const normalizedDomain = typeof domain === "string" ? normalizeDomainName(domain) : ""

    if (!EXPIRY_OPTIONS.some(option => option.value === expiryTime)) {
      return NextResponse.json(
        { error: "无效的过期时间" },
        { status: 400 }
      )
    }

    const domainString = await env.SITE_CONFIG.get("EMAIL_DOMAINS")
    const allowedDomains = domainString
      ? domainString.split(",").map((domain) => normalizeDomainName(domain)).filter(Boolean)
      : ["moemail.app"]

    if (!allowedDomains.includes(normalizedDomain)) {
      return NextResponse.json(
        { error: "无效的域名" },
        { status: 400 }
      )
    }

    const domainRecord = await db.query.domains.findFirst({
      where: eq(domains.name, normalizedDomain),
    })

    if (domainRecord && domainRecord.status !== "active") {
      return NextResponse.json(
        { error: "该域名正在清理中或不可用" },
        { status: 409 }
      )
    }

    const localPart = name || nanoid(8)
    const localPartValidation = validateEmailLocalPart(localPart)
    if (!localPartValidation.success) {
      return NextResponse.json(
        { error: "无效的邮箱前缀", code: localPartValidation.error },
        { status: 400 }
      )
    }

    const address = `${localPartValidation.value}@${normalizedDomain}`
    if (address.length > 254) {
      return NextResponse.json(
        { error: "邮箱地址长度不能超过 254 个字符", code: "addressTooLong" },
        { status: 400 }
      )
    }
    const existingEmail = await db.query.emails.findFirst({
      where: eq(sql`LOWER(${emails.address})`, address.toLowerCase())
    })

    if (existingEmail) {
      // 如果邮箱已过期，先删除旧记录再允许重新创建
      if (existingEmail.expiresAt < new Date()) {
        await db.delete(emails).where(eq(emails.id, existingEmail.id))
      } else {
        return NextResponse.json(
          { error: "该邮箱地址已被使用" },
          { status: 409 }
        )
      }
    }

    const now = new Date()
    const expires = expiryTime === 0 
      ? new Date('9999-01-01T00:00:00.000Z')
      : new Date(now.getTime() + expiryTime)
    
    const emailData: typeof emails.$inferInsert = {
      address,
      createdAt: now,
      expiresAt: expires,
      userId: userId!
    }
    
    const result = await db.insert(emails)
      .values(emailData)
      .returning({ id: emails.id, address: emails.address })

    if (domainRecord) {
      const cleanupAfter = domainRecord.cleanupPolicy === DOMAIN_CLEANUP_POLICIES.AUTO
        ? getCleanupAfter(domainRecord.cleanupPolicy, expires)
        : null
      const nextCleanupAfter = cleanupAfter && domainRecord.cleanupAfter && domainRecord.cleanupAfter > cleanupAfter
        ? domainRecord.cleanupAfter
        : cleanupAfter

      const updatedDomains = await db
        .update(domains)
        .set({
          lastUsedAt: now,
          cleanupAfter: nextCleanupAfter,
        })
        .where(and(eq(domains.id, domainRecord.id), eq(domains.status, "active")))
        .returning({ id: domains.id })

      if (updatedDomains.length === 0) {
        await db.delete(emails).where(eq(emails.id, result[0].id))
        return NextResponse.json(
          { error: "该域名正在清理中或不可用" },
          { status: 409 }
        )
      }
    }
    
    return NextResponse.json({
      id: result[0].id,
      email: result[0].address
    })
  } catch (error) {
    console.error('Failed to generate email:', error)
    return NextResponse.json(
      { error: "创建邮箱失败" },
      { status: 500 }
    )
  }
}
