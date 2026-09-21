import { compareAppVersions } from "@shared/app-version"
import type { DeviceSummary, PeerAppStatus } from "@shared/contracts"

type ReportedApp = Extract<PeerAppStatus, { kind: "reported" }>

/** What a paired computer's card says about updating its Tethera from this computer. */
export type PeerUpdateView =
  | { kind: "none" }
  /** Its Tethera predates remote updates, so it has to be updated on that computer once. */
  | { kind: "legacy" }
  /**
   * `release`: that computer found release `to` itself. `behind`: `to` is this
   * computer's version, and that computer has not seen a newer release yet.
   */
  | { kind: "offer"; action: "update" | "install"; reason: "release" | "behind"; from: string; to: string; needsApproval: boolean }
  | { kind: "checking" }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "restarting" }
  /** Downloaded there, waiting for someone at that computer to approve the install. */
  | { kind: "needs-approval"; version: string }
  | { kind: "failed"; message: string; canRetry: boolean }

export function peerUpdateView(device: DeviceSummary, localVersion: string | undefined): PeerUpdateView {
  const { app, appUpdate } = device
  if (!app) return { kind: "none" }
  if (app.kind === "legacy") return { kind: "legacy" }
  if (appUpdate?.status === "restarting") return { kind: "restarting" }
  if (appUpdate?.status === "updating") {
    return app.update.status === "downloading"
      ? { kind: "downloading", version: app.update.version, percent: app.update.progressPercent }
      : { kind: "checking" }
  }
  if (app.update.status === "downloaded" && app.install === "needs-approval") {
    return { kind: "needs-approval", version: app.update.version }
  }
  const offer = peerUpdateOffer(app, localVersion)
  if (appUpdate?.status === "failed") return { kind: "failed", message: appUpdate.message, canRetry: offer !== undefined }
  return offer ?? { kind: "none" }
}

/** An update is worth offering when that computer found a newer release itself, or is behind this computer. */
function peerUpdateOffer(app: ReportedApp, localVersion: string | undefined): Extract<PeerUpdateView, { kind: "offer" }> | undefined {
  if (app.install === "unsupported") return undefined
  const base = { from: app.version, needsApproval: app.install === "needs-approval" }
  const { update } = app
  if (update.status === "downloaded") return { kind: "offer", action: "install", reason: "release", to: update.version, ...base }
  if (update.status === "available") return { kind: "offer", action: "update", reason: "release", to: update.version, ...base }
  if (localVersion === undefined || (compareAppVersions(app.version, localVersion) ?? 0) >= 0) return undefined
  return { kind: "offer", action: "update", reason: "behind", to: localVersion, ...base }
}

/** Whether the Devices view has an update for the user to act on: one to start here, or one to do on that computer. */
export function peerNeedsUpdate(view: PeerUpdateView): boolean {
  return view.kind === "offer" || view.kind === "legacy"
}

export function deviceVersionLabel(device: DeviceSummary, localVersion: string | undefined): string {
  if (device.status === "this-device") return localVersion ? `v${localVersion}` : "Unknown"
  const { app } = device
  if (!app) return "Not known yet"
  return app.kind === "legacy" ? "Older version" : `v${app.version}`
}
