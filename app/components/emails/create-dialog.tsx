"use client"

import { useEffect, useState, useMemo } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Copy, Plus, RefreshCw, Globe, ChevronRight, Shuffle } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { nanoid } from "nanoid"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { EXPIRY_OPTIONS } from "@/types/email"
import { useCopy } from "@/hooks/use-copy"
import { useConfig } from "@/hooks/use-config"
import { cn } from "@/lib/utils"

interface CreateDialogProps {
  onEmailCreated: () => void
}

interface DomainGroup {
  root: string
  subdomains: string[]
}

/**
 * Parse flat domain list into hierarchical groups.
 * A domain is considered a subdomain if removing its first segment yields
 * another domain in the list.
 * e.g. ["example.com", "news.example.com", "test.example.com", "other.dev"]
 * =>  [
 *       { root: "example.com", subdomains: ["news.example.com", "test.example.com"] },
 *       { root: "other.dev", subdomains: [] }
 *     ]
 */
function buildDomainGroups(domains: string[]): DomainGroup[] {
  const domainSet = new Set(domains)
  const childOf = new Map<string, string>() // subdomain -> root

  for (const d of domains) {
    const parts = d.split(".")
    if (parts.length >= 3) {
      // Try stripping the first segment: "a.b.com" -> "b.com"
      const parent = parts.slice(1).join(".")
      if (domainSet.has(parent)) {
        childOf.set(d, parent)
      }
    }
  }

  const rootDomains = domains.filter(d => !childOf.has(d))
  const groups: DomainGroup[] = rootDomains.map(root => ({
    root,
    subdomains: domains.filter(d => childOf.get(d) === root),
  }))

  return groups
}

export function CreateDialog({ onEmailCreated }: CreateDialogProps) {
  const { config } = useConfig()
  const t = useTranslations("emails.create")
  const tList = useTranslations("emails.list")
  const tCommon = useTranslations("common.actions")
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [emailName, setEmailName] = useState("")
  const [selectedDomain, setSelectedDomain] = useState("")
  const [expiryTime, setExpiryTime] = useState(EXPIRY_OPTIONS[1].value.toString())
  const { toast } = useToast()
  const { copyToClipboard } = useCopy()

  const domainGroups = useMemo(() => {
    if (!config?.emailDomainsArray?.length) return []
    return buildDomainGroups(config.emailDomainsArray)
  }, [config?.emailDomainsArray])

  const allDomains = useMemo(() => {
    if (!config?.emailDomainsArray?.length) return []
    return config.emailDomainsArray
  }, [config?.emailDomainsArray])

  // Set initial selected domain
  useEffect(() => {
    if (allDomains.length > 0 && !selectedDomain) {
      setSelectedDomain(allDomains[0])
    }
  }, [allDomains, selectedDomain])

  const generateRandomName = () => setEmailName(nanoid(8))

  const randomAll = () => {
    if (allDomains.length > 0) {
      const randomDomain = allDomains[Math.floor(Math.random() * allDomains.length)]
      setSelectedDomain(randomDomain)
    }
    setEmailName(nanoid(8))
  }

  const copyEmailAddress = () => {
    copyToClipboard(`${emailName}@${selectedDomain}`)
  }

  const createEmail = async () => {
    if (!emailName.trim()) {
      toast({
        title: tList("error"),
        description: t("namePlaceholder"),
        variant: "destructive"
      })
      return
    }

    if (!selectedDomain) {
      toast({
        title: tList("error"),
        description: t("domainPlaceholder"),
        variant: "destructive"
      })
      return
    }

    setLoading(true)
    try {
      const response = await fetch("/api/emails/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: emailName,
          domain: selectedDomain,
          expiryTime: parseInt(expiryTime)
        })
      })

      if (!response.ok) {
        const data = await response.json()
        toast({
          title: tList("error"),
          description: (data as { error: string }).error,
          variant: "destructive"
        })
        return
      }

      toast({
        title: tList("success"),
        description: t("success")
      })
      onEmailCreated()
      setOpen(false)
      setEmailName("")
    } catch {
      toast({
        title: tList("error"),
        description: t("failed"),
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="w-4 h-4" />
          {t("title")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {/* Domain selection - hierarchical */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm text-muted-foreground">{t("domain")}</Label>
              <Button
                variant="ghost"
                size="sm"
                onClick={randomAll}
                type="button"
                className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-primary"
              >
                <Shuffle className="w-3 h-3" />
                {t("randomAll")}
              </Button>
            </div>
            <div className="max-h-[200px] overflow-y-auto rounded-lg border border-border/60">
              <div className="space-y-0">
                {domainGroups.map((group) => (
                  <div key={group.root}>
                    {/* Root domain row */}
                    <button
                      type="button"
                      className={cn(
                        "flex items-center gap-2 w-full px-3 py-2 text-left text-sm transition-colors",
                        "hover:bg-primary/5",
                        selectedDomain === group.root && "bg-primary/10 text-primary font-medium"
                      )}
                      onClick={() => setSelectedDomain(group.root)}
                    >
                      <Globe className="w-3.5 h-3.5 shrink-0 text-primary/60" />
                      <span className="truncate">{group.root}</span>
                      {selectedDomain === group.root && (
                        <span className="ml-auto text-[10px] bg-primary/15 text-primary px-1.5 py-0.5 rounded-full">
                          ✓
                        </span>
                      )}
                    </button>

                    {/* Subdomain rows */}
                    {group.subdomains.map((sub) => (
                      <button
                        key={sub}
                        type="button"
                        className={cn(
                          "flex items-center gap-2 w-full px-3 py-1.5 pl-8 text-left text-sm transition-colors",
                          "hover:bg-primary/5",
                          selectedDomain === sub && "bg-primary/10 text-primary font-medium"
                        )}
                        onClick={() => setSelectedDomain(sub)}
                      >
                        <ChevronRight className="w-3 h-3 shrink-0 opacity-40" />
                        <span className="font-mono text-xs truncate">
                          {sub.replace(`.${group.root}`, '')}
                        </span>
                        <span className="text-xs opacity-40">.{group.root}</span>
                        {selectedDomain === sub && (
                          <span className="ml-auto text-[10px] bg-primary/15 text-primary px-1.5 py-0.5 rounded-full">
                            ✓
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                ))}

                {domainGroups.length === 0 && (
                  <div className="text-xs text-muted-foreground py-4 text-center">
                    {t("domainPlaceholder")}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Email name input */}
          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">{t("name")}</Label>
            <div className="flex gap-2">
              <Input
                value={emailName}
                onChange={(e) => setEmailName(e.target.value)}
                placeholder={t("namePlaceholder")}
                className="flex-1"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={generateRandomName}
                type="button"
                title={t("namePlaceholder")}
              >
                <RefreshCw className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* Expiry time */}
          <div className="flex items-center gap-4">
            <Label className="shrink-0 text-muted-foreground">{t("expiryTime")}</Label>
            <RadioGroup
              value={expiryTime}
              onValueChange={setExpiryTime}
              className="flex gap-6"
            >
              {EXPIRY_OPTIONS.map((option, index) => {
                const labels = [t("oneHour"), t("oneDay"), t("threeDays"), t("permanent")]
                return (
                  <div key={option.value} className="flex items-center gap-2">
                    <RadioGroupItem value={option.value.toString()} id={option.value.toString()} />
                    <Label htmlFor={option.value.toString()} className="cursor-pointer text-sm">
                      {labels[index]}
                    </Label>
                  </div>
                )
              })}
            </RadioGroup>
          </div>

          {/* Preview */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="shrink-0">{t("preview")}:</span>
            {emailName && selectedDomain ? (
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate font-mono text-xs bg-muted/50 px-2 py-1 rounded">
                  {`${emailName}@${selectedDomain}`}
                </span>
                <div
                  className="shrink-0 cursor-pointer hover:text-primary transition-colors"
                  onClick={copyEmailAddress}
                >
                  <Copy className="size-4" />
                </div>
              </div>
            ) : (
              <span className="text-gray-400">...</span>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={createEmail} disabled={loading}>
            {loading ? t("creating") : t("create")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}