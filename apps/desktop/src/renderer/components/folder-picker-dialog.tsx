import { useEffect, useMemo, useState, type ChangeEvent } from "react"
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
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [includeHidden, setIncludeHidden] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState("")

  async function loadDirectory(targetPath?: string, hidden = includeHidden) {
    setLoading(true)
    setError(null)
    setSelectedPath(null)
    try {
      const next = await window.folderSync.browseDirectory({
        deviceId: device.id,
        path: targetPath,
        includeHidden: hidden,
      })
      setListing(next)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to open this folder.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setListing(null)
    setSelectedPath(null)
    setQuery("")
    setError(null)
    setCreatingFolder(false)
    setNewFolderName("")
    void loadDirectory(initialPath, includeHidden)
    // Loading is intentionally reset whenever the dialog is opened for a device/path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (!listing || !newFolderName.trim()) return
    setLoading(true)
    setError(null)
    try {
      const next = await window.folderSync.createDirectory({
        deviceId: device.id,
        parentPath: listing.currentPath,
        name: newFolderName.trim(),
      })
      setListing(next)
      const created = next.entries.find((entry) => entry.name === newFolderName.trim())
      setSelectedPath(created?.path ?? null)
      setNewFolderName("")
      setCreatingFolder(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create the folder.")
    } finally {
      setLoading(false)
    }
  }

  function chooseFolder() {
    if (!listing) return
    onSelect(selectedPath ?? listing.currentPath)
    onOpenChange(false)
  }

  const selectedLabel = selectedPath ? "Choose selected folder" : "Choose this folder"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="folder-picker-dialog">
        <DialogHeader>
          <div className="folder-picker-title-row">
            <div className="folder-picker-device-icon">
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

        <div className="folder-picker-shell">
          <aside className="folder-picker-sidebar" aria-label="Folder locations">
            <p className="folder-picker-section-label">Locations</p>
            <div className="folder-location-list">
              {(listing?.locations ?? []).map((location) => {
                const Icon = locationIcon(location)
                const active = listing?.currentPath === location.path
                return (
                  <button
                    key={location.id}
                    type="button"
                    className={cn("folder-location", active && "folder-location-active")}
                    onClick={() => void loadDirectory(location.path)}
                  >
                    <Icon />
                    <span title={location.path}>{location.label}</span>
                  </button>
                )
              })}
            </div>
          </aside>

          <section className="folder-picker-main">
            <div className="folder-picker-toolbar">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Go to parent folder"
                disabled={!listing?.parentPath || loading}
                onClick={() => void loadDirectory(listing?.parentPath ?? undefined)}
              >
                <ArrowLeftIcon />
              </Button>

              <div className="folder-breadcrumbs" aria-label="Current folder path">
                {breadcrumbs.map((crumb, index) => (
                  <div key={crumb.path} className="folder-breadcrumb-segment">
                    {index > 0 ? <ChevronRightIcon /> : null}
                    <button type="button" title={crumb.path} onClick={() => void loadDirectory(crumb.path)}>
                      {crumb.label}
                    </button>
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

            <div className="folder-picker-actions">
              <label className="folder-search">
                <SearchIcon />
                <input
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
              <div className="new-folder-row">
                <FolderPlusIcon />
                <input
                  autoFocus
                  className="field-control"
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

            <div className="folder-picker-list" role="listbox" aria-label="Folders">
              {loading && !listing ? (
                <div className="folder-picker-message">
                  <RefreshCwIcon className="animate-spin" />
                  <span>Opening folder…</span>
                </div>
              ) : null}

              {!loading && error ? (
                <div className="folder-picker-error">
                  <strong>Couldn’t open this location</strong>
                  <span>{error}</span>
                  {listing ? (
                    <Button variant="outline" size="sm" onClick={() => void loadDirectory(listing.currentPath)}>
                      Try again
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {!loading && !error && visibleEntries.length === 0 ? (
                <div className="folder-picker-message">
                  <FolderOpenIcon />
                  <strong>{query ? "No matching folders" : "This folder has no subfolders"}</strong>
                  <span>{query ? "Try a different search." : listing?.readOnly ? "You can choose the current folder." : "You can choose the current folder or create a new one."}</span>
                </div>
              ) : null}

              {!error
                ? visibleEntries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      role="option"
                      aria-selected={selectedPath === entry.path}
                      className={cn("folder-picker-entry", selectedPath === entry.path && "folder-picker-entry-selected")}
                      onClick={() => setSelectedPath(entry.path)}
                      onDoubleClick={() => void loadDirectory(entry.path)}
                      onKeyDown={(event: { key: string }) => {
                        if (event.key === "Enter") void loadDirectory(entry.path)
                      }}
                    >
                      <div className="folder-entry-icon">
                        <FolderIcon />
                      </div>
                      <div>
                        <strong>{entry.name}</strong>
                        <span>{entry.kind === "symlink" ? "Linked folder" : "Folder"}</span>
                      </div>
                      <ChevronRightIcon />
                    </button>
                  ))
                : null}
            </div>
          </section>
        </div>

        <div className="folder-picker-selection">
          <FolderOpenIcon />
          <div>
            <span>{selectedPath ? "Selected folder" : "Current folder"}</span>
            <code title={selectedPath ?? listing?.currentPath}>{selectedPath ?? listing?.currentPath ?? "Loading…"}</code>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!listing || Boolean(error)} onClick={chooseFolder}>
            {selectedLabel}
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

function buildBreadcrumbs(currentPath: string, separator: "/" | "\\"): Array<{ label: string; path: string }> {
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

  const root = `${parts[0]}\\`
  const crumbs = [{ label: parts[0], path: root }]
  let cumulative = root
  for (const part of parts.slice(1)) {
    cumulative = `${cumulative}${part}\\`
    crumbs.push({ label: part, path: cumulative })
  }
  return crumbs
}
