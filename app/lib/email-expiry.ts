export const PERMANENT_EXPIRY_ISO = "9999-01-01T00:00:00.000Z"
export const PERMANENT_EXPIRY_MS = Date.parse(PERMANENT_EXPIRY_ISO)

export type EmailExpiryErrorCode = "invalidExpiryTime" | "expiryOverflow"

export type EmailExpiryResult =
  | {
      success: true
      expiryTime: number
      expiresAt: Date
      permanent: boolean
    }
  | {
      success: false
      code: EmailExpiryErrorCode
      error: string
    }

export type EmailRenewalErrorCode = EmailExpiryErrorCode | "emailExpired" | "emailPermanent"

type EmailRenewalResult =
  | Extract<EmailExpiryResult, { success: true }>
  | {
      success: false
      code: EmailRenewalErrorCode
      error: string
    }

export function isPermanentExpiry(expiresAt: Date): boolean {
  return expiresAt.getTime() >= PERMANENT_EXPIRY_MS
}

export function resolveEmailExpiry(
  value: unknown,
  baseDate: Date = new Date()
): EmailExpiryResult {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return {
      success: false,
      code: "invalidExpiryTime",
      error: "expiryTime 必须是非负安全整数（毫秒）",
    }
  }

  if (value === 0) {
    return {
      success: true,
      expiryTime: value,
      expiresAt: new Date(PERMANENT_EXPIRY_MS),
      permanent: true,
    }
  }

  const baseTime = baseDate.getTime()
  if (!Number.isFinite(baseTime) || baseTime > PERMANENT_EXPIRY_MS - value) {
    return {
      success: false,
      code: "expiryOverflow",
      error: "expiryTime 超出支持的日期范围",
    }
  }

  return {
    success: true,
    expiryTime: value,
    expiresAt: new Date(baseTime + value),
    permanent: false,
  }
}

export function resolveEmailRenewal(
  currentExpiresAt: Date,
  value: unknown,
  now: Date = new Date()
): EmailRenewalResult {
  if (currentExpiresAt <= now) {
    return {
      success: false,
      code: "emailExpired",
      error: "邮箱已过期，无法续约",
    }
  }

  if (isPermanentExpiry(currentExpiresAt)) {
    return {
      success: false,
      code: "emailPermanent",
      error: "永久邮箱无需续约",
    }
  }

  return resolveEmailExpiry(value, currentExpiresAt)
}
