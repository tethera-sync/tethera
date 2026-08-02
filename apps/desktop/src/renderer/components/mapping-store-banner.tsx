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
      <div className="mapping-store-banner mapping-store-banner-loading" role="status">
        <RefreshCwIcon className="animate-spin" />
        <div><strong>Loading folder configuration</strong><span>Reading the authoritative mapping database…</span></div>
      </div>
    )
  }

  if (state.status === "ready") {
    return (
      <div className="mapping-store-banner" role="status">
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
    <div className="mapping-store-banner mapping-store-banner-warning" role="alert">
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
