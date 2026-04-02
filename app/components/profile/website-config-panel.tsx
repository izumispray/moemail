"use client"

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Settings, Plus, Trash2, ChevronRight, Globe, X } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { useState, useEffect, useCallback } from "react"
import { Role, ROLES } from "@/lib/permissions"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Eye, EyeOff } from "lucide-react"
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
  const [newZoneIdInput, setNewZoneIdInput] = useState("")
  const [domainZones, setDomainZones] = useState<Record<string, string>>({})
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

  const addDomain = () => {
    const val = newDomainInput.trim().toLowerCase()
    const zoneId = newZoneIdInput.trim()
    if (!val) return
    if (!zoneId) {
      toast({ title: "请填写 Zone ID", description: "可在 Cloudflare Dashboard 的域名概览页找到", variant: "destructive" })
      return
    }
    const list = emailDomains ? emailDomains.split(",").filter(Boolean) : []
    if (list.includes(val)) {
      toast({ title: "域名已存在", variant: "destructive" })
      return
    }
    list.push(val)
    setEmailDomains(list.join(","))
    setDomainZones(prev => ({ ...prev, [val]: zoneId }))
    setNewDomainInput("")
    setNewZoneIdInput("")
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

  const deleteSubdomain = async (id: string) => {
    try {
      const res = await fetch(`/api/domains/${id}`, { method: "DELETE" })
      if (res.ok) {
        toast({ title: "子域名已删除" })
        fetchSubdomains()
        fetchConfig()
      } else {
        const data = await res.json() as { error: string }
        toast({ title: "删除失败", description: data.error, variant: "destructive" })
      }
    } catch {
      toast({ title: "删除失败", variant: "destructive" })
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
                      title="移除域名"
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
                            title="删除子域名"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}

            {baseDomains.length === 0 && (
              <div className="text-xs text-muted-foreground py-3 text-center border border-dashed rounded-lg">
                暂无域名配置
              </div>
            )}
          </div>

          {/* 添加新域名 */}
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                value={newDomainInput}
                onChange={(e) => setNewDomainInput(e.target.value)}
                placeholder={"输入域名，如 example.com"}
                className="text-sm"
              />
              <Input
                value={newZoneIdInput}
                onChange={(e) => setNewZoneIdInput(e.target.value)}
                placeholder={"Cloudflare Zone ID"}
                className="text-sm font-mono"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    addDomain()
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={addDomain}
                className="shrink-0"
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">Zone ID 可在 Cloudflare Dashboard → 域名概览页右侧找到</p>
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
