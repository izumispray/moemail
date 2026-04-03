"use client"

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Settings, Plus, Trash2, ChevronRight, Globe, Loader2 } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { useState, useEffect, useCallback } from "react"
import { Role, ROLES } from "@/lib/permissions"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Eye, EyeOff, X } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { EMAIL_CONFIG } from "@/config"

interface SubdomainInfo {
  id: string
  name: string
  subdomain: string
  rootDomain: string
  status: string
  createdAt: string
}

export function WebsiteConfigPanel() {
  const t = useTranslations("profile.website")
  const tCard = useTranslations("profile.card")
  const [defaultRole, setDefaultRole] = useState<string>("")
  const [emailDomains, setEmailDomains] = useState<string>("")
  const [adminContact, setAdminContact] = useState<string>("")
  const [maxEmails, setMaxEmails] = useState<string>(EMAIL_CONFIG.MAX_ACTIVE_EMAILS.toString())
  const [turnstileEnabled, setTurnstileEnabled] = useState(false)
  const [turnstileSiteKey, setTurnstileSiteKey] = useState("")
  const [turnstileSecretKey, setTurnstileSecretKey] = useState("")
  const [showSecretKey, setShowSecretKey] = useState(false)
  const [loading, setLoading] = useState(false)
  const [subdomains, setSubdomains] = useState<SubdomainInfo[]>([])
  const [newDomainInput, setNewDomainInput] = useState("")
  const [addingDomain, setAddingDomain] = useState(false)
  const [domainZones, setDomainZones] = useState<Record<string, string>>({})
  // Subdomain creation
  const [newSubdomainInputs, setNewSubdomainInputs] = useState<Record<string, string>>({})
  const [creatingSubdomain, setCreatingSubdomain] = useState<string | null>(null)
  const { toast } = useToast()

  const fetchConfig = useCallback(async () => {
    const res = await fetch("/api/config")
    if (res.ok) {
      const data = await res.json() as { 
        defaultRole: Exclude<Role, typeof ROLES.EMPEROR>,
        emailDomains: string,
        adminContact: string,
        maxEmails: string,
        domainZones?: Record<string, string>,
        turnstile?: {
          enabled: boolean,
          siteKey: string,
          secretKey?: string
        }
      }
      setDefaultRole(data.defaultRole)
      setEmailDomains(data.emailDomains)
      setAdminContact(data.adminContact)
      setMaxEmails(data.maxEmails || EMAIL_CONFIG.MAX_ACTIVE_EMAILS.toString())
      setDomainZones(data.domainZones || {})
      setTurnstileEnabled(Boolean(data.turnstile?.enabled))
      setTurnstileSiteKey(data.turnstile?.siteKey ?? "")
      setTurnstileSecretKey(data.turnstile?.secretKey ?? "")
    }
  }, [])

  const fetchSubdomains = useCallback(async () => {
    try {
      const res = await fetch("/api/domains")
      if (res.ok) {
        const data = await res.json() as { domains: SubdomainInfo[] }
        setSubdomains(data.domains || [])
      }
    } catch {
      // 非皇帝或 API 不可用时忽略
    }
  }, [])

  useEffect(() => {
    fetchConfig()
    fetchSubdomains()
  }, [fetchConfig, fetchSubdomains])

  const handleSave = async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          defaultRole, 
          emailDomains,
          adminContact,
          maxEmails: maxEmails || EMAIL_CONFIG.MAX_ACTIVE_EMAILS.toString(),
          domainZones,
          turnstile: {
            enabled: turnstileEnabled,
            siteKey: turnstileSiteKey,
            secretKey: turnstileSecretKey
          }
        }),
      })

      if (!res.ok) throw new Error(t("saveFailed"))

      toast({
        title: t("saveSuccess"),
        description: t("saveSuccess"),
      })
    } catch (error) {
      toast({
        title: t("saveFailed"),
        description: error instanceof Error ? error.message : t("saveFailed"),
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  const addDomain = async () => {
    const val = newDomainInput.trim().toLowerCase()
    if (!val) return

    const list = emailDomains ? emailDomains.split(",").filter(Boolean) : []
    if (list.includes(val)) {
      toast({ title: t("domainExists"), variant: "destructive" })
      return
    }

    setAddingDomain(true)
    try {
      // Auto-query Zone ID via DNS Worker
      const res = await fetch("/api/domains/find-zone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: val }),
      })

      if (!res.ok) {
        const data = await res.json() as { error: string }
        toast({
          title: t("zoneNotFound"),
          description: data.error,
          variant: "destructive",
        })
        return
      }

      const { zoneId } = await res.json() as { zoneId: string; zoneName: string }

      list.push(val)
      setEmailDomains(list.join(","))
      setDomainZones(prev => ({ ...prev, [val]: zoneId }))
      setNewDomainInput("")
      toast({ title: t("domainAdded"), description: `Zone ID: ${zoneId.substring(0, 8)}...` })
    } catch {
      toast({ title: t("zoneNotFound"), variant: "destructive" })
    } finally {
      setAddingDomain(false)
    }
  }

  const removeDomain = (domain: string) => {
    const list = emailDomains.split(",").filter(Boolean).filter(d => d.trim() !== domain)
    setEmailDomains(list.join(","))
    setDomainZones(prev => {
      const next = { ...prev }
      delete next[domain]
      return next
    })
  }

  const createSubdomain = async (rootDomain: string) => {
    const prefix = newSubdomainInputs[rootDomain]?.trim().toLowerCase()
    if (!prefix) return

    // Validate format
    const subdomainRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
    if (!subdomainRegex.test(prefix)) {
      toast({ title: t("subdomainInvalid"), variant: "destructive" })
      return
    }

    setCreatingSubdomain(rootDomain)
    try {
      const res = await fetch("/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subdomain: prefix, domain: rootDomain }),
      })

      if (!res.ok) {
        const data = await res.json() as { error: string }
        toast({
          title: t("subdomainCreateFailed"),
          description: data.error,
          variant: "destructive",
        })
        return
      }

      toast({ title: t("subdomainCreated"), description: `${prefix}.${rootDomain}` })
      setNewSubdomainInputs(prev => ({ ...prev, [rootDomain]: "" }))
      fetchSubdomains()
      fetchConfig()
    } catch {
      toast({ title: t("subdomainCreateFailed"), variant: "destructive" })
    } finally {
      setCreatingSubdomain(null)
    }
  }

  const deleteSubdomain = async (id: string) => {
    try {
      const res = await fetch(`/api/domains/${id}`, { method: "DELETE" })
      if (res.ok) {
        toast({ title: t("subdomainDeleted") })
        fetchSubdomains()
        fetchConfig()
      } else {
        const data = await res.json() as { error: string }
        toast({ title: t("subdomainDeleteFailed"), description: data.error, variant: "destructive" })
      }
    } catch {
      toast({ title: t("subdomainDeleteFailed"), variant: "destructive" })
    }
  }

  // 解析基础域名列表（去掉自动创建的子域名，只保留手动填入的）
  const baseDomains = emailDomains
    ? emailDomains.split(",").filter(Boolean).map(d => d.trim())
    : []

  // 按基础域名分组子域名
  const getSubdomainsForBase = (baseDomain: string) => {
    return subdomains.filter(s => s.rootDomain === baseDomain)
  }

  return (
    <div className="bg-background rounded-lg border-2 border-primary/20 p-6">
      <div className="flex items-center gap-2 mb-6">
        <Settings className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-semibold">{t("title")}</h2>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <span className="text-sm">{t("defaultRole")}:</span>
          <Select value={defaultRole} onValueChange={setDefaultRole}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ROLES.DUKE}>{tCard("roles.DUKE")}</SelectItem>
              <SelectItem value={ROLES.KNIGHT}>{tCard("roles.KNIGHT")}</SelectItem>
              <SelectItem value={ROLES.CIVILIAN}>{tCard("roles.CIVILIAN")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* 域名配置 - 层级式展示 */}
        <div className="space-y-3">
          <span className="text-sm font-medium">{t("emailDomains")}:</span>

          {/* 基础域名列表（每个一行，下挂子域名） */}
          <div className="space-y-1">
            {baseDomains.map((domain) => {
              // Only show root domains (not subdomains that have a parent in the list)
              const isChild = baseDomains.some(other => other !== domain && domain.endsWith(`.${other}`))
              if (isChild) return null

              const subs = getSubdomainsForBase(domain)
              return (
                <div key={domain} className="rounded-lg border border-border/60 overflow-hidden">
                  {/* 基础域名行 */}
                  <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
                    <Globe className="w-3.5 h-3.5 text-primary shrink-0" />
                    <span className="text-sm font-medium">{domain}</span>
                    {domainZones[domain] && (
                      <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        Zone: {domainZones[domain].substring(0, 8)}...
                      </span>
                    )}
                    <span className="flex-1" />
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive transition-colors p-0.5"
                      onClick={() => removeDomain(domain)}
                      title={t("removeDomain")}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* 该基础域名下的子域名前缀 */}
                  {subs.length > 0 && (
                    <div className="border-t border-border/40">
                      {subs.map((sub) => (
                        <div
                          key={sub.id}
                          className="flex items-center gap-2 px-3 py-1.5 pl-8 text-xs text-muted-foreground hover:bg-muted/20 group"
                        >
                          <ChevronRight className="w-3 h-3 shrink-0 opacity-40" />
                          <span className="font-mono">
                            {sub.subdomain}
                          </span>
                          <span className="opacity-40">.{sub.rootDomain}</span>
                          <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded-full ${
                            sub.status === 'active' 
                              ? 'bg-green-500/10 text-green-600' 
                              : 'bg-yellow-500/10 text-yellow-600'
                          }`}>
                            {sub.status === 'active' ? '✓' : '...'}
                          </span>
                          <button
                            type="button"
                            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all p-0.5"
                            onClick={() => deleteSubdomain(sub.id)}
                            title={t("deleteSubdomain")}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 添加子域名的内联表单 */}
                  <div className="border-t border-border/40 px-3 py-1.5 pl-8">
                    <div className="flex items-center gap-2">
                      <Plus className="w-3 h-3 shrink-0 opacity-40" />
                      <Input
                        value={newSubdomainInputs[domain] || ""}
                        onChange={(e) => setNewSubdomainInputs(prev => ({ ...prev, [domain]: e.target.value }))}
                        placeholder={t("subdomainPlaceholder")}
                        className="h-7 text-xs flex-1"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault()
                            createSubdomain(domain)
                          }
                        }}
                        disabled={creatingSubdomain === domain}
                      />
                      <span className="text-xs text-muted-foreground opacity-60">.{domain}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        onClick={() => createSubdomain(domain)}
                        disabled={creatingSubdomain === domain}
                      >
                        {creatingSubdomain === domain ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Plus className="w-3 h-3" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })}

            {baseDomains.length === 0 && (
              <div className="text-xs text-muted-foreground py-3 text-center border border-dashed rounded-lg">
                {t("noDomains")}
              </div>
            )}
          </div>

          {/* 添加新主域名（不再需要 Zone ID 输入） */}
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                value={newDomainInput}
                onChange={(e) => setNewDomainInput(e.target.value)}
                placeholder={t("domainInputPlaceholder")}
                className="text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    addDomain()
                  }
                }}
                disabled={addingDomain}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={addDomain}
                className="shrink-0"
                disabled={addingDomain}
              >
                {addingDomain ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {addingDomain ? t("lookingUpZone") : t("domainInputHint")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <span className="text-sm">{t("adminContact")}:</span>
          <div className="flex-1">
            <Input 
              value={adminContact}
              onChange={(e) => setAdminContact(e.target.value)}
              placeholder={t("adminContactPlaceholder")}
            />
          </div>
        </div>

        <div className="flex items-center gap-4">
          <span className="text-sm">{t("maxEmails")}:</span>
          <div className="flex-1">
            <Input 
              type="number"
              min="1"
              max="100"
              value={maxEmails}
              onChange={(e) => setMaxEmails(e.target.value)}
              placeholder={`${EMAIL_CONFIG.MAX_ACTIVE_EMAILS}`}
            />
          </div>
        </div>

        <div className="space-y-4 rounded-lg border border-dashed border-primary/40 p-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="turnstile-enabled" className="text-sm font-medium">
                {t("turnstile.enable")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("turnstile.enableDescription")}
              </p>
            </div>
            <Switch
              id="turnstile-enabled"
              checked={turnstileEnabled}
              onCheckedChange={setTurnstileEnabled}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="turnstile-site-key" className="text-sm font-medium">
              {t("turnstile.siteKey")}
            </Label>
            <Input
              id="turnstile-site-key"
              value={turnstileSiteKey}
              onChange={(e) => setTurnstileSiteKey(e.target.value)}
              placeholder={t("turnstile.siteKeyPlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="turnstile-secret-key" className="text-sm font-medium">
              {t("turnstile.secretKey")}
            </Label>
            <div className="relative">
              <Input
                id="turnstile-secret-key"
                type={showSecretKey ? "text" : "password"}
                value={turnstileSecretKey}
                onChange={(e) => setTurnstileSecretKey(e.target.value)}
                placeholder={t("turnstile.secretKeyPlaceholder")}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                onClick={() => setShowSecretKey((prev) => !prev)}
              >
                {showSecretKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("turnstile.secretKeyDescription")}
            </p>
          </div>
        </div>

        <Button 
          onClick={handleSave}
          disabled={loading}
          className="w-full"
        >
          {t("save")}
        </Button>
      </div>
    </div>
  )
}
