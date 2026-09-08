import { useId, useState, type ChangeEvent, type KeyboardEvent } from "react"
import { AlertCircleIcon } from "lucide-react"
import { BYTE_UNITS, BYTE_UNIT_MULTIPLIERS, isByteUnit, splitBytes, toBytes, type ByteUnit } from "@/lib/byte-size"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

const MIN_BYTES = BYTE_UNIT_MULTIPLIERS.KB // 1 KB
const MAX_BYTES = BYTE_UNIT_MULTIPLIERS.TB // 1 TB
const DEFAULT_LIMIT_BYTES = 100 * BYTE_UNIT_MULTIPLIERS.MB // sensible default once a limit is turned on

const VALIDATION_MESSAGE = "Enter a size between 1 KB and 1 TB, or turn on No limit."

interface FileSizeLimitFieldProps {
  /** Maximum file size in bytes. `null` means no limit. */
  value: number | null
  onChange: (value: number | null) => void
  disabled?: boolean
}

/** An in-progress edit: the raw typed amount plus the unit it is measured in. */
interface Draft {
  amountText: string
  unit: ByteUnit
}

/**
 * Controlled number-plus-unit editor for a per-folder maximum file size.
 * Deals only in bytes (`null` = no limit); it knows nothing about folder
 * mappings, IPC, or the wizard that hosts it.
 */
export function FileSizeLimitField({ value, onChange, disabled = false }: FileSizeLimitFieldProps) {
  const inputId = useId()
  const errorId = useId()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)

  const noLimit = value === null
  const derived = noLimit ? { amount: 0, unit: "MB" as ByteUnit } : splitBytes(value)
  const amountText = draft?.amountText ?? (noLimit ? "" : String(derived.amount))
  const unit = draft?.unit ?? derived.unit

  const controlsDisabled = disabled || noLimit
  const minAmountForUnit = MIN_BYTES / BYTE_UNIT_MULTIPLIERS[unit]
  const maxAmountForUnit = MAX_BYTES / BYTE_UNIT_MULTIPLIERS[unit]

  function commit(nextAmountText: string, nextUnit: ByteUnit): void {
    const amount = Number(nextAmountText)
    if (nextAmountText.trim() === "" || !Number.isFinite(amount) || amount <= 0) {
      setError(VALIDATION_MESSAGE)
      return
    }
    const bytes = toBytes(amount, nextUnit)
    if (bytes < MIN_BYTES || bytes > MAX_BYTES) {
      setError(VALIDATION_MESSAGE)
      return
    }
    setError(null)
    setDraft(null)
    onChange(bytes)
  }

  function handleAmountChange(event: ChangeEvent<HTMLInputElement>): void {
    setDraft({ amountText: event.target.value, unit })
  }

  function handleAmountBlur(event: ChangeEvent<HTMLInputElement>): void {
    commit(event.target.value, unit)
  }

  function handleAmountKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") event.currentTarget.blur()
  }

  function handleUnitChange(nextUnit: ByteUnit): void {
    setDraft({ amountText, unit: nextUnit })
    commit(amountText, nextUnit)
  }

  function handleNoLimitChange(checked: boolean): void {
    setError(null)
    setDraft(null)
    onChange(checked ? null : DEFAULT_LIMIT_BYTES)
  }

  return (
    <div className="grid gap-1.5">
      <div className="[display:flex] [align-items:center] [gap:10px]">
        <label htmlFor={inputId} className="sr-only">
          Maximum file size
        </label>
        <div className="number-field [display:flex] [align-items:center] [overflow:hidden] [border:1px_solid_var(--input)] [border-radius:9px] [background:var(--surface-sunken)] [&:focus-within]:[border-color:var(--ring)] [&:focus-within]:[box-shadow:0_0_0_3px_color-mix(in_oklab,_var(--ring)_16%,_transparent)]">
          <input
            id={inputId}
            className="[min-width:0] [flex:1] [border:0] [background:transparent] [padding:9px_10px] [outline:none] [color:var(--foreground)] [font-size:12.5px]"
            type="number"
            step="any"
            min={minAmountForUnit}
            max={maxAmountForUnit}
            disabled={controlsDisabled}
            aria-invalid={error !== null}
            aria-describedby={error !== null ? errorId : undefined}
            placeholder="No limit"
            value={amountText}
            onChange={handleAmountChange}
            onBlur={handleAmountBlur}
            onKeyDown={handleAmountKeyDown}
          />
          <Select
            value={unit}
            onValueChange={(next: unknown) => {
              if (isByteUnit(next)) handleUnitChange(next)
            }}
            disabled={controlsDisabled}
          >
            <SelectTrigger
              aria-label="File size unit"
              className="h-auto min-w-0 w-auto shrink-0 self-stretch rounded-none border-0 border-l border-l-[var(--border)] bg-transparent px-3 py-0 text-[11px] text-[var(--muted-foreground)] shadow-none focus-visible:ring-0"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BYTE_UNITS.map((byteUnit) => (
                <SelectItem key={byteUnit} value={byteUnit}>
                  {byteUnit}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="[display:flex] [align-items:center] [gap:6px] [font-size:10.5px] [color:var(--muted-foreground)]">
          <Switch
            aria-label="No file size limit"
            checked={noLimit}
            disabled={disabled}
            onCheckedChange={handleNoLimitChange}
          />
          No limit
        </label>
      </div>
      {error !== null ? (
        <p id={errorId} role="alert" className="[display:flex] [align-items:center] [gap:5px] [font-size:11px] [color:var(--destructive)]">
          <AlertCircleIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </div>
  )
}
