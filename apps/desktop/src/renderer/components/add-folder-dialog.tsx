import { useMemo, useState, type ChangeEvent } from "react"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  FileWarningIcon,
  FolderOpenIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
} from "lucide-react"
import type {
  DeviceSummary,
  FolderMappingPreview,
  FolderScanActivity,
  RequestFolderMappingInput,
  SyncMode,
} from "@shared/contracts"
import { CompareStatus } from "@/components/compare-status"
import { FolderPickerDialog } from "@/components/folder-picker-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { cn } from "@/lib/utils"
import { formatBytes } from "@/lib/format"
import { formatElapsed, useElapsedSeconds, type ComparePhase } from "@/lib/compare-progress"

const defaultIgnorePatterns = [".DS_Store", "Thumbs.db", "desktop.ini", "*.tmp", "~$*"]
type PickerTarget = "local" | "remote" | null
type Step = "paths" | "rules" | "preview"

interface AddFolderDialogProps {
  localDevice: DeviceSummary
  pairedDevices: DeviceSummary[]
  onAdded: () => void
  disabled?: boolean
  disabledReason?: string
}

/**
 * Multi-step wizard dialog for creating a new folder mapping between local and paired devices, with path selection, sync rules configuration, and initial merge preview.
 */
export function AddFolderDialog({
  localDevice,
  pairedDevices,
  onAdded,
  disabled = false,
  disabledReason,
}: AddFolderDialogProps) {
  const defaultDevice = pairedDevices.find((device) => device.status === "online") ?? pairedDevices[0]
  const [selectedDeviceId, setSelectedDeviceId] = useState(() => defaultDevice?.id ?? "")
  const targetDevice = pairedDevices.find((device) => device.id === selectedDeviceId) ?? defaultDevice
  const hasOnlineDevice = pairedDevices.some((device) => device.status === "online")
  const triggerDisabled = disabled || !hasOnlineDevice
  const onlyPairedDevice = pairedDevices.length === 1 ? pairedDevices[0] : undefined
  const triggerDisabledReason = disabled
    ? disabledReason
    : onlyPairedDevice
      ? `${onlyPairedDevice.name} must be online to browse and approve a mapping.`
      : "No paired computer is online. Bring one online before adding a folder."
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>("paths")
  const [pickerTarget, setPickerTarget] = useState<PickerTarget>(null)
  const [compare, setCompare] = useState<{
    operationId: string
    kind: "preview" | "request"
    phase: ComparePhase | null
    scannedFiles?: number
    activity?: FolderScanActivity
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const elapsed = formatElapsed(useElapsedSeconds(compare !== null))
  const [name, setName] = useState("")
  const [localPath, setLocalPath] = useState("")
  const [remotePath, setRemotePath] = useState("")
  const [mode, setMode] = useState<SyncMode>("two-way")
  const [patterns, setPatterns] = useState(defaultIgnorePatterns.join("\n"))
  const [historyDays, setHistoryDays] = useState(30)
  const [historyMaxGb, setHistoryMaxGb] = useState(10)
  const [preview, setPreview] = useState<FolderMappingPreview | null>(null)
  const [cancelRequested, setCancelRequested] = useState(false)

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
    if (!targetDevice) throw new Error("Select a paired computer before continuing.")
    return {
      name: name.trim(),
      localPath: localPath.trim(),
      remotePath: remotePath.trim(),
      remoteDeviceId: targetDevice.id,
      mode,
      ignorePatterns,
      historyDays: Math.max(1, historyDays),
      historyMaxBytes: Math.max(1, historyMaxGb) * 1024 ** 3,
      maxFileBytes: null,
    }
  }

  function trackCompareProgress(operationId: string): () => void {
    return window.folderSync.onPreviewProgress((progress) => {
      if (progress.operationId !== operationId) return
      setCompare((current) =>
        current?.operationId === operationId
          ? { ...current, phase: progress.phase, scannedFiles: progress.scannedFiles, activity: progress.activity }
          : current,
      )
    })
  }

  async function buildPreview() {
    if (!canContinue || !targetDevice || targetDevice.status !== "online" || compare) return
    const operationId = crypto.randomUUID()
    setCancelRequested(false)
    setCompare({ operationId, kind: "preview", phase: null })
    setError(null)
    const stopTracking = trackCompareProgress(operationId)
    try {
      const next = await window.folderSync.previewFolderMapping(mappingInput(), operationId)
      setPreview(next)
      setStep("preview")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to compare the folders.")
    } finally {
      stopTracking()
      setCompare(null)
      setCancelRequested(false)
    }
  }

  async function requestApproval() {
    if (!preview || !targetDevice || targetDevice.status !== "online" || hasBlockingWarnings || compare) return
    const operationId = crypto.randomUUID()
    setCancelRequested(false)
    setCompare({ operationId, kind: "request", phase: null })
    setError(null)
    const stopTracking = trackCompareProgress(operationId)
    try {
      await window.folderSync.requestFolderMapping({ ...mappingInput(), preview }, operationId)
      setOpen(false)
      resetForm()
      onAdded()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to request folder approval.")
    } finally {
      stopTracking()
      setCompare(null)
      setCancelRequested(false)
    }
  }

  async function cancelComparison() {
    const operationId = compare?.operationId
    if (!operationId || cancelRequested) return
    setCancelRequested(true)
    try {
      await window.folderSync.cancelFolderPreview(operationId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to cancel the comparison.")
      setCancelRequested(false)
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
    setSelectedDeviceId(defaultDevice?.id ?? "")
    setError(null)
  }

  return (
    <>
      <Dialog
        open={open}
        disablePointerDismissal={compare !== null}
        onOpenChange={(nextOpen: boolean) => {
          if (!nextOpen && compare !== null) return
          setOpen(nextOpen)
          if (!nextOpen) setPickerTarget(null)
        }}
      >
        <DialogTrigger render={<Button disabled={triggerDisabled} title={triggerDisabled ? triggerDisabledReason : undefined} />}>
          <PlusIcon data-icon="inline-start" />
          Add folder
        </DialogTrigger>
        <DialogContent className="mapping-wizard-dialog max-w-[780px]" showCloseButton={!compare}>
          <DialogHeader>
            <DialogTitle>Create a folder mapping</DialogTitle>
            <DialogDescription>
              Select one folder on each computer, review the initial merge, then ask the other computer to approve it.
            </DialogDescription>
          </DialogHeader>

          <WizardSteps step={step} />

          {step === "paths" ? (
            <div className="mapping-step-panel [display:grid] [gap:18px] [margin-top:20px]">
              <Field>
                <FieldLabel>Display name</FieldLabel>
                <Input value={name} onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)} placeholder="Projects" />
                <FieldDescription>Optional; defaults to the source folder name.</FieldDescription>
              </Field>
              {pairedDevices.length > 1 ? (
                <Field>
                  <FieldLabel>Computer to sync with</FieldLabel>
                  <NativeSelect
                    className="w-full"
                    value={targetDevice?.id ?? ""}
                    disabled={compare !== null}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                      setSelectedDeviceId(event.target.value)
                      setRemotePath("")
                      setPreview(null)
                      setError(null)
                    }}
                  >
                    {pairedDevices.map((device) => (
                      <NativeSelectOption key={device.id} value={device.id}>{device.status === "offline" ? `${device.name} (offline)` : device.name}</NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              ) : null}
              <div className="mapping-path-fields [display:grid] [grid-template-columns:repeat(2,_minmax(0,_1fr))] [gap:14px] max-[760px]:[grid-template-columns:minmax(0,_1fr)]">
                <Field>
                  <FieldLabel>{`Folder on ${localDevice.name}`}</FieldLabel>
                  <PathChooser value={localPath} placeholder="Choose a source folder" onBrowse={() => setPickerTarget("local")} />
                </Field>
                {targetDevice ? <Field>
                  <FieldLabel>{`Folder on ${targetDevice.name}`}</FieldLabel>
                  <PathChooser value={remotePath} placeholder="Choose a destination folder" onBrowse={() => setPickerTarget("remote")} />
                  <FieldDescription>Remote browsing is encrypted and returns folder names only.</FieldDescription>
                </Field> : null}
              </div>
            </div>
          ) : null}

          {step === "rules" ? (
            <fieldset disabled={compare !== null} className="mapping-step-panel [display:grid] [gap:18px] [margin-top:20px] [border:0] [padding:0] [min-width:0]">
              <Field>
                <FieldLabel>Sync direction</FieldLabel>
                <NativeSelect className="w-full" value={mode} onChange={(event: ChangeEvent<HTMLSelectElement>) => { setMode(event.target.value as SyncMode); setPreview(null) }}>
                  <NativeSelectOption value="two-way">Two-way sync</NativeSelectOption>
                  <NativeSelectOption value="send-only">Send from this computer only</NativeSelectOption>
                  <NativeSelectOption value="receive-only">Receive to this computer only</NativeSelectOption>
                </NativeSelect>
              </Field>
              <div className="mapping-settings-grid [display:grid] [grid-template-columns:repeat(2,_minmax(0,_1fr))] [gap:14px] max-[760px]:[grid-template-columns:1fr]">
                <Field>
                  <FieldLabel>Keep versions for</FieldLabel>
                  <div className="number-field [display:flex] [align-items:center] [overflow:hidden] [border:1px_solid_var(--input)] [border-radius:9px] [background:var(--surface-sunken)] [&:focus-within]:[border-color:var(--ring)] [&:focus-within]:[box-shadow:0_0_0_3px_color-mix(in_oklab,_var(--ring)_16%,_transparent)] [&_span]:[align-self:stretch] [&_span]:[display:grid] [&_span]:[place-items:center] [&_span]:[border-left:1px_solid_var(--border)] [&_span]:[padding:0_12px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:11px]"><Input className="min-w-0 flex-1 border-0 bg-transparent px-2.5 py-[9px] outline-none" type="number" min={1} max={3650} value={historyDays} onChange={(event: ChangeEvent<HTMLInputElement>) => setHistoryDays(Number(event.target.value))} /><span>days</span></div>
                  <FieldDescription>Saved with the folder; not enforced yet.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>History storage cap</FieldLabel>
                  <div className="number-field [display:flex] [align-items:center] [overflow:hidden] [border:1px_solid_var(--input)] [border-radius:9px] [background:var(--surface-sunken)] [&:focus-within]:[border-color:var(--ring)] [&:focus-within]:[box-shadow:0_0_0_3px_color-mix(in_oklab,_var(--ring)_16%,_transparent)] [&_span]:[align-self:stretch] [&_span]:[display:grid] [&_span]:[place-items:center] [&_span]:[border-left:1px_solid_var(--border)] [&_span]:[padding:0_12px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:11px]"><Input className="min-w-0 flex-1 border-0 bg-transparent px-2.5 py-[9px] outline-none" type="number" min={1} max={4096} value={historyMaxGb} onChange={(event: ChangeEvent<HTMLInputElement>) => setHistoryMaxGb(Number(event.target.value))} /><span>GB</span></div>
                  <FieldDescription>Per folder, on each computer; not enforced yet.</FieldDescription>
                </Field>
              </div>
              <p className="text-xs text-[var(--muted-foreground)]">Tethera keeps every replaced version for now. Both values are saved with the folder for a future cleanup policy; nothing is pruned or deleted yet, so history disk use is not limited today.</p>
              <Field>
                <FieldLabel>Ignore patterns</FieldLabel>
                <Textarea className="min-h-36 resize-y font-mono text-xs" value={patterns} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => { setPatterns(event.target.value); setPreview(null) }} />
                <FieldDescription>One glob-style pattern per line. Subfolders sync recursively unless ignored. Exclude large generated folders to keep scans and previews fast.</FieldDescription>
              </Field>
            </fieldset>
          ) : null}

          {step === "preview" && preview ? (
            targetDevice ? <MappingPreviewView preview={preview} localName={localDevice.name} remoteName={targetDevice.name} /> : null
          ) : null}

          {compare ? (
            <CompareStatus
              phase={compare.phase}
              purpose={compare.kind === "request" ? "verify" : "review"}
              thisComputer={localDevice.name}
              otherComputer={targetDevice?.name ?? "paired computer"}
              scannedFiles={compare.scannedFiles}
              activity={compare.activity}
              elapsed={elapsed}
            />
          ) : null}

          {error ? <Alert variant="destructive" className="mt-[14px]"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {targetDevice && targetDevice.status !== "online" ? <Alert variant="destructive" className="mt-[14px]"><AlertDescription>{targetDevice.name} is offline. Choose an online computer to browse and approve this mapping.</AlertDescription></Alert> : null}

          <DialogFooter>
            {compare && (compare.phase === "scan-local" || compare.phase === "scan-remote") ? <Button variant="outline" disabled={cancelRequested} onClick={() => void cancelComparison()}>{cancelRequested ? "Cancelling…" : "Cancel comparison"}</Button> : null}
            <Button variant="outline" disabled={compare !== null} onClick={() => {
              if (step === "paths") setOpen(false)
              else setStep(step === "preview" ? "rules" : "paths")
            }}>
              {step === "paths" ? "Cancel" : <><ArrowLeftIcon data-icon="inline-start" />Back</>}
            </Button>
            {step === "paths" ? (
              <Button disabled={!canContinue} onClick={() => setStep("rules")}>Rules and history<ArrowRightIcon data-icon="inline-end" /></Button>
            ) : null}
            {step === "rules" ? (
              <Button disabled={!canContinue || !targetDevice || targetDevice.status !== "online" || compare !== null} onClick={() => void buildPreview()}>
                {compare ? <RefreshCwIcon className="animate-spin" data-icon="inline-start" /> : <CheckCircle2Icon data-icon="inline-start" />}
                {compare ? "Comparing folders…" : "Review initial merge"}
              </Button>
            ) : null}
            {step === "preview" ? (
              <Button disabled={!targetDevice || targetDevice.status !== "online" || compare !== null || hasBlockingWarnings} onClick={() => void requestApproval()}>
                {compare ? <RefreshCwIcon className="animate-spin" data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}
                {compare ? "Verifying & sending…" : "Request approval"}
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
      {targetDevice ? <FolderPickerDialog
        open={pickerTarget === "remote"}
        onOpenChange={(pickerOpen) => setPickerTarget(pickerOpen ? "remote" : null)}
        device={targetDevice}
        initialPath={remotePath || undefined}
        title="Choose the destination folder"
        description={`Securely browsing folders on ${targetDevice.name}. Creating folders remotely is disabled until approval.`}
        onSelect={chooseRemotePath}
      /> : null}
    </>
  )
}

function WizardSteps({ step }: { step: Step }) {
  const activeIndex = step === "paths" ? 0 : step === "rules" ? 1 : 2
  return (
    <div className="wizard-steps [display:grid] [grid-template-columns:repeat(3,_1fr)] [gap:8px] [margin-top:22px] max-[760px]:[grid-template-columns:1fr]" aria-label="Folder mapping progress">
      {["Choose folders", "Rules and history", "Review and approve"].map((label, index) => (
        <div key={label} className={cn("wizard-step [display:flex] [align-items:center] [gap:8px] [min-width:0] [border:1px_solid_var(--border)] [border-radius:10px] [padding:10px_12px] [color:var(--muted-foreground)] [background:color-mix(in_oklab,_var(--surface)_70%,_transparent)] [&>span]:[display:grid] [&>span]:[place-items:center] [&>span]:[width:22px] [&>span]:[height:22px] [&>span]:[flex:0_0_auto] [&>span]:[border-radius:999px] [&>span]:[background:var(--muted)] [&>span]:[font-size:11px] [&>span]:[font-weight:700] [&>span_svg]:[width:14px] [&>span_svg]:[height:14px] [&_strong]:[overflow:hidden] [&_strong]:[text-overflow:ellipsis] [&_strong]:[white-space:nowrap] [&_strong]:[font-size:11px]", index === activeIndex && "wizard-step-active [border-color:color-mix(in_oklab,_var(--primary)_45%,_var(--border))] [color:var(--foreground)] [background:color-mix(in_oklab,_var(--primary)_10%,_var(--surface))] [&>span]:[background:var(--primary)] [&>span]:[color:var(--primary-foreground)]", index < activeIndex && "wizard-step-complete [&>span]:[background:var(--primary)] [&>span]:[color:var(--primary-foreground)]")}>
          <span>{index < activeIndex ? <CheckCircle2Icon /> : index + 1}</span><strong>{label}</strong>
        </div>
      ))}
    </div>
  )
}

function MappingPreviewView({ preview, localName, remoteName }: { preview: FolderMappingPreview; localName: string; remoteName: string }) {
  const warnings = preview.invalidWindowsNames.length + preview.caseCollisions.length
  return (
    <div className="mapping-preview [display:grid] [gap:14px] [margin-top:20px]">
      <div className="preview-summary-grid [display:grid] [grid-template-columns:repeat(4,_minmax(0,_1fr))] [gap:10px] max-[760px]:[grid-template-columns:repeat(2,_minmax(0,_1fr))]">
        <PreviewMetric label={`Only on ${localName}`} value={preview.localOnlyFiles} detail={formatBytes(preview.bytesToRemote)} />
        <PreviewMetric label={`Only on ${remoteName}`} value={preview.remoteOnlyFiles} detail={formatBytes(preview.bytesToLocal)} />
        <PreviewMetric label="Different at same path" value={preview.differentFiles} detail="Left untouched and reported for review" />
        <PreviewMetric label="Already identical" value={preview.identicalFiles} detail="No transfer needed" />
      </div>

      {preview.truncated ? (
        <Alert><FileWarningIcon /><AlertTitle>Preview limit reached</AlertTitle><AlertDescription>The comparison sampled only part of one or both folders. Each computer applies its own scan limit, and the preview does not say which side stopped first. Check Settings on both computers, or add ignore rules, then compare again. No files have been changed.</AlertDescription></Alert>
      ) : null}
      {warnings > 0 ? (
        <Alert variant="destructive"><FileWarningIcon /><AlertTitle>Resolve {warnings} cross-platform path problems</AlertTitle><AlertDescription>Windows-invalid names or case-only collisions must be renamed before approval can be requested.</AlertDescription></Alert>
      ) : null}

      {warnings > 0 ? (
        <details className="rounded-lg border border-[var(--border)] p-3 text-xs">
          <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-[var(--ring)]">Show filenames that need attention</summary>
          <div className="mt-2 max-h-40 space-y-3 overflow-auto">
            {[
              { label: "Not supported on Windows", paths: preview.invalidWindowsNames },
              { label: "Names differing only by case", paths: preview.caseCollisions },
            ].filter((group) => group.paths.length > 0).map((group) => (
              <div key={group.label}>
                <p className="font-medium">{group.label}</p>
                <ul className="mt-1 space-y-1">
                  {group.paths.map((filePath) => <li key={filePath}><code className="[overflow-wrap:anywhere]">{filePath}</code></li>)}
                </ul>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <div className="preview-transfer-row [display:grid] [grid-template-columns:1fr_auto_1fr] [align-items:center] [gap:12px] [border:1px_solid_var(--border)] [border-radius:var(--radius-tile)] [padding:12px_14px] [background:color-mix(in_oklab,_var(--primary)_6%,_var(--surface))] [&>div]:[display:flex] [&>div]:[justify-content:space-between] [&>div]:[gap:12px] [&>div:last-child]:[flex-direction:row-reverse] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:10px] [&_strong]:[font-size:12px] [&>svg]:[width:16px] [&>svg]:[color:var(--primary)]">
        <div><span>Estimated to {remoteName}</span><strong>{formatBytes(preview.bytesToRemote)}</strong></div>
        <ArrowRightIcon />
        <div><span>Estimated to {localName}</span><strong>{formatBytes(preview.bytesToLocal)}</strong></div>
      </div>

      <div className="preview-details [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-tile)]">
        <div className="preview-details-heading [display:flex] [align-items:center] [justify-content:space-between] [padding:10px_12px] [border-bottom:1px_solid_var(--border)] [background:var(--surface)] [&_strong]:[font-size:11px]"><strong>Largest differences</strong><Badge variant={warnings ? "danger" : "neutral"}>{preview.samples.length} shown</Badge></div>
        {preview.samples.length === 0 ? <p className="preview-empty [padding:18px] [text-align:center] [color:var(--muted-foreground)] [font-size:11px]">Both folders currently contain the same files.</p> : (
          <div className="preview-file-list [max-height:190px] [overflow:auto] [&>div]:[display:grid] [&>div]:[grid-template-columns:auto_minmax(0,_1fr)_auto] [&>div]:[align-items:center] [&>div]:[gap:8px] [&>div]:[padding:8px_12px] [&>div]:[border-top:1px_solid_color-mix(in_oklab,_var(--border)_60%,_transparent)] [&>div:first-child]:[border-top:0] [&_code]:[overflow:hidden] [&_code]:[text-overflow:ellipsis] [&_code]:[white-space:nowrap] [&_code]:[font-size:10px] [&_small]:[color:var(--muted-foreground)] [&_small]:[font-size:9px]">
            {preview.samples.map((item) => (
              <div key={`${item.category}:${item.path}`}><span data-category={item.category} className="preview-dot [width:7px] [height:7px] [border-radius:999px] [background:var(--muted-foreground)] data-[category=local-only]:[background:var(--chart-1)] data-[category=remote-only]:[background:var(--chart-2)] data-[category=different]:[background:var(--warning)] data-[category=invalid-name]:[background:var(--warning)] data-[category=case-collision]:[background:var(--warning)]" /><code title={item.path}>{item.path}</code><small>{previewCategory(item.category)}{item.size ? ` · ${formatBytes(item.size)}` : ""}</small></div>
            ))}
          </div>
        )}
      </div>
      <p className="preview-safety-note [color:var(--muted-foreground)] [font-size:10px] [text-align:center]">This preview is read-only. After approval, the initial merge copies missing files in the allowed direction; it never replaces or deletes an existing path.</p>
    </div>
  )
}

function PreviewMetric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return <div className="preview-metric [display:grid] [gap:3px] [min-width:0] [border:1px_solid_var(--border)] [border-radius:var(--radius-tile)] [background:var(--surface)] [padding:12px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:10px] [&_strong]:[font-size:22px] [&_strong]:[line-height:1.1] [&_strong]:[font-variant-numeric:tabular-nums] [&_small]:[overflow:hidden] [&_small]:[text-overflow:ellipsis] [&_small]:[color:var(--muted-foreground)] [&_small]:[font-size:9.5px]"><span>{label}</span><strong>{value.toLocaleString("en-GB")}</strong><small>{detail}</small></div>
}

function PathChooser({ value, placeholder, onBrowse }: { value: string; placeholder: string; onBrowse: () => void }) {
  return (
    <div className="flex gap-2">
      <Input className="min-w-0 flex-1" value={value} readOnly placeholder={placeholder} title={value} />
      <Button variant="outline" onClick={onBrowse}><FolderOpenIcon data-icon="inline-start" />Browse</Button>
    </div>
  )
}

function previewCategory(category: FolderMappingPreview["samples"][number]["category"]): string {
  if (category === "local-only") return "Only on this computer"
  if (category === "remote-only") return "Only on paired computer"
  if (category === "different") return "Different versions"
  if (category === "invalid-name") return "Invalid on Windows"
  return "Case-only collision"
}
