import { NextResponse } from "next/server"
import { and, eq, gt, lt, lte, sql } from "drizzle-orm"
import { createDb } from "@/lib/db"
import { domains, emails } from "@/lib/schema"
import { getUserId } from "@/lib/apiKey"
import {
  PERMANENT_EXPIRY_MS,
  isPermanentExpiry,
  resolveEmailRenewal,
} from "@/lib/email-expiry"
import {
  AUTO_DOMAIN_CLEANUP_GRACE_MS,
  DOMAIN_CLEANUP_POLICIES,
} from "@/lib/domain-cleanup"

export const runtime = "edge"

function conflictResponse(code: "emailExpired" | "emailPermanent") {
  return NextResponse.json(
    {
      error: code === "emailExpired" ? "邮箱已过期，无法续约" : "永久邮箱无需续约",
      code,
    },
    { status: 409 }
  )
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getUserId()
  if (!userId) {
    return NextResponse.json({ error: "未登录或 API Key 无效" }, { status: 401 })
  }

  let body: { expiryTime?: unknown }
  try {
    body = await request.json() as { expiryTime?: unknown }
  } catch {
    return NextResponse.json(
      { error: "请求体必须是有效的 JSON", code: "invalidRequest" },
      { status: 400 }
    )
  }

  const db = createDb()
  const { id } = await params
  const currentEmail = await db.query.emails.findFirst({
    where: and(eq(emails.id, id), eq(emails.userId, userId)),
  })

  if (!currentEmail) {
    return NextResponse.json({ error: "邮箱不存在" }, { status: 404 })
  }

  const now = new Date()
  const expiry = resolveEmailRenewal(currentEmail.expiresAt, body.expiryTime, now)
  if (!expiry.success) {
    if (expiry.code === "emailExpired" || expiry.code === "emailPermanent") {
      return conflictResponse(expiry.code)
    }
    return NextResponse.json(
      { error: expiry.error, code: expiry.code },
      { status: 400 }
    )
  }

  const permanentDate = new Date(PERMANENT_EXPIRY_MS)
  const conditions = [
    eq(emails.id, id),
    eq(emails.userId, userId),
    gt(emails.expiresAt, now),
    lt(emails.expiresAt, permanentDate),
  ]

  if (!expiry.permanent) {
    conditions.push(
      lte(emails.expiresAt, new Date(PERMANENT_EXPIRY_MS - expiry.expiryTime))
    )
  }

  const [renewedEmail] = await db
    .update(emails)
    .set({
      expiresAt: expiry.permanent
        ? permanentDate
        : sql`${emails.expiresAt} + ${expiry.expiryTime}`,
    })
    .where(and(...conditions))
    .returning({
      id: emails.id,
      address: emails.address,
      expiresAt: emails.expiresAt,
    })

  if (!renewedEmail) {
    const latestEmail = await db.query.emails.findFirst({
      where: and(eq(emails.id, id), eq(emails.userId, userId)),
    })
    if (!latestEmail) {
      return NextResponse.json({ error: "邮箱不存在" }, { status: 404 })
    }
    if (latestEmail.expiresAt <= new Date()) {
      return conflictResponse("emailExpired")
    }
    if (isPermanentExpiry(latestEmail.expiresAt)) {
      return conflictResponse("emailPermanent")
    }
    return NextResponse.json(
      { error: "续约后的日期超出支持范围", code: "expiryOverflow" },
      { status: 400 }
    )
  }

  const atIndex = renewedEmail.address.lastIndexOf("@")
  const domainName = atIndex >= 0 ? renewedEmail.address.slice(atIndex + 1).toLowerCase() : ""
  if (domainName) {
    const cleanupAfter = isPermanentExpiry(renewedEmail.expiresAt)
      ? null
      : renewedEmail.expiresAt.getTime() + AUTO_DOMAIN_CLEANUP_GRACE_MS

    try {
      await db
        .update(domains)
        .set({
          lastUsedAt: now,
          cleanupAfter: cleanupAfter === null
            ? null
            : sql`CASE
                WHEN ${domains.cleanupAfter} IS NULL THEN NULL
                WHEN ${domains.cleanupAfter} < ${cleanupAfter} THEN ${cleanupAfter}
                ELSE ${domains.cleanupAfter}
              END`,
        })
        .where(and(
          eq(domains.name, domainName),
          eq(domains.cleanupPolicy, DOMAIN_CLEANUP_POLICIES.AUTO),
          eq(domains.status, "active")
        ))
    } catch (error) {
      // The cleanup worker rechecks active mailboxes before deleting a domain,
      // so a renewed mailbox remains safe even if this scheduling hint fails.
      console.error(`Failed to update cleanup schedule for ${domainName}:`, error)
    }
  }

  return NextResponse.json({
    success: true,
    id: renewedEmail.id,
    email: renewedEmail.address,
    expiresAt: renewedEmail.expiresAt.toISOString(),
  })
}
