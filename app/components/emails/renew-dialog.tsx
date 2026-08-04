"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Clock3 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import { ExpiryPicker } from "./expiry-picker"

const DEFAULT_RENEWAL_MS = 24 * 60 * 60 * 1000

interface RenewDialogProps {
  emailId: string
  emailAddress: string
  expiresAt: number
  onRenewed: (expiresAt: number) => void
  onExpired?: () => void
}

interface RenewResponse {
  error?: string
  code?: string
  expiresAt?: string
}

export function RenewDialog({
  emailId,
  emailAddress,
  expiresAt,
  onRenewed,
  onExpired,
}: RenewDialogProps) {
  const t = useTranslations("emails.renew")
  const tList = useTranslations("emails.list")
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [expiryTime, setExpiryTime] = useState(DEFAULT_RENEWAL_MS)
  const { toast } = useToast()

  useEffect(() => {
    if (open) setExpiryTime(DEFAULT_RENEWAL_MS)
  }, [open])

  const renewEmail = async () => {
    if (expiryTime < 0) return

    setLoading(true)
    try {
      const response = await fetch(`/api/emails/${emailId}/renew`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiryTime }),
      })
      const data = await response.json() as RenewResponse

      if (!response.ok || !data.expiresAt) {
        const description = data.code === "emailExpired"
          ? t("expired")
          : data.code === "emailPermanent"
            ? t("permanent")
            : data.error || t("failed")
        toast({ title: tList("error"), description, variant: "destructive" })
        if (data.code === "emailExpired") {
          setOpen(false)
          onExpired?.()
        }
        return
      }

      const renewedExpiresAt = new Date(data.expiresAt).getTime()
      onRenewed(renewedExpiresAt)
      toast({ title: tList("success"), description: t("success") })
      setOpen(false)
    } catch {
      toast({ title: tList("error"), description: t("failed"), variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title={t("action")}
        >
          <Clock3 className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="rounded-md bg-muted/50 p-3 text-sm">
            <div className="truncate font-medium">{emailAddress}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t("currentExpiry")}: {new Date(expiresAt).toLocaleString()}
            </div>
          </div>
          <ExpiryPicker
            value={expiryTime}
            onChange={setExpiryTime}
            baseTime={expiresAt}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
            {t("cancel")}
          </Button>
          <Button onClick={renewEmail} disabled={loading || expiryTime < 0}>
            {loading ? t("renewing") : t("confirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
