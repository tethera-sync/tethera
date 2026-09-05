import { RefreshCwIcon } from "lucide-react"
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
  elapsed,
}: {
  phase: ComparePhase | null
  /** "review" for a fresh comparison, "verify" for the pre-approval re-scan. */
  purpose: "review" | "verify"
  thisComputer: string
  otherComputer: string
  scannedFiles?: number
  elapsed: string
}) {
  const text = comparePhaseText(phase, { thisComputer, otherComputer, scannedFiles, elapsed })
  return (
    <div
      className="compare-status [display:flex] [align-items:flex-start] [gap:10px] [margin-top:14px] [border:1px_solid_color-mix(in_oklab,_var(--primary)_30%,_var(--border))] [border-radius:10px] [background:color-mix(in_oklab,_var(--primary)_8%,_var(--surface))] [padding:11px_12px] [&>svg]:[width:17px] [&>svg]:[height:17px] [&>svg]:[flex:0_0_auto] [&>svg]:[margin-top:1px] [&>svg]:[color:var(--primary)] [&>div]:[display:grid] [&>div]:[gap:2px] [&_strong]:[font-size:11px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:10px] [&_span]:[line-height:1.5]"
      role="status"
    >
      <RefreshCwIcon className="animate-spin" />
      <div>
        <strong>{text.headline}</strong>
        <span>
          {purpose === "verify" ? "Verifying both folders before approval. " : ""}
          {text.detail}
        </span>
      </div>
    </div>
  )
}
