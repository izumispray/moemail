"use client"

import { create } from "zustand"
import { Role, ROLES } from "@/lib/permissions"
import { EMAIL_CONFIG } from "@/config"
import { useEffect } from "react"
import { normalizeDomainName } from "@/lib/domain-utils"

interface Config {
  defaultRole: Exclude<Role, typeof ROLES.EMPEROR>
  emailDomains: string
  emailDomainsArray: string[]
  adminContact: string
  maxEmails: number
  registrationEnabled: boolean
}

interface ConfigStore {
  config: Config | null
  loading: boolean
  error: string | null
  fetch: () => Promise<void>
}

const useConfigStore = create<ConfigStore>((set) => ({
  config: null,
  loading: false,
  error: null,
  fetch: async () => {
    try {
      set({ loading: true, error: null })
      const res = await fetch("/api/config", { cache: "no-store" })
      if (!res.ok) throw new Error("获取配置失败")
      const data = await res.json() as Config
      set({
        config: {
          defaultRole: data.defaultRole || ROLES.CIVILIAN,
          emailDomains: data.emailDomains,
          emailDomainsArray: Array.from(new Set(
            data.emailDomains.split(",").map(domain => normalizeDomainName(domain)).filter(Boolean)
          )),
          adminContact: data.adminContact || "",
          maxEmails: Number(data.maxEmails) || EMAIL_CONFIG.MAX_ACTIVE_EMAILS,
          registrationEnabled: data.registrationEnabled ?? true
        },
        loading: false
      })
    } catch (error) {
      set({ 
        error: error instanceof Error ? error.message : "获取配置失败",
        loading: false 
      })
    }
  }
}))

export function useConfig() {
  const store = useConfigStore()
  const { config, loading, fetch } = store

  useEffect(() => {
    if (!config && !loading) {
      fetch()
    }
  }, [config, fetch, loading])

  return store
}
