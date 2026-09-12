import { RefreshCwIcon } from "lucide-react"
import type { FolderScanActivity } from "@shared/contracts"
import { comparePhaseText, type ComparePhase } from "@/lib/compare-progress"

/**
 * Live status for a running folder comparison. Rendered while the main
 * process scans both computers; driven by `folders:preview-progress` events,
 * an elapsed timer, and nothing else, so it never claims more than is known.
 */
export function CompareStatus({
  phase,
  purpose,
  thisComputer,
  otherComputer,
  scannedFiles,
  activity,
  elapsed,
  reused = false,
}: {
  phase: ComparePhase | null
  /** "review" for a fresh comparison, "verify" for the pre-approval re-scan. */
  purpose: "review" | "verify"
  thisComputer: string
  otherComputer: string
  scannedFiles?: number
  activity?: FolderScanActivity
  elapsed: string
  /** True when the main process reused saved scans instead of walking again. */
  reused?: boolean
}) {
  const text = comparePhaseText(phase, { thisComputer, otherComputer, scannedFiles, activity, elapsed, reused })
  return (
    <div
      className="compare-status [display:flex] [align-items:flex-start] [gap:10px] [margin-top:14px] [border:1px_solid_color-mix(in_oklab,_var(--primary)_30%,_var(--border))] [border-radius:10px] [background:color-mix(in_oklab,_var(--primary)_8%,_var(--surface))] [padding:11px_12px] [&>svg]:[width:17px] [&>svg]:[height:17px] [&>svg]:[flex:0_0_auto] [&>svg]:[margin-top:1px] [&>svg]:[color:var(--primary)] [&>div]:[display:grid] [&>div]:[gap:2px] [&_strong]:[font-size:11px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:10px] [&_span]:[line-height:1.5]"
      role="status"
    >
      <RefreshCwIcon className="animate-spin motion-reduce:animate-none" />
      <div className="min-w-0 flex-1">
        <strong>{text.headline}</strong>
        <span>
          {purpose === "verify" && !reused ? "Verifying both folders before approval. " : ""}
          {text.detail}
        </span>
        {(phase === "scan-local" || phase === "scan-remote") && activity?.currentPath ? <code className="block truncate text-xs" title={activity.currentPath}>{activity.currentPath}</code> : null}
      </div>
    </div>
  )
}
