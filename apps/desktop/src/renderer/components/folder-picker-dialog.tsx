import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from "react"
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  ComputerIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  HardDriveIcon,
  HomeIcon,
  MonitorIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react"
import type {
  DeviceSummary,
  DirectoryListing,
  DirectoryLocation,
} from "@shared/contracts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

interface FolderPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  device: DeviceSummary
  initialPath?: string
  title?: string
  description?: string
  onSelect: (path: string) => void
}

/**
 * Dialog for browsing and selecting folders on a device (local or remote), with navigation, search, hidden file toggle, and folder creation capabilities.
 */
export function FolderPickerDialog({
  open,
  onOpenChange,
  device,
  initialPath,
  title = "Choose a folder",
  description,
  onSelect,
}: FolderPickerDialogProps) {
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [query, setQuery] = useState("")
  const [includeHidden, setIncludeHidden] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState("")
  const newFolderInputId = useId()
  const requestGenerationRef = useRef(0)
  const createInFlightRef = useRef(false)
  const folderListRef = useRef<HTMLDivElement>(null)
  const lastBrowseRequestRef = useRef<{ path?: string; includeHidden: boolean }>({ includeHidden: false })

  async function loadDirectory(targetPath?: string, hidden = includeHidden, focusAfterLoad = false) {
    const requestGeneration = ++requestGenerationRef.current
    lastBrowseRequestRef.current = { path: targetPath, includeHidden: hidden }
    setLoading(true)
    setError(null)
    try {
      const next = await window.folderSync.browseDirectory({
        deviceId: device.id,
        path: targetPath,
        includeHidden: hidden,
      })
      if (requestGeneration !== requestGenerationRef.current) return
      setListing(next)
      if (focusAfterLoad) focusFolderList(requestGeneration)
    } catch (caught) {
      if (requestGeneration !== requestGenerationRef.current) return
      setError(caught instanceof Error ? caught.message : "Unable to open this folder.")
      focusFolderList(requestGeneration)
    } finally {
      if (requestGeneration === requestGenerationRef.current) setLoading(false)
    }
  }

  function focusFolderList(requestGeneration: number): void {
    requestAnimationFrame(() => {
      if (requestGeneration === requestGenerationRef.current) folderListRef.current?.focus()
    })
  }

  useEffect(() => {
    if (!open) return
    setListing(null)
    setQuery("")
    setError(null)
    setCreatingFolder(false)
    setNewFolderName("")
    void loadDirectory(initialPath, includeHidden)
    // Loading is intentionally reset whenever the dialog is opened for a device/path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => {
      requestGenerationRef.current += 1
    }
  }, [open, device.id, initialPath])

  const visibleEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return listing?.entries ?? []
    return (listing?.entries ?? []).filter((entry) => entry.name.toLocaleLowerCase().includes(normalizedQuery))
  }, [listing?.entries, query])

  const breadcrumbs = useMemo(
    () => (listing ? buildBreadcrumbs(listing.currentPath, listing.separator) : []),
    [listing],
  )

  async function toggleHidden() {
    const next = !includeHidden
    setIncludeHidden(next)
    await loadDirectory(listing?.currentPath ?? initialPath, next)
  }

  async function createFolder() {
    if (!listing || !newFolderName.trim() || createInFlightRef.current) return
    createInFlightRef.current = true
    const requestGeneration = ++requestGenerationRef.current
    setLoading(true)
    setError(null)
    try {
      const next = await window.folderSync.createDirectory({
        deviceId: device.id,
        parentPath: listing.currentPath,
        name: newFolderName.trim(),
      })
      if (requestGeneration !== requestGenerationRef.current) return
      const created = next.entries.find((entry) => entry.name === newFolderName.trim())
      setListing(next)
      setNewFolderName("")
      setCreatingFolder(false)
      if (created) await loadDirectory(created.path, includeHidden, true)
    } catch (caught) {
      if (requestGeneration !== requestGenerationRef.current) return
      setError(caught instanceof Error ? caught.message : "Unable to create the folder.")
    } finally {
      createInFlightRef.current = false
      if (requestGeneration === requestGenerationRef.current) setLoading(false)
    }
  }

  function chooseFolder() {
    if (!listing || loading) return
    onSelect(listing.currentPath)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="folder-picker-dialog w-[min(980px,calc(100vw-36px))] max-w-[980px] p-5">
        <DialogHeader>
          <div className="folder-picker-title-row [display:flex] [align-items:flex-start] [gap:12px]">
            <div className="folder-picker-device-icon [display:grid] [width:38px] [height:38px] [flex:0_0_auto] [place-items:center] [border-radius:11px] [background:color-mix(in_oklab,_var(--primary)_12%,_var(--surface-strong))] [color:var(--primary)] [&_svg]:[width:18px] [&_svg]:[height:18px]">
              {device.id === "local-device" ? <MonitorIcon /> : <ComputerIcon />}
            </div>
            <div>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>
                {description ?? `Browsing folders on ${device.name}. Only the selected folder and its subfolders will be synced.`}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="folder-picker-shell [display:grid] [grid-template-columns:178px_minmax(0,_1fr)] [height:min(520px,_calc(100vh_-_245px))] [min-height:390px] [overflow:hidden] [margin-top:18px] [border:1px_solid_var(--border)] [border-radius:14px] [background:var(--surface-sunken)] max-[760px]:[grid-template-columns:1fr]">
          <aside className="folder-picker-sidebar [overflow-y:auto] [border-right:1px_solid_var(--border)] [background:color-mix(in_oklab,_var(--surface)_60%,_transparent)] [padding:13px_10px] max-[760px]:[display:none]" aria-label="Folder locations">
            <p className="folder-picker-section-label [margin:0_8px_8px] [color:var(--muted-foreground)] [font-size:9px] [font-weight:700] [letter-spacing:0.1em] [text-transform:uppercase]">Locations</p>
            <div className="folder-location-list [display:grid] [gap:2px]">
              {(listing?.locations ?? []).map((location) => {
                const Icon = locationIcon(location)
                const active = listing?.currentPath === location.path
                return (
                  <Button
                    variant="ghost"
                    key={location.id}
                    type="button"
                    className={cn("folder-location flex w-full h-[34px] items-center [gap:9px] rounded-[8px] border-0 bg-transparent px-[9px] py-0 [color:var(--muted-foreground)] text-[11.5px] text-left [&:hover]:[background:var(--accent)] [&:hover]:[color:var(--foreground)] [&_svg]:[width:15px] [&_svg]:[height:15px] [&_svg]:[flex:0_0_auto] [&_span]:[overflow:hidden] [&_span]:[text-overflow:ellipsis] [&_span]:[white-space:nowrap]", active && "folder-location-active [background:color-mix(in_oklab,_var(--primary)_13%,_transparent)] [color:var(--primary)]")}
                    disabled={loading}
                    onClick={() => void loadDirectory(location.path, includeHidden, true)}
                  >
                    <Icon />
                    <span title={location.path}>{location.label}</span>
                  </Button>
                )
              })}
            </div>
          </aside>

          <section className="folder-picker-main [display:grid] [min-width:0] [min-height:0] [grid-template-rows:auto_auto_auto_minmax(0,_1fr)]">
            <div className="folder-picker-toolbar [display:flex] [min-width:0] [align-items:center] [gap:6px] [border-bottom:1px_solid_var(--border)] [padding:8px_10px] [background:var(--surface)]">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Go to parent folder"
                disabled={!listing?.parentPath || loading}
                    onClick={() => void loadDirectory(listing?.parentPath ?? undefined, includeHidden, true)}
              >
                <ArrowLeftIcon />
              </Button>

              <div className="folder-breadcrumbs [display:flex] [min-width:0] [flex:1] [align-items:center] [overflow-x:auto] [scrollbar-width:none] [&::-webkit-scrollbar]:[display:none]" aria-label="Current folder path">
                {breadcrumbs.map((crumb, index) => (
                  <div key={crumb.path} className="folder-breadcrumb-segment [display:flex] [flex:0_0_auto] [align-items:center] [&>svg]:[width:13px] [&>svg]:[height:13px] [&>svg]:[color:var(--muted-foreground)] [&_button]:[max-width:150px] [&_button]:[overflow:hidden] [&_button]:[text-overflow:ellipsis] [&_button]:[white-space:nowrap] [&_button:hover]:[background:var(--accent)]">
                    {index > 0 ? <ChevronRightIcon /> : null}
                    <Button variant="ghost" size="xs" className="rounded-[6px] border-0 bg-transparent px-[7px] py-[5px] text-[11px] font-[550]" type="button" title={crumb.path} disabled={loading} onClick={() => void loadDirectory(crumb.path, includeHidden, true)}>
                      {crumb.label}
                    </Button>
                  </div>
                ))}
              </div>

              <Button
                variant="ghost"
                size="icon"
                aria-label="Refresh folder"
                disabled={!listing || loading}
                onClick={() => void loadDirectory(listing?.currentPath)}
              >
                <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
              </Button>
            </div>

            <div className="folder-picker-actions [display:flex] [align-items:center] [gap:8px] [border-bottom:1px_solid_var(--border)] [padding:9px_11px] [background:color-mix(in_oklab,_var(--surface)_45%,_transparent)] max-[760px]:[flex-wrap:wrap]">
              <label className="folder-search [display:flex] [min-width:180px] [flex:1] [align-items:center] [gap:8px] [border:1px_solid_var(--input)] [border-radius:9px] [background:var(--surface-sunken)] [padding:0_10px] [&:focus-within]:[border-color:var(--ring)] [&:focus-within]:[box-shadow:0_0_0_3px_color-mix(in_oklab,_var(--ring)_16%,_transparent)] [&_svg]:[width:14px] [&_svg]:[height:14px] [&_svg]:[color:var(--muted-foreground)] [&_input]:[width:100%] [&_input]:[height:32px] [&_input]:[border:0] [&_input]:[outline:0] [&_input]:[background:transparent] [&_input]:[font-size:11.5px] [&_input]:[color:var(--foreground)] max-[760px]:[min-width:100%]">
                <SearchIcon />
                <Input
                  aria-label="Search folders"
                  className="w-full border-0 bg-transparent outline-none"
                  value={query}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
                  placeholder="Filter folders in this location"
                />
              </label>
              {!listing?.readOnly ? (
                <Button variant="outline" size="sm" onClick={() => setCreatingFolder((value) => !value)} disabled={!listing || loading}>
                  <FolderPlusIcon data-icon="inline-start" />
                  New folder
                </Button>
              ) : null}
              <Button variant="outline" size="sm" onClick={() => void toggleHidden()} disabled={!listing || loading}>
                {includeHidden ? <EyeOffIcon data-icon="inline-start" /> : <EyeIcon data-icon="inline-start" />}
                {includeHidden ? "Hide hidden" : "Show hidden"}
              </Button>
            </div>

            {creatingFolder ? (
              <div className="new-folder-row [display:flex] [align-items:center] [gap:8px] [border-bottom:1px_solid_var(--border)] [background:color-mix(in_oklab,_var(--primary)_6%,_var(--surface))] [padding:8px_11px] [&>svg]:[width:16px] [&>svg]:[height:16px] [&>svg]:[color:var(--primary)]">
                <FolderPlusIcon />
                <label htmlFor={newFolderInputId} className="sr-only">New folder name</label>
                <Input
                  id={newFolderInputId}
                  autoFocus
                  className="min-w-0 flex-1"
                  disabled={loading}
                  value={newFolderName}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setNewFolderName(event.target.value)}
                  placeholder="New folder name"
                  onKeyDown={(event: { key: string }) => {
                    if (event.key === "Enter") void createFolder()
                    if (event.key === "Escape") setCreatingFolder(false)
                  }}
                />
                <Button size="sm" disabled={!newFolderName.trim() || loading} onClick={() => void createFolder()}>
                  Create
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setCreatingFolder(false)}>
                  Cancel
                </Button>
              </div>
            ) : null}

            <span className="sr-only" role="status" aria-live="polite">
              {loading
                ? "Opening folder…"
                : error
                  ? `Could not open folder. ${error}`
                  : listing
                    ? `Opened ${breadcrumbs.at(-1)?.label ?? "folder"}.`
                    : ""}
            </span>
            <div
              ref={folderListRef}
              className="folder-picker-list [min-height:0] [overflow-y:auto] [padding:7px]"
              role="navigation"
              aria-label="Folders"
              aria-busy={loading}
              tabIndex={-1}
            >
              {loading && !listing ? (
                <div className="folder-picker-message [display:flex] [min-height:190px] [flex-direction:column] [align-items:center] [justify-content:center] [gap:7px] [padding:24px] [color:var(--muted-foreground)] [text-align:center] [&>svg]:[width:23px] [&>svg]:[height:23px] [&_strong]:[color:var(--foreground)] [&_strong]:[font-size:12px] [&_span]:[max-width:54ch] [&_span]:[font-size:11px] [&_span]:[line-height:1.45]">
                  <RefreshCwIcon className="animate-spin" />
                  <span>Opening folder…</span>
                </div>
              ) : null}

              {!loading && error ? (
                <div className="folder-picker-error [display:flex] [min-height:190px] [flex-direction:column] [align-items:center] [justify-content:center] [gap:7px] [padding:24px] [color:var(--muted-foreground)] [text-align:center] [&>svg]:[width:23px] [&>svg]:[height:23px] [&_strong]:[color:var(--foreground)] [&_strong]:[font-size:12px] [&_span]:[max-width:54ch] [&_span]:[font-size:11px] [&_span]:[line-height:1.45]">
                  <strong>Couldn’t open this location</strong>
                  <span>{error}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const request = lastBrowseRequestRef.current
                      void loadDirectory(request.path, request.includeHidden, true)
                    }}
                  >
                    Try again
                  </Button>
                </div>
              ) : null}

              {!loading && !error && visibleEntries.length === 0 ? (
                <div className="folder-picker-message [display:flex] [min-height:190px] [flex-direction:column] [align-items:center] [justify-content:center] [gap:7px] [padding:24px] [color:var(--muted-foreground)] [text-align:center] [&>svg]:[width:23px] [&>svg]:[height:23px] [&_strong]:[color:var(--foreground)] [&_strong]:[font-size:12px] [&_span]:[max-width:54ch] [&_span]:[font-size:11px] [&_span]:[line-height:1.45]">
                  <FolderOpenIcon />
                  <strong>{query ? "No matching folders" : "This folder has no subfolders"}</strong>
                  <span>{query ? "Try a different search." : listing?.readOnly ? "You can choose the current folder." : "You can choose the current folder or create a new one."}</span>
                </div>
              ) : null}

              {!error
                ? visibleEntries.map((entry) => (
                    <Button
                      variant="ghost"
                      key={entry.path}
                      type="button"
                      className="folder-picker-entry grid w-full h-auto [grid-template-columns:auto_minmax(0,_1fr)_auto] items-center [gap:10px] border border-transparent rounded-[10px] bg-transparent px-[9px] py-2 text-left [&:hover]:[background:var(--accent)] [&_strong]:[display:block] [&_strong]:[overflow:hidden] [&_strong]:[font-size:11.5px] [&_strong]:[text-overflow:ellipsis] [&_strong]:[white-space:nowrap] [&_span]:[display:block] [&_span]:[margin-top:2px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:9.5px] [&>svg]:[width:14px] [&>svg]:[height:14px] [&>svg]:[color:var(--muted-foreground)]"
                      disabled={loading}
                      onClick={() => void loadDirectory(entry.path, includeHidden, true)}
                    >
                      <div className="folder-entry-icon [display:grid] [width:30px] [height:30px] [place-items:center] [border-radius:8px] [background:var(--secondary)] [color:var(--primary)] [&_svg]:[width:15px] [&_svg]:[height:15px]">
                        <FolderIcon />
                      </div>
                      <div>
                        <strong>{entry.name}</strong>
                        <span>{entry.kind === "symlink" ? "Linked folder" : "Folder"}</span>
                      </div>
                      <ChevronRightIcon />
                    </Button>
                  ))
                : null}
            </div>
          </section>
        </div>

        <div className="folder-picker-selection [display:flex] [min-width:0] [align-items:center] [gap:10px] [margin-top:12px] [border:1px_solid_var(--border)] [border-radius:var(--radius-tile)] [background:var(--surface-sunken)] [padding:9px_11px] [&>svg]:[width:17px] [&>svg]:[height:17px] [&>svg]:[flex:0_0_auto] [&>svg]:[color:var(--primary)] [&>div]:[min-width:0] [&_span]:[display:block] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:9px] [&_span]:[text-transform:uppercase] [&_span]:[letter-spacing:0.07em] [&_code]:[display:block] [&_code]:[overflow:hidden] [&_code]:[margin-top:2px] [&_code]:[font-size:10.5px] [&_code]:[text-overflow:ellipsis] [&_code]:[white-space:nowrap]">
          <FolderOpenIcon />
          <div>
            <span>Current folder</span>
            <code title={listing?.currentPath}>{listing?.currentPath ?? "Loading…"}</code>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!listing || Boolean(error) || loading} onClick={chooseFolder}>
            Choose this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function locationIcon(location: DirectoryLocation) {
  if (location.kind === "home") return HomeIcon
  if (location.kind === "desktop") return MonitorIcon
  if (location.kind === "documents") return FileTextIcon
  if (location.kind === "downloads") return DownloadIcon
  if (location.kind === "drive" || location.kind === "mount") return HardDriveIcon
  return ComputerIcon
}

export function buildBreadcrumbs(currentPath: string, separator: "/" | "\\"): Array<{ label: string; path: string }> {
  if (separator === "/") {
    const parts = currentPath.split("/").filter(Boolean)
    const crumbs = [{ label: "Computer", path: "/" }]
    let cumulative = ""
    for (const part of parts) {
      cumulative += `/${part}`
      crumbs.push({ label: part, path: cumulative })
    }
    return crumbs
  }

  const normalized = currentPath.replaceAll("/", "\\")
  const parts = normalized.split("\\").filter(Boolean)
  if (parts.length === 0) return [{ label: normalized, path: normalized }]

  if (normalized.startsWith("\\\\")) {
    if (parts.length < 2) return [{ label: normalized, path: normalized }]
    let cumulative = `\\\\${parts[0]}\\${parts[1]}\\`
    const crumbs = [{ label: cumulative.slice(0, -1), path: cumulative }]
    for (const part of parts.slice(2)) {
      cumulative = `${cumulative}${part}\\`
      crumbs.push({ label: part, path: cumulative })
    }
    return crumbs
  }

  const root = `${parts[0]}\\`
  const crumbs = [{ label: parts[0], path: root }]
  let cumulative = root
  for (const part of parts.slice(1)) {
    cumulative = `${cumulative}${part}\\`
    crumbs.push({ label: part, path: cumulative })
  }
  return crumbs
}
