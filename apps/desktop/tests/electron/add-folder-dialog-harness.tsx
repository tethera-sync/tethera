import React from "react"
import ReactDOM from "react-dom/client"
import type { DirectoryListing, FolderMappingPreview, TetheraApi } from "../../src/shared/contracts"
import { AddFolderDialog } from "../../src/renderer/components/add-folder-dialog"

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

const preview: FolderMappingPreview = {
  localFiles: 1,
  remoteFiles: 1,
  identicalFiles: 1,
  differentFiles: 0,
  localOnlyFiles: 0,
  remoteOnlyFiles: 0,
  ignoredLocal: 0,
  ignoredRemote: 0,
  bytesToRemote: 0,
  bytesToLocal: 0,
  invalidWindowsNames: [],
  caseCollisions: [],
  truncated: false,
  samples: [],
}

let previewRequest: Deferred<FolderMappingPreview> | null = null
let approvalRequest: Deferred<unknown> | null = null
let previewCalls = 0
let approvalCalls = 0
let addedCalls = 0

function directoryListing(deviceId: string, deviceName: string, currentPath: string): DirectoryListing {
  return {
    deviceId,
    deviceName,
    currentPath,
    parentPath: null,
    separator: "/",
    entries: [],
    locations: [],
    readOnly: deviceId !== "local-device",
  }
}

const api = {
  browseDirectory: async ({ deviceId, path }: { deviceId: string; path?: string }) =>
    directoryListing(deviceId, deviceId === "local-device" ? "This computer" : "Paired computer", path ?? (deviceId === "local-device" ? "/local" : "/remote")),
  previewFolderMapping: async () => {
    previewCalls += 1
    previewRequest = deferred<FolderMappingPreview>()
    return previewRequest.promise
  },
  requestFolderMapping: async () => {
    approvalCalls += 1
    approvalRequest = deferred<unknown>()
    await approvalRequest.promise
    return {}
  },
  onPreviewProgress: () => () => undefined,
} as unknown as TetheraApi

window.folderSync = api

window.__dialogHarness = {
  get previewCalls() {
    return previewCalls
  },
  get approvalCalls() {
    return approvalCalls
  },
  get addedCalls() {
    return addedCalls
  },
  resolvePreview() {
    previewRequest?.resolve(preview)
  },
  rejectPreview(reason: string) {
    previewRequest?.reject(new Error(reason))
  },
  resolveApproval() {
    approvalRequest?.resolve(undefined)
  },
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <AddFolderDialog
    localDevice={{ id: "local-device", name: "This computer", platform: "linux", status: "this-device", route: "lan-direct" }}
    pairedDevice={{ id: "paired-device", name: "Paired computer", platform: "windows", status: "online", route: "lan-direct" }}
    onAdded={() => {
      addedCalls += 1
    }}
  />,
)

declare global {
  interface Window {
    __dialogHarness: {
      readonly previewCalls: number
      readonly approvalCalls: number
      readonly addedCalls: number
      resolvePreview: () => void
      rejectPreview: (reason: string) => void
      resolveApproval: () => void
    }
    runDialogRegression: () => Promise<DialogRegressionResult>
  }
}

interface DialogRegressionResult {
  previewPendingDismissalsBlocked: boolean
  rulesStayedDisabled: boolean
  rejectedCompareCanDismiss: boolean
  approvalPendingDismissalsBlocked: boolean
  resolvedApprovalClosed: boolean
  addedCalls: number
}

function visibleElements(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
    (element) => !element.hidden && element.getClientRects().length > 0,
  )
}

function visibleButton(label: string): HTMLButtonElement {
  const button = visibleElements("button").find((element): element is HTMLButtonElement => element.textContent?.replace(/\s+/g, " ").trim() === label)
  if (!button) {
    const labels = visibleElements("button").map((element) => `${element.textContent?.replace(/\s+/g, " ").trim()}${element.disabled ? " [disabled]" : ""}`).join(", ")
    const paths = visibleElements("input").map((element) => `${element.placeholder}=${element.value}`).join(", ")
    const rulesButton = visibleElements("button").find((element) => element.textContent?.includes("Rules and history"))
    throw new Error(`Visible button not found: ${label}; visible buttons: ${labels}; inputs: ${paths}; rules=${rulesButton?.outerHTML ?? "missing"}`)
  }
  return button
}

function hasVisibleButton(label: string): boolean {
  return visibleElements("button").some((element) => element.textContent?.replace(/\s+/g, " ").trim() === label)
}

function visibleDialogCount(): number {
  return visibleElements('[role="dialog"]').length
}

function hasVisibleText(text: string): boolean {
  return visibleElements("body").some((element) => element.textContent?.includes(text))
}

function clickElement(element: Element): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }))
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await settle()
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function clickBackdrop(): void {
  const backdrop = visibleElements("div").find((element) => {
    const className = typeof element.className === "string" ? element.className : ""
    return className.includes("fixed") && className.includes("bg-black/55")
  })
  if (!backdrop) throw new Error("Visible dialog backdrop not found")
  clickElement(backdrop)
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }))
}

async function chooseFolder(browseIndex: number): Promise<void> {
  visibleElements("button").filter((element) => element.textContent?.replace(/\s+/g, " ").trim() === "Browse")[browseIndex]?.click()
  await waitFor(() => visibleDialogCount() === 2, "folder picker to open")
  await waitFor(() => hasVisibleButton("Choose this folder"), "folder picker contents")
  clickElement(visibleButton("Choose this folder"))
  await waitFor(() => visibleDialogCount() === 1, "folder picker to close")
}

async function openRulesWithFolders(): Promise<void> {
  clickElement(visibleButton("Add folder"))
  await waitFor(() => visibleDialogCount() === 1, "add-folder dialog to open")
  await chooseFolder(0)
  await chooseFolder(1)
  clickElement(visibleButton("Rules and history"))
  await waitFor(() => hasVisibleButton("Review initial merge"), "rules step")
}

async function assertStillOpen(): Promise<void> {
  await settle()
  if (visibleDialogCount() !== 1) throw new Error("The add-folder dialog closed while comparison was pending")
}

window.runDialogRegression = async () => {
  await openRulesWithFolders()
  const select = visibleElements("select")[0] as HTMLSelectElement | undefined
  const patterns = visibleElements("textarea")[0] as HTMLTextAreaElement | undefined
  if (!select || !patterns) throw new Error("Rules controls were not rendered")

  clickElement(visibleButton("Review initial merge"))
  await waitFor(() => window.__dialogHarness.previewCalls === 1, "preview request to start")
  const originalMode = select.value
  const originalPatterns = patterns.value

  pressEscape()
  await assertStillOpen()
  clickBackdrop()
  await assertStillOpen()
  if (visibleElements("button").some((element) => element.textContent?.trim() === "Close")) {
    throw new Error("The explicit close button remained available during comparison")
  }
  const backButton = visibleButton("Back")
  if (!backButton.disabled) throw new Error("Back was enabled during comparison")
  const rulesControls = visibleElements("fieldset[disabled] input, fieldset[disabled] select, fieldset[disabled] textarea")
  const rulesFieldset = visibleElements("fieldset").find(
    (element): element is HTMLFieldSetElement => element instanceof HTMLFieldSetElement && element.disabled,
  )
  if (!rulesFieldset || rulesControls.length < 4) {
    throw new Error("Rules controls were not disabled during comparison")
  }
  if (select.value !== originalMode || patterns.value !== originalPatterns) {
    throw new Error("Rules controls changed during comparison")
  }
  const rulesStayedDisabled = rulesFieldset.disabled && rulesControls.length === 4

  const previewPendingDismissalsBlocked = visibleDialogCount() === 1
  window.__dialogHarness.rejectPreview("compare failed")
  await waitFor(() => hasVisibleText("compare failed") && !hasVisibleText("Comparing folders…"), "comparison rejection")
  clickElement(visibleButton("Back"))
  await waitFor(() => hasVisibleButton("Cancel"), "rejected comparison to allow navigation back")
  clickElement(visibleButton("Cancel"))
  await waitFor(() => visibleDialogCount() === 0, "rejected comparison to become dismissible")

  await openRulesWithFolders()
  clickElement(visibleButton("Review initial merge"))
  await waitFor(() => window.__dialogHarness.previewCalls === 2, "second preview request to start")
  window.__dialogHarness.resolvePreview()
  await waitFor(() => hasVisibleButton("Request approval"), "preview step")

  clickElement(visibleButton("Request approval"))
  await waitFor(() => window.__dialogHarness.approvalCalls === 1, "approval request to start")
  pressEscape()
  await assertStillOpen()
  clickBackdrop()
  await assertStillOpen()
  if (visibleElements("button").some((element) => element.textContent?.trim() === "Close")) {
    throw new Error("The explicit close button remained available during approval request")
  }
  if (!visibleButton("Back").disabled) throw new Error("Back was enabled during approval request")
  const approvalPendingDismissalsBlocked = visibleDialogCount() === 1

  window.__dialogHarness.resolveApproval()
  await waitFor(() => visibleDialogCount() === 0, "successful approval request to close the dialog")

  return {
    previewPendingDismissalsBlocked,
    rulesStayedDisabled,
    rejectedCompareCanDismiss: visibleDialogCount() === 0,
    approvalPendingDismissalsBlocked,
    resolvedApprovalClosed: visibleDialogCount() === 0,
    addedCalls,
  }
}

export {}
