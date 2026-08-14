import { useState } from "react"
import { CircleAlertIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react"
import type { MappingStoreState } from "@shared/contracts"
import { Button } from "./ui/button"

export function MappingStoreBanner({ state }: { state: MappingStoreState }) {
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)

  if (state.status === "ready" && !state.cleanupWarning && state.pendingDeliveryCount === 0) return null

  async function retry() {
    if (retrying) return
    setRetrying(true)
    setRetryError(null)
    try {
      await window.folderSync.retryMappingStore()
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : "The mapping database retry failed.")
    } finally {
      setRetrying(false)
    }
  }

  if (state.status === "loading") {
    return (
      <div className="mapping-store-banner [display:flex] [min-height:48px] [flex:0_0_auto] [align-items:center] [gap:11px] [margin:10px_24px_0] [padding:11px_13px] [border:1px_solid_color-mix(in_oklab,_var(--primary)_24%,_var(--border))] [border-radius:10px] [background:color-mix(in_oklab,_var(--primary)_7%,_var(--surface))] [&>svg]:[width:17px] [&>svg]:[height:17px] [&>svg]:[flex:0_0_auto] [&>svg]:[color:var(--primary)] [&>div]:[min-width:0] [&>div]:[flex:1] [&_strong]:[display:block] [&_span]:[display:block] [&_strong]:[font-size:11.5px] [&_strong]:[font-weight:650] [&_span]:[margin-top:2px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:10.5px] [&_span]:[line-height:1.4] mapping-store-banner-loading [color:var(--muted-foreground)]" role="status">
        <RefreshCwIcon className="animate-spin" />
        <div><strong>Loading folder configuration</strong><span>Reading the authoritative mapping database…</span></div>
      </div>
    )
  }

  if (state.status === "ready") {
    return (
      <div className="mapping-store-banner [display:flex] [min-height:48px] [flex:0_0_auto] [align-items:center] [gap:11px] [margin:10px_24px_0] [padding:11px_13px] [border:1px_solid_color-mix(in_oklab,_var(--primary)_24%,_var(--border))] [border-radius:10px] [background:color-mix(in_oklab,_var(--primary)_7%,_var(--surface))] [&>svg]:[width:17px] [&>svg]:[height:17px] [&>svg]:[flex:0_0_auto] [&>svg]:[color:var(--primary)] [&>div]:[min-width:0] [&>div]:[flex:1] [&_strong]:[display:block] [&_span]:[display:block] [&_strong]:[font-size:11.5px] [&_strong]:[font-weight:650] [&_span]:[margin-top:2px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:10.5px] [&_span]:[line-height:1.4]" role="status">
        <ShieldCheckIcon />
        <div>
          <strong>{state.pendingDeliveryCount > 0 ? "Configuration delivery pending" : "Mapping database ready"}</strong>
          <span>
            {state.cleanupWarning ??
              `${state.pendingDeliveryCount} configuration update${state.pendingDeliveryCount === 1 ? " is" : "s are"} waiting for an authenticated peer acknowledgement.`}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="mapping-store-banner [display:flex] [min-height:48px] [flex:0_0_auto] [align-items:center] [gap:11px] [margin:10px_24px_0] [padding:11px_13px] [border:1px_solid_color-mix(in_oklab,_var(--primary)_24%,_var(--border))] [border-radius:10px] [background:color-mix(in_oklab,_var(--primary)_7%,_var(--surface))] [&>svg]:[width:17px] [&>svg]:[height:17px] [&>svg]:[flex:0_0_auto] [&>svg]:[color:var(--primary)] [&>div]:[min-width:0] [&>div]:[flex:1] [&_strong]:[display:block] [&_span]:[display:block] [&_strong]:[font-size:11.5px] [&_strong]:[font-weight:650] [&_span]:[margin-top:2px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:10.5px] [&_span]:[line-height:1.4] mapping-store-banner-warning [border-color:color-mix(in_oklab,_var(--warning)_38%,_var(--border))] [background:color-mix(in_oklab,_var(--warning)_9%,_var(--surface))] [&>svg]:[color:var(--warning)]" role="alert">
      <CircleAlertIcon />
      <div>
        <strong>{warningTitle(state.status)}</strong>
        <span>{retryError ?? state.detail ?? "Mapping changes are disabled so existing configuration cannot be overwritten."}</span>
      </div>
      <Button size="sm" variant="outline" onClick={retry} disabled={retrying}>
        <RefreshCwIcon className={retrying ? "animate-spin" : undefined} data-icon="inline-start" />
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
  )
}

function warningTitle(status: MappingStoreState["status"]): string {
  if (status === "unsupported-schema") return "This mapping database needs a newer Tethera build"
  if (status === "migration-failed") return "Legacy mapping migration needs attention"
  if (status === "migration-required") return "Folder mappings are waiting to migrate"
  return "Mapping database unavailable"
}
