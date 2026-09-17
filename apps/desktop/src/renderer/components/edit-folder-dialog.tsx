import { useId, useState, type ChangeEvent } from "react"
import { PencilIcon, RefreshCwIcon, SaveIcon } from "lucide-react"
import type { FolderSummary, SyncMode } from "@shared/contracts"
import { invertMode, sharingWidening, type SharingWidening } from "@shared/folder-sharing-consent"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { appendIgnorePreset, folderIgnorePresets } from "./folder-ignore-presets"

const DEFAULT_HISTORY_DAYS = 30
const DEFAULT_HISTORY_MAX_GB = 10
const BYTES_PER_GB = 1024 ** 3

interface EditFolderDialogProps {
  folder: FolderSummary
  remoteName: string
  disabled?: boolean
  disabledReason?: string
}

/**
 * Edits the rules of an existing mapping. Paths and participants are not
 * editable: pointing a mapping somewhere else is a new mapping, not an update.
 */
export function EditFolderDialog({ folder, remoteName, disabled = false, disabledReason }: EditFolderDialogProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [mode, setMode] = useState<SyncMode>("two-way")
  const [patterns, setPatterns] = useState("")
  const [historyDays, setHistoryDays] = useState(DEFAULT_HISTORY_DAYS)
  const [historyMaxGb, setHistoryMaxGb] = useState(DEFAULT_HISTORY_MAX_GB)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameFieldId = useId()
  const modeFieldId = useId()
  const historyDaysFieldId = useId()
  const historyCapFieldId = useId()

  const currentHistoryDays = folder.historyDays ?? DEFAULT_HISTORY_DAYS
  const currentHistoryMaxGb = Math.max(1, Math.round((folder.historyMaxBytes ?? DEFAULT_HISTORY_MAX_GB * BYTES_PER_GB) / BYTES_PER_GB))
  const ignorePatterns = patterns.split("\n").map((pattern) => pattern.trim()).filter(Boolean)
  const hasChanges =
    name.trim() !== folder.name ||
    mode !== folder.mode ||
    ignorePatterns.join("\n") !== folder.ignorePatterns.join("\n") ||
    historyDays !== currentHistoryDays ||
    historyMaxGb !== currentHistoryMaxGb
  // Approval covers what the other computer shares, so an edit here may only narrow that.
  const widening = sharingWidening(
    { mode: invertMode(folder.mode), ignorePatterns: folder.ignorePatterns },
    { mode: invertMode(mode), ignorePatterns },
  )

  function resetForm() {
    setName(folder.name)
    setMode(folder.mode)
    setPatterns(folder.ignorePatterns.join("\n"))
    setHistoryDays(currentHistoryDays)
    setHistoryMaxGb(currentHistoryMaxGb)
    setError(null)
  }

  async function save() {
    if (saving || !hasChanges || widening) return
    setSaving(true)
    setError(null)
    try {
      await window.folderSync.updateFolderMapping({
        folderId: folder.id,
        name: name.trim(),
        mode,
        ignorePatterns,
        historyDays: Math.max(1, historyDays),
        historyMaxBytes: Math.max(1, historyMaxGb) * BYTES_PER_GB,
      })
      setOpen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The folder settings could not be saved.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen: boolean) => {
        setOpen(nextOpen)
        if (nextOpen) resetForm()
      }}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" disabled={disabled} title={disabled ? disabledReason : undefined} />}>
        <PencilIcon data-icon="inline-start" />
        Edit settings
      </DialogTrigger>
      <DialogContent className="max-w-[min(640px,calc(100%-2rem))]">
        <DialogHeader>
          <DialogTitle>Edit {folder.name}</DialogTitle>
          <DialogDescription>
            Change the rules for this mapping. The new settings apply on both computers once {remoteName} confirms them.
          </DialogDescription>
        </DialogHeader>

        <fieldset disabled={saving} className="[display:grid] [gap:18px] [margin-top:20px] [border:0] [padding:0] [min-width:0]">
          <Field>
            <FieldLabel htmlFor={nameFieldId}>Display name</FieldLabel>
            <Input id={nameFieldId} value={name} maxLength={120} onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor={modeFieldId}>Sync direction</FieldLabel>
            <NativeSelect id={modeFieldId} className="w-full" value={mode} onChange={(event: ChangeEvent<HTMLSelectElement>) => setMode(event.target.value as SyncMode)}>
              <NativeSelectOption value="two-way">Two-way sync</NativeSelectOption>
              <NativeSelectOption value="send-only">Send from this computer only</NativeSelectOption>
              <NativeSelectOption value="receive-only">Receive to this computer only</NativeSelectOption>
            </NativeSelect>
          </Field>
          <div className="mapping-settings-grid [display:grid] [grid-template-columns:repeat(2,_minmax(0,_1fr))] [gap:14px] max-[760px]:[grid-template-columns:1fr]">
            <Field>
              <FieldLabel htmlFor={historyDaysFieldId}>Keep versions for</FieldLabel>
              <div className="number-field [display:flex] [align-items:center] [overflow:hidden] [border:1px_solid_var(--input)] [border-radius:9px] [background:var(--surface-sunken)] [&:focus-within]:[border-color:var(--ring)] [&:focus-within]:[box-shadow:0_0_0_3px_color-mix(in_oklab,_var(--ring)_16%,_transparent)] [&_span]:[align-self:stretch] [&_span]:[display:grid] [&_span]:[place-items:center] [&_span]:[border-left:1px_solid_var(--border)] [&_span]:[padding:0_12px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:11px]"><Input id={historyDaysFieldId} className="min-w-0 flex-1 border-0 bg-transparent px-2.5 py-[9px] outline-none" type="number" min={1} max={3650} value={historyDays} onChange={(event: ChangeEvent<HTMLInputElement>) => setHistoryDays(Number(event.target.value))} /><span>days</span></div>
              <FieldDescription>Older replaced versions are removed.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={historyCapFieldId}>History storage cap</FieldLabel>
              <div className="number-field [display:flex] [align-items:center] [overflow:hidden] [border:1px_solid_var(--input)] [border-radius:9px] [background:var(--surface-sunken)] [&:focus-within]:[border-color:var(--ring)] [&:focus-within]:[box-shadow:0_0_0_3px_color-mix(in_oklab,_var(--ring)_16%,_transparent)] [&_span]:[align-self:stretch] [&_span]:[display:grid] [&_span]:[place-items:center] [&_span]:[border-left:1px_solid_var(--border)] [&_span]:[padding:0_12px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:11px]"><Input id={historyCapFieldId} className="min-w-0 flex-1 border-0 bg-transparent px-2.5 py-[9px] outline-none" type="number" min={1} max={4096} value={historyMaxGb} onChange={(event: ChangeEvent<HTMLInputElement>) => setHistoryMaxGb(Number(event.target.value))} /><span>GB</span></div>
              <FieldDescription>Per folder, on each computer.</FieldDescription>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="edit-folder-ignore-preset">Add ignore preset</FieldLabel>
            <NativeSelect id="edit-folder-ignore-preset" className="w-full" value="" onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              const preset = folderIgnorePresets.find((item) => item.id === event.target.value)
              if (!preset) return
              setPatterns(appendIgnorePreset(patterns, preset.patterns))
            }} aria-describedby="edit-folder-ignore-preset-help">
              <NativeSelectOption value="" disabled>Choose a preset…</NativeSelectOption>
              {folderIgnorePresets.map((preset) => <NativeSelectOption key={preset.id} value={preset.id}>{preset.label}</NativeSelectOption>)}
            </NativeSelect>
            <FieldDescription id="edit-folder-ignore-preset-help">Adds rules below without replacing yours.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-folder-ignore-patterns">Ignore patterns</FieldLabel>
            <Textarea id="edit-folder-ignore-patterns" aria-describedby="edit-folder-ignore-patterns-help" className="min-h-36 resize-y font-mono text-xs" value={patterns} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setPatterns(event.target.value)} />
            <FieldDescription id="edit-folder-ignore-patterns-help">One glob-style pattern per line. Newly ignored files stay where they are; they are no longer synced.</FieldDescription>
          </Field>
        </fieldset>

        {widening ? (
          <Alert className="mt-[14px]" role="status">
            <AlertDescription>{wideningMessage(widening, remoteName)}</AlertDescription>
          </Alert>
        ) : null}
        {error ? <Alert variant="destructive" className="mt-[14px]"><AlertDescription>{error}</AlertDescription></Alert> : null}

        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={saving || !hasChanges || widening !== undefined} onClick={() => void save()}>
            {saving ? <RefreshCwIcon className="animate-spin" data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function wideningMessage(widening: SharingWidening, remoteName: string): string {
  const action = widening === "starts-sending"
    ? `This direction would let ${remoteName} send its files here`
    : `Removing or changing an ignore rule would make ${remoteName} share files it currently keeps back`
  return `${action}, which ${remoteName} has not approved. To make this change, remove the folder and add it again so ${remoteName} can review it.`
}
