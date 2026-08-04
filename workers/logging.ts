export interface ErrorDescription {
  name?: string
  message: string
  stack?: string
}

export function describeError(error: unknown): ErrorDescription {
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

export function truncateForLog(value: string, maxLength = 1000): string {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}...`
}

export function parseJsonForLog<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

export function summarizeUrlForLog(value: string) {
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
      hasSearch: false,
      parseError: error instanceof Error ? error.name : "UnknownError",
    }
  }
}
