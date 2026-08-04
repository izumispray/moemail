"use client"

import { useId, useState } from "react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { EXPIRY_OPTIONS } from "@/types/email"
import { PERMANENT_EXPIRY_MS } from "@/lib/email-expiry"

const CUSTOM_MODE = "custom"
const MIN_CUSTOM_EXPIRY_MS = 60 * 1000

const UNIT_MULTIPLIERS = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
} as const

type DurationUnit = keyof typeof UNIT_MULTIPLIERS

interface ExpiryPickerProps {
  value: number
  onChange: (value: number) => void
  baseTime?: number
}

export function ExpiryPicker({
  value,
  onChange,
  baseTime = Date.now(),
}: ExpiryPickerProps) {
  const t = useTranslations("emails.expiry")
  const fieldId = useId()
  const [customAmount, setCustomAmount] = useState("30")
  const [customUnit, setCustomUnit] = useState<DurationUnit>("minutes")

  const presetValues = EXPIRY_OPTIONS.map((option) => option.value)
  const [selectedMode, setSelectedMode] = useState(
    presetValues.includes(value) ? value.toString() : CUSTOM_MODE
  )
  const customValid = value === 0 || (
    value >= MIN_CUSTOM_EXPIRY_MS &&
    Number.isSafeInteger(value) &&
    baseTime <= PERMANENT_EXPIRY_MS - value
  )

  const updateCustomDuration = (amount: string, unit: DurationUnit) => {
    const numericAmount = Number(amount)
    const duration = numericAmount * UNIT_MULTIPLIERS[unit]
    if (
      !Number.isInteger(numericAmount) ||
      numericAmount < 1 ||
      !Number.isSafeInteger(duration) ||
      baseTime > PERMANENT_EXPIRY_MS - duration
    ) {
      onChange(-1)
      return
    }
    onChange(duration)
  }

  const handleModeChange = (mode: string) => {
    setSelectedMode(mode)
    if (mode === CUSTOM_MODE) {
      updateCustomDuration(customAmount, customUnit)
      return
    }
    onChange(Number(mode))
  }

  const handleAmountChange = (amount: string) => {
    setCustomAmount(amount)
    updateCustomDuration(amount, customUnit)
  }

  const handleUnitChange = (unit: DurationUnit) => {
    setCustomUnit(unit)
    updateCustomDuration(customAmount, unit)
  }

  const preview = value === 0
    ? t("permanentPreview")
    : customValid
      ? new Date(baseTime + value).toLocaleString()
      : null

  const labels = [t("oneHour"), t("oneDay"), t("threeDays"), t("permanent")]

  return (
    <div className="space-y-3">
      <Label className="text-sm text-muted-foreground">{t("label")}</Label>
      <RadioGroup
        value={selectedMode}
        onValueChange={handleModeChange}
        className="grid grid-cols-2 gap-2 sm:grid-cols-5"
      >
        {EXPIRY_OPTIONS.map((option, index) => (
          <div key={option.value} className="flex items-center gap-2">
            <RadioGroupItem value={option.value.toString()} id={`${fieldId}-${option.value}`} />
            <Label htmlFor={`${fieldId}-${option.value}`} className="cursor-pointer text-sm">
              {labels[index]}
            </Label>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <RadioGroupItem value={CUSTOM_MODE} id={`${fieldId}-custom`} />
          <Label htmlFor={`${fieldId}-custom`} className="cursor-pointer text-sm">
            {t("custom")}
          </Label>
        </div>
      </RadioGroup>

      {selectedMode === CUSTOM_MODE && (
        <div className="space-y-1">
          <div className="flex gap-2">
            <Input
              type="number"
              min={1}
              step={1}
              value={customAmount}
              onChange={(event) => handleAmountChange(event.target.value)}
              aria-label={t("customAmount")}
              className="flex-1"
            />
            <Select value={customUnit} onValueChange={(unit) => handleUnitChange(unit as DurationUnit)}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="minutes">{t("minutes")}</SelectItem>
                <SelectItem value="hours">{t("hours")}</SelectItem>
                <SelectItem value="days">{t("days")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {!customValid && (
            <p className="text-xs text-destructive">{t("invalidCustom")}</p>
          )}
        </div>
      )}

      {preview && (
        <p className="text-xs text-muted-foreground">
          {t("preview")}: <span className="font-medium text-foreground">{preview}</span>
        </p>
      )}
    </div>
  )
}
