import { normalizeDomainName } from "./domain-utils"

const MAX_LOCAL_PART_LENGTH = 64
const MAX_EMAIL_ADDRESS_LENGTH = 254
const EMAIL_LOCAL_PART_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/

export type EmailAddressValidationError =
  | "invalidFormat"
  | "emptyLocalPart"
  | "localPartTooLong"
  | "localPartWhitespace"
  | "localPartDots"
  | "invalidLocalPartCharacters"
  | "addressTooLong"
  | "domainNotAllowed"

export interface EmailAddressValidationFailure {
  success: false
  error: EmailAddressValidationError
}

export interface EmailLocalPartValidationSuccess {
  success: true
  value: string
}

export type EmailLocalPartValidationResult =
  | EmailLocalPartValidationSuccess
  | EmailAddressValidationFailure

export interface ParsedEmailAddress {
  localPart: string
  domain: string
  address: string
}

export interface EmailAddressValidationSuccess extends ParsedEmailAddress {
  success: true
}

export type EmailAddressValidationResult =
  | EmailAddressValidationSuccess
  | EmailAddressValidationFailure

/**
 * Validate the ASCII local part accepted when creating a mailbox.
 * The value is deliberately preserved: only domains are normalized.
 */
export function validateEmailLocalPart(value: unknown): EmailLocalPartValidationResult {
  if (typeof value !== "string" || value.length === 0) {
    return { success: false, error: "emptyLocalPart" }
  }

  if (value.length > MAX_LOCAL_PART_LENGTH) {
    return { success: false, error: "localPartTooLong" }
  }

  if (/\s/.test(value)) {
    return { success: false, error: "localPartWhitespace" }
  }

  if (value.startsWith(".") || value.endsWith(".") || value.includes("..")) {
    return { success: false, error: "localPartDots" }
  }

  if (!EMAIL_LOCAL_PART_PATTERN.test(value)) {
    return { success: false, error: "invalidLocalPartCharacters" }
  }

  return { success: true, value }
}

/** Parse and normalize a complete mailbox address against configured domains. */
export function parseEmailAddress(
  value: unknown,
  allowedDomains: readonly string[]
): EmailAddressValidationResult {
  if (typeof value !== "string") {
    return { success: false, error: "invalidFormat" }
  }

  const firstAt = value.indexOf("@")
  if (firstAt < 0 || firstAt !== value.lastIndexOf("@")) {
    return { success: false, error: "invalidFormat" }
  }

  const localPart = value.slice(0, firstAt)
  const localPartValidation = validateEmailLocalPart(localPart)
  if (!localPartValidation.success) {
    return localPartValidation
  }

  const rawDomain = value.slice(firstAt + 1)
  const domain = normalizeDomainName(rawDomain)
  const normalizedAllowedDomains = new Set(allowedDomains.map(normalizeDomainName))

  if (!domain || !normalizedAllowedDomains.has(domain)) {
    return { success: false, error: "domainNotAllowed" }
  }

  const address = `${localPart}@${domain}`
  if (address.length > MAX_EMAIL_ADDRESS_LENGTH) {
    return { success: false, error: "addressTooLong" }
  }

  return {
    success: true,
    localPart,
    domain,
    address,
  }
}
