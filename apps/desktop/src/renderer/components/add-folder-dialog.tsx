import { useMemo, useState, type ChangeEvent, type ReactNode } from "react"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  ComputerIcon,
  FileWarningIcon,
  FolderOpenIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
} from "lucide-react"
import type {
  DeviceSummary,
  FolderMappingPreview,
  RequestFolderMappingInput,
  SyncMode,
} from "@shared/contracts"
import { FolderPickerDialog } from "@/components/folder-picker-dialog"
import { Badge } from "@/components/ui/badge"
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
import { cn } from "@/lib/utils"

const defaultIgnorePatterns = [".DS_Store", "Thumbs.db", "desktop.ini", "*.tmp", "~$*"]
type PickerTarget = "local" | "remote" | null
type Step = "paths" | "rules" | "preview"

interface AddFolderDialogProps {
  localDevice: DeviceSummary
  pairedDevice: DeviceSummary
  onAdded: () => void
  disabled?: boolean
  disabledReason?: string
}

export function AddFolderDialog({
  localDevice,
  pairedDevice,
  onAdded,
  disabled = false,
  disabledReason,
}: AddFolderDialogProps) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>("paths")
  const [pickerTarget, setPickerTarget] = useState<PickerTarget>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [localPath, setLocalPath] = useState("")
  const [remotePath, setRemotePath] = useState("")
  const [mode, setMode] = useState<SyncMode>("two-way")
  const [patterns, setPatterns] = useState(defaultIgnorePatterns.join("\n"))
  const [historyDays, setHistoryDays] = useState(30)
  const [historyMaxGb, setHistoryMaxGb] = useState(10)
  const [preview, setPreview] = useState<FolderMappingPreview | null>(null)

  const ignorePatterns = useMemo(
    () => patterns.split("\n").map((pattern) => pattern.trim()).filter(Boolean),
    [patterns],
  )
  const canContinue = Boolean(localPath.trim() && remotePath.trim())
  const hasBlockingWarnings = Boolean(preview?.invalidWindowsNames.length || preview?.caseCollisions.length)

  function chooseLocalPath(selected: string) {
    setLocalPath(selected)
    setPreview(null)
    if (!name) setName(selected.split(/[\\/]/).filter(Boolean).at(-1) ?? "Synced folder")
  }

  function chooseRemotePath(selected: string) {
    setRemotePath(selected)
    setPreview(null)
  }

  function mappingInput(): Omit<RequestFolderMappingInput, "preview"> {
    return {
      name: name.trim(),
      localPath: localPath.trim(),
      remotePath: remotePath.trim(),
      remoteDeviceId: pairedDevice.id,
      mode,
      ignorePatterns,
      historyDays: Math.max(1, historyDays),
      historyMaxBytes: Math.max(1, historyMaxGb) * 1024 ** 3,
    }
  }

  async function buildPreview() {
    if (!canContinue || busy) return
    setBusy(true)
    setError(null)
    try {
      const next = await window.folderSync.previewFolderMapping(mappingInput())
      setPreview(next)
      setStep("preview")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to compare the folders.")
    } finally {
      setBusy(false)
    }
  }

  async function requestApproval() {
    if (!preview || hasBlockingWarnings || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.folderSync.requestFolderMapping({ ...mappingInput(), preview })
      setOpen(false)
      resetForm()
      onAdded()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to request folder approval.")
    } finally {
      setBusy(false)
    }
  }

  function resetForm() {
    setStep("paths")
    setName("")
    setLocalPath("")
    setRemotePath("")
    setMode("two-way")
    setPatterns(defaultIgnorePatterns.join("\n"))
    setHistoryDays(30)
    setHistoryMaxGb(10)
    setPreview(null)
    setPickerTarget(null)
    setError(null)
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen: boolean) => {
          setOpen(nextOpen)
          if (!nextOpen) setPickerTarget(null)
        }}
      >
        <DialogTrigger render={<Button disabled={disabled} title={disabled ? disabledReason : undefined} />}>
          <PlusIcon data-icon="inline-start" />
          Add folder
        </DialogTrigger>
        <DialogContent className="mapping-wizard-dialog">
          <DialogHeader>
            <DialogTitle>Create a folder mapping</DialogTitle>
            <DialogDescription>
              Select one folder on each computer, review the initial merge, then ask the other computer to approve it.
            </DialogDescription>
          </DialogHeader>

          <WizardSteps step={step} />

          {step === "paths" ? (
            <div className="mapping-step-panel">
              <div className="paired-path-summary">
                <div><ComputerIcon /><span>{localDevice.name}</span></div>
                <span>↔</span>
                <div><ComputerIcon /><span>{pairedDevice.name}</span></div>
              </div>
              <Field label="Display name" hint="Optional; defaults to the source folder name.">
                <input className="field-control" value={name} onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)} placeholder="Projects" />
              </Field>
              <Field label={`Folder on ${localDevice.name}`}>
                <PathChooser value={localPath} placeholder="Choose a source folder" onBrowse={() => setPickerTarget("local")} />
              </Field>
              <Field label={`Folder on ${pairedDevice.name}`} hint="Remote browsing is encrypted and returns folder names only.">
                <PathChooser value={remotePath} placeholder="Choose a destination folder" onBrowse={() => setPickerTarget("remote")} />
              </Field>
            </div>
          ) : null}

          {step === "rules" ? (
            <div className="mapping-step-panel">
              <Field label="Sync direction">
                <select className="field-control" value={mode} onChange={(event: ChangeEvent<HTMLSelectElement>) => { setMode(event.target.value as SyncMode); setPreview(null) }}>
                  <option value="two-way">Two-way sync</option>
                  <option value="send-only">Send from this computer only</option>
                  <option value="receive-only">Receive to this computer only</option>
                </select>
              </Field>
              <div className="mapping-settings-grid">
                <Field label="Keep versions for" hint="Oldest versions are removed first.">
                  <div className="number-field"><input type="number" min={1} max={3650} value={historyDays} onChange={(event: ChangeEvent<HTMLInputElement>) => setHistoryDays(Number(event.target.value))} /><span>days</span></div>
                </Field>
                <Field label="History storage cap" hint="Per folder, on each computer.">
                  <div className="number-field"><input type="number" min={1} max={4096} value={historyMaxGb} onChange={(event: ChangeEvent<HTMLInputElement>) => setHistoryMaxGb(Number(event.target.value))} /><span>GB</span></div>
                </Field>
              </div>
              <Field label="Ignore patterns" hint="One glob-style pattern per line. Subfolders sync recursively unless ignored.">
                <textarea className="field-control min-h-36 resize-y font-mono text-xs" value={patterns} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => { setPatterns(event.target.value); setPreview(null) }} />
              </Field>
            </div>
          ) : null}

          {step === "preview" && preview ? (
            <MappingPreviewView preview={preview} localName={localDevice.name} remoteName={pairedDevice.name} />
          ) : null}

          {error ? <p className="mapping-error">{error}</p> : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => {
              if (step === "paths") setOpen(false)
              else setStep(step === "preview" ? "rules" : "paths")
            }}>
              {step === "paths" ? "Cancel" : <><ArrowLeftIcon data-icon="inline-start" />Back</>}
            </Button>
            {step === "paths" ? (
              <Button disabled={!canContinue} onClick={() => setStep("rules")}>Rules and history<ArrowRightIcon data-icon="inline-end" /></Button>
            ) : null}
            {step === "rules" ? (
              <Button disabled={!canContinue || busy} onClick={() => void buildPreview()}>
                {busy ? <RefreshCwIcon className="animate-spin" data-icon="inline-start" /> : <CheckCircle2Icon data-icon="inline-start" />}
                {busy ? "Comparing folders…" : "Review initial merge"}
              </Button>
            ) : null}
            {step === "preview" ? (
              <Button disabled={busy || hasBlockingWarnings} onClick={() => void requestApproval()}>
                <SendIcon data-icon="inline-start" />
                {busy ? "Sending request…" : "Request approval"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FolderPickerDialog
        open={pickerTarget === "local"}
        onOpenChange={(pickerOpen) => setPickerTarget(pickerOpen ? "local" : null)}
        device={localDevice}
        initialPath={localPath || undefined}
        title="Choose the source folder"
        onSelect={chooseLocalPath}
      />
      <FolderPickerDialog
        open={pickerTarget === "remote"}
        onOpenChange={(pickerOpen) => setPickerTarget(pickerOpen ? "remote" : null)}
        device={pairedDevice}
        initialPath={remotePath || undefined}
        title="Choose the destination folder"
        description={`Securely browsing folders on ${pairedDevice.name}. Creating folders remotely is disabled until approval.`}
        onSelect={chooseRemotePath}
      />
    </>
  )
}

function WizardSteps({ step }: { step: Step }) {
  const activeIndex = step === "paths" ? 0 : step === "rules" ? 1 : 2
  return (
    <div className="wizard-steps" aria-label="Folder mapping progress">
      {["Choose folders", "Rules and history", "Review and approve"].map((label, index) => (
        <div key={label} className={cn("wizard-step", index === activeIndex && "wizard-step-active", index < activeIndex && "wizard-step-complete")}>
          <span>{index < activeIndex ? <CheckCircle2Icon /> : index + 1}</span><strong>{label}</strong>
        </div>
      ))}
    </div>
  )
}

function MappingPreviewView({ preview, localName, remoteName }: { preview: FolderMappingPreview; localName: string; remoteName: string }) {
  const warnings = preview.invalidWindowsNames.length + preview.caseCollisions.length
  return (
    <div className="mapping-preview">
      <div className="preview-summary-grid">
        <PreviewMetric label={`Only on ${localName}`} value={preview.localOnlyFiles} detail={formatBytes(preview.bytesToRemote)} />
        <PreviewMetric label={`Only on ${remoteName}`} value={preview.remoteOnlyFiles} detail={formatBytes(preview.bytesToLocal)} />
        <PreviewMetric label="Different at same path" value={preview.differentFiles} detail="Left untouched and reported for review" />
        <PreviewMetric label="Already identical" value={preview.identicalFiles} detail="No transfer needed" />
      </div>

      {preview.truncated ? (
        <div className="mapping-warning"><FileWarningIcon /><div><strong>Preview limit reached</strong><span>The comparison sampled the first 10,000 files on one or both computers. No files have been changed.</span></div></div>
      ) : null}
      {warnings > 0 ? (
        <div className="mapping-warning danger"><FileWarningIcon /><div><strong>Resolve {warnings} cross-platform path problems</strong><span>Windows-invalid names or case-only collisions must be renamed before approval can be requested.</span></div></div>
      ) : null}

      <div className="preview-transfer-row">
        <div><span>Estimated to {remoteName}</span><strong>{formatBytes(preview.bytesToRemote)}</strong></div>
        <ArrowRightIcon />
        <div><span>Estimated to {localName}</span><strong>{formatBytes(preview.bytesToLocal)}</strong></div>
      </div>

      <div className="preview-details">
        <div className="preview-details-heading"><strong>Sample differences</strong><Badge variant={warnings ? "danger" : "neutral"}>{preview.samples.length} shown</Badge></div>
        {preview.samples.length === 0 ? <p className="preview-empty">Both folders currently contain the same files.</p> : (
          <div className="preview-file-list">
            {preview.samples.map((item) => (
              <div key={`${item.category}:${item.path}`}><span className={`preview-dot preview-${item.category}`} /><code title={item.path}>{item.path}</code><small>{previewCategory(item.category)}{item.size ? ` · ${formatBytes(item.size)}` : ""}</small></div>
            ))}
          </div>
        )}
      </div>
      <p className="preview-safety-note">This preview is read-only. After approval, the initial merge copies missing files in the allowed direction; it never replaces or deletes an existing path.</p>
    </div>
  )
}

function PreviewMetric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return <div className="preview-metric"><span>{label}</span><strong>{value.toLocaleString("en-GB")}</strong><small>{detail}</small></div>
}

function PathChooser({ value, placeholder, onBrowse }: { value: string; placeholder: string; onBrowse: () => void }) {
  return (
    <div className="flex gap-2">
      <input className="field-control min-w-0 flex-1" value={value} readOnly placeholder={placeholder} title={value} />
      <Button variant="outline" onClick={onBrowse}><FolderOpenIcon data-icon="inline-start" />Browse</Button>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="grid gap-2"><span className="text-sm font-medium">{label}</span>{children}{hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}</label>
}

function formatBytes(value: number): string {
  if (value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function previewCategory(category: FolderMappingPreview["samples"][number]["category"]): string {
  if (category === "local-only") return "Only on this computer"
  if (category === "remote-only") return "Only on paired computer"
  if (category === "different") return "Different versions"
  if (category === "invalid-name") return "Invalid on Windows"
  return "Case-only collision"
}
