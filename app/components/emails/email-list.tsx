"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useSession } from "next-auth/react"
import { useTranslations } from "next-intl"
import { CreateDialog } from "./create-dialog"
import { ShareDialog } from "./share-dialog"
import { RenewDialog } from "./renew-dialog"
import { Mail, RefreshCw, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useThrottle } from "@/hooks/use-throttle"
import { EMAIL_CONFIG } from "@/config"
import { useToast } from "@/components/ui/use-toast"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ROLES } from "@/lib/permissions"
import { useUserRole } from "@/hooks/use-user-role"
import { useConfig } from "@/hooks/use-config"

interface Email {
  id: string
  address: string
  createdAt: number
  expiresAt: number | string
}

interface EmailListProps {
  onEmailSelect: (email: Email | null) => void
  selectedEmailId?: string
}

interface EmailResponse {
  emails: Email[]
  nextCursor: string | null
  total: number
}

export function EmailList({ onEmailSelect, selectedEmailId }: EmailListProps) {
  const { data: session } = useSession()
  const hasSession = Boolean(session)
  const { config } = useConfig()
  const { role } = useUserRole()
  const t = useTranslations("emails.list")
  const tCommon = useTranslations("common.actions")
  const [emails, setEmails] = useState<Email[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [emailToDelete, setEmailToDelete] = useState<Email | null>(null)
  const emailsRef = useRef<Email[]>([])
  const listRef = useRef<HTMLDivElement | null>(null)
  const loadingMoreCursorRef = useRef<string | null>(null)
  const lastAutoLoadCursorRef = useRef<string | null>(null)
  const { toast } = useToast()

  const setEmailList = useCallback((nextEmails: Email[]) => {
    emailsRef.current = nextEmails
    setEmails(nextEmails)
  }, [])

  const fetchEmails = useCallback(async (cursor?: string): Promise<boolean> => {
    if (cursor) {
      if (loadingMoreCursorRef.current === cursor) {
        return false
      }
      loadingMoreCursorRef.current = cursor
    }

    try {
      const url = new URL("/api/emails", window.location.origin)
      if (cursor) {
        url.searchParams.set('cursor', cursor)
      }
      const response = await fetch(url)
      const data = await response.json() as EmailResponse
      
      if (!cursor) {
        const newEmails = data.emails
        const oldEmails = emailsRef.current

        const lastDuplicateIndex = newEmails.findIndex(
          newEmail => oldEmails.some(oldEmail => oldEmail.id === newEmail.id)
        )

        if (lastDuplicateIndex === -1) {
          setEmailList(newEmails)
          setNextCursor(data.nextCursor)
          setTotal(data.total)
          return true
        }

        const uniqueNewEmails = newEmails.slice(0, lastDuplicateIndex)
        setEmailList([...uniqueNewEmails, ...oldEmails])
        setTotal(data.total)
        return true
      }

      setEmails(prev => {
        const existingIds = new Set(prev.map(email => email.id))
        const uniqueEmails = data.emails.filter(email => !existingIds.has(email.id))
        const nextEmails = [...prev, ...uniqueEmails]
        emailsRef.current = nextEmails
        return nextEmails
      })
      setNextCursor(data.nextCursor)
      setTotal(data.total)
      return true
    } catch (error) {
      console.error("Failed to fetch emails:", error)
      return false
    } finally {
      if (cursor && loadingMoreCursorRef.current === cursor) {
        loadingMoreCursorRef.current = null
      }
      setLoading(false)
      setRefreshing(false)
      setLoadingMore(false)
    }
  }, [setEmailList])

  const handleRefresh = async () => {
    lastAutoLoadCursorRef.current = null
    setRefreshing(true)
    await fetchEmails()
  }

  const handleScroll = useThrottle((e: React.UIEvent<HTMLDivElement>) => {
    if (loadingMore || loadingMoreCursorRef.current) return

    const { scrollHeight, scrollTop, clientHeight } = e.currentTarget
    const threshold = clientHeight * 1.5
    const remainingScroll = scrollHeight - scrollTop

    if (remainingScroll <= threshold && nextCursor) {
      setLoadingMore(true)
      void fetchEmails(nextCursor)
    }
  }, 200)

  useEffect(() => {
    if (hasSession) void fetchEmails()
  }, [hasSession, fetchEmails])

  const requestAutoLoadMore = useCallback(() => {
    if (!hasSession || loading || loadingMore || refreshing || !nextCursor || loadingMoreCursorRef.current) {
      return
    }

    const listElement = listRef.current
    if (!listElement || listElement.scrollHeight > listElement.clientHeight) {
      return
    }

    if (lastAutoLoadCursorRef.current === nextCursor) {
      return
    }

    lastAutoLoadCursorRef.current = nextCursor
    setLoadingMore(true)
    void fetchEmails(nextCursor).then((success) => {
      if (!success && lastAutoLoadCursorRef.current === nextCursor) {
        lastAutoLoadCursorRef.current = null
      }
    })
  }, [fetchEmails, hasSession, loading, loadingMore, nextCursor, refreshing])

  useEffect(() => {
    const frame = requestAnimationFrame(requestAutoLoadMore)
    return () => cancelAnimationFrame(frame)
  }, [emails.length, requestAutoLoadMore])

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return

    const listElement = listRef.current
    if (!listElement) return

    let frame: number | null = null
    const observer = new ResizeObserver(() => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      frame = requestAnimationFrame(requestAutoLoadMore)
    })

    observer.observe(listElement)
    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      observer.disconnect()
    }
  }, [requestAutoLoadMore])

  const handleDelete = async (email: Email) => {
    try {
      const response = await fetch(`/api/emails/${email.id}`, {
        method: "DELETE"
      })

      if (!response.ok) {
        const data = await response.json()
        toast({
          title: t("error"),
          description: (data as { error: string }).error,
          variant: "destructive"
        })
        return
      }

      setEmails(prev => {
        const nextEmails = prev.filter(e => e.id !== email.id)
        emailsRef.current = nextEmails
        return nextEmails
      })
      setTotal(prev => prev - 1)

      toast({
        title: t("success"),
        description: t("deleteSuccess")
      })
      
      if (selectedEmailId === email.id) {
        onEmailSelect(null)
      }
    } catch {
      toast({
        title: t("error"),
        description: t("deleteFailed"),
        variant: "destructive"
      })
    } finally {
      setEmailToDelete(null)
    }
  }

  const handleRenewed = (emailId: string, expiresAt: number) => {
    setEmails((previous) => {
      const nextEmails = previous.map((email) =>
        email.id === emailId ? { ...email, expiresAt } : email
      )
      emailsRef.current = nextEmails
      return nextEmails
    })
  }

  if (!session) return null

  return (
    <>
      <div className="flex flex-col h-full">
        <div className="p-2 flex justify-between items-center border-b border-primary/20">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={handleRefresh}
              disabled={refreshing}
              className={cn("h-8 w-8", refreshing && "animate-spin")}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <span className="text-xs text-gray-500">
              {role === ROLES.EMPEROR ? (
                t("emailCountUnlimited", { count: total })
              ) : (
                t("emailCount", { count: total, max: config?.maxEmails || EMAIL_CONFIG.MAX_ACTIVE_EMAILS })
              )}
            </span>
          </div>
          <CreateDialog onEmailCreated={handleRefresh} />
        </div>
        
        <div ref={listRef} className="flex-1 overflow-auto p-2" onScroll={handleScroll}>
          {loading ? (
            <div className="text-center text-sm text-gray-500">{t("loading")}</div>
          ) : emails.length > 0 ? (
            <div className="space-y-1">
              {emails.map(email => (
                <div
                  key={email.id}
                  className={cn("flex items-center gap-2 p-2 rounded cursor-pointer text-sm group",
                    "hover:bg-primary/5",
                    selectedEmailId === email.id && "bg-primary/10"
                  )}
                  onClick={() => onEmailSelect(email)}
                >
                  <Mail className="h-4 w-4 text-primary/60" />
                  <div className="truncate flex-1">
                    <div className="font-medium truncate">{email.address}</div>
                    <div className="text-xs text-gray-500">
                      {new Date(email.expiresAt).getUTCFullYear() >= 9999 ? (
                        t("permanent")
                      ) : (
                        `${t("expiresAt")}: ${new Date(email.expiresAt).toLocaleString()}`
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                    {new Date(email.expiresAt).getUTCFullYear() < 9999 && (
                      <RenewDialog
                        emailId={email.id}
                        emailAddress={email.address}
                        expiresAt={new Date(email.expiresAt).getTime()}
                        onRenewed={(expiresAt) => handleRenewed(email.id, expiresAt)}
                        onExpired={handleRefresh}
                      />
                    )}
                    <ShareDialog emailId={email.id} emailAddress={email.address} />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={(e) => {
                        e.stopPropagation()
                        setEmailToDelete(email)
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
              {loadingMore && (
                <div className="text-center text-sm text-gray-500 py-2">
                  {t("loadingMore")}
                </div>
              )}
            </div>
          ) : (
            <div className="text-center text-sm text-gray-500">
              {t("noEmails")}
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={!!emailToDelete} onOpenChange={() => setEmailToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirm")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDescription", { email: emailToDelete?.address || "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => emailToDelete && handleDelete(emailToDelete)}
            >
              {tCommon("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
