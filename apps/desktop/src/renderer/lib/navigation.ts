import {
  ActivityIcon,
  ArchiveRestoreIcon,
  ComputerIcon,
  FolderIcon,
  LayoutDashboardIcon,
  Settings2Icon,
} from "lucide-react"

/** Top-level views reachable from the sidebar. */
export type View = "overview" | "folders" | "activity" | "devices" | "history" | "settings"

export interface NavItem {
  id: View
  label: string
  icon: typeof LayoutDashboardIcon
}

export const navItems: NavItem[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboardIcon },
  { id: "folders", label: "Folders", icon: FolderIcon },
  { id: "activity", label: "Activity", icon: ActivityIcon },
  { id: "history", label: "Recovery", icon: ArchiveRestoreIcon },
  { id: "devices", label: "Devices", icon: ComputerIcon },
  { id: "settings", label: "Settings", icon: Settings2Icon },
]

/** Title for the shell topbar. */
export function viewTitle(view: View): string {
  if (view === "overview") return "Overview"
  if (view === "folders") return "Folders"
  if (view === "activity") return "Activity"
  if (view === "devices") return "Devices"
  if (view === "history") return "Recovery"
  return "Settings"
}
