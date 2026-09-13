import { FolderCheckIcon } from "lucide-react"
import type { DirectoryMapping } from "../../shared/directory-mapping"
import { Alert, AlertDescription, AlertTitle } from "./ui/alert"

export function DirectoryMappingNotice({ mappings = [], localName, remoteName }: {
  mappings?: DirectoryMapping[]
  localName: string
  remoteName: string
}) {
  if (mappings.length === 0) return null
  const older = mappings.reduce((count, mapping) => count + mapping.olderLocalPaths.length + mapping.olderRemotePaths.length, 0)
  return (
    <Alert>
      <FolderCheckIcon />
      <AlertTitle>Folder names matched automatically</AlertTitle>
      <AlertDescription>
        <p>The newest folder timestamp chooses the spelling used for sync. Selected folders keep their existing names.</p>
        {older > 0 ? <p>When the initial merge starts, {older} older duplicate folder{older === 1 ? "" : "s"} will move to Trash or Recycle Bin, including their contents. They remain recoverable there.</p> : null}
        <details>
          <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring">Show selected folders</summary>
          <ul className="mt-2 flex max-h-40 flex-col gap-2 overflow-auto">
            {mappings.map((mapping) => <li key={mapping.path} className="break-all">
              <strong>{mapping.path}</strong>
              <div>{localName}: {mapping.localPath}</div>
              <div>{remoteName}: {mapping.remotePath}</div>
              {mapping.olderLocalPaths.length > 0 ? <div>Move to Trash on {localName}: {mapping.olderLocalPaths.join(", ")}</div> : null}
              {mapping.olderRemotePaths.length > 0 ? <div>Move to Trash on {remoteName}: {mapping.olderRemotePaths.join(", ")}</div> : null}
            </li>)}
          </ul>
        </details>
      </AlertDescription>
    </Alert>
  )
}
