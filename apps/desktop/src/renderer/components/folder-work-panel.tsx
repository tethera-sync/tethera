import { CheckIcon, RefreshCwIcon } from "lucide-react"
import type { FolderScanCounts, FolderWork, FolderWorkActivity } from "@shared/contracts"
import { Meter } from "@/components/ui/meter"
import { formatElapsed, scanStageLabel } from "@/lib/compare-progress"
import {
  copyProgress,
  folderWorkDetail,
  folderWorkHeadline,
  initialMergeSteps,
  scanCountsText,
  useSecondsSince,
  type ComputerNames,
  type InitialMergeStepView,
} from "@/lib/folder-work"

/** Live view of a running folder operation: the merge step, what is being scanned or copied, and how far it has got. */
export function FolderWorkPanel({ work, currentAction, names }: { work: FolderWork; currentAction?: string; names: ComputerNames }) {
  const elapsed = formatElapsed(useSecondsSince(work.startedAt))
  const { activity } = work
  const detail = folderWorkDetail(activity, currentAction)
  return (
    <section
      aria-label="Progress"
      className="mx-[15px] mt-3 grid gap-3 rounded-[10px] border border-[color-mix(in_oklab,var(--primary)_24%,var(--border))] bg-[color-mix(in_oklab,var(--primary)_6%,var(--surface))] p-3"
    >
      {work.initialMerge ? <InitialMergeStepList steps={initialMergeSteps(work.initialMerge, names)} /> : null}
      <div className="flex items-start gap-2.5">
        <RefreshCwIcon aria-hidden="true" className="mt-px size-4 shrink-0 animate-spin text-[var(--primary)] motion-reduce:animate-none" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <strong role="status" className="text-[11.5px] font-semibold">{folderWorkHeadline(activity, names)}</strong>
            <span className="shrink-0 text-[10px] tabular-nums text-[var(--muted-foreground)]">{elapsed} elapsed</span>
          </div>
          {detail ? <p className="mt-0.5 text-[10.5px] leading-normal text-[var(--muted-foreground)] [overflow-wrap:anywhere]">{detail}</p> : null}
        </div>
      </div>
      {activity.kind === "scanning" ? (
        <div className="grid grid-cols-2 gap-2 max-[520px]:grid-cols-1">
          <ScanSide name={names.thisComputer} counts={activity.local} currentPath={activity.local?.currentPath} />
          <ScanSide name={names.otherComputer} counts={activity.remote} />
        </div>
      ) : null}
      {activity.kind === "copying" ? <CopyProgress activity={activity} /> : null}
    </section>
  )
}

function InitialMergeStepList({ steps }: { steps: InitialMergeStepView[] }) {
  return (
    <ol aria-label="Initial merge steps" className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-[color-mix(in_oklab,var(--border)_70%,transparent)] pb-2.5">
      {steps.map((step, index) => (
        <li
          key={`${index}:${step.label}`}
          aria-current={step.state === "active" ? "step" : undefined}
          data-state={step.state}
          className="flex items-center gap-1.5 text-[10.5px] font-medium text-[var(--muted-foreground)] data-[state=active]:text-[var(--foreground)]"
        >
          <span
            data-state={step.state}
            className="grid size-4 place-items-center rounded-full border border-[var(--border)] text-[9px] font-bold data-[state=active]:border-[var(--primary)] data-[state=active]:bg-[var(--primary)] data-[state=active]:text-[var(--primary-foreground)] data-[state=done]:border-transparent data-[state=done]:bg-[color-mix(in_oklab,var(--success)_16%,transparent)] data-[state=done]:text-[var(--success)]"
          >
            {step.state === "done" ? <CheckIcon aria-hidden="true" className="size-2.5" /> : index + 1}
          </span>
          {step.label}
          {step.state === "done" ? <span className="sr-only"> (done)</span> : null}
        </li>
      ))}
    </ol>
  )
}

function ScanSide({ name, counts, currentPath }: { name: string; counts?: FolderScanCounts; currentPath?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2">
      <span className="block truncate text-[9px] font-bold tracking-[0.04em] text-[var(--muted-foreground)] uppercase">{name}</span>
      {counts ? (
        <>
          <strong className="mt-1 flex items-center gap-1 text-[11px] font-semibold">
            {counts.stage === "complete" ? <CheckIcon aria-hidden="true" className="size-3 text-[var(--success)]" /> : null}
            {scanStageLabel(counts.stage)}
          </strong>
          <p className="mt-0.5 text-[10px] tabular-nums text-[var(--muted-foreground)]">{scanCountsText(counts)}</p>
          <p className="text-[10px] tabular-nums text-[var(--muted-foreground)]">
            {counts.ignoredEntries.toLocaleString("en-GB")} excluded
            {counts.unreadableEntries > 0 ? (
              <span className="text-[var(--warning)]"> · {counts.unreadableEntries.toLocaleString("en-GB")} unreadable</span>
            ) : null}
          </p>
          {currentPath && counts.stage !== "complete" ? (
            <code className="mt-1 block truncate font-mono text-[10px]" title={currentPath}>{currentPath}</code>
          ) : null}
        </>
      ) : (
        <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">Scanning. Live counts have not arrived yet.</p>
      )}
    </div>
  )
}

function CopyProgress({ activity }: { activity: Extract<FolderWorkActivity, { kind: "copying" }> }) {
  const { fraction, readout, detail } = copyProgress(activity)
  return (
    <div className="grid gap-1.5">
      <Meter label={detail} value={fraction} readout={readout} />
      <code className="block truncate font-mono text-[10px] text-[var(--muted-foreground)]" title={activity.path}>{activity.path}</code>
    </div>
  )
}
