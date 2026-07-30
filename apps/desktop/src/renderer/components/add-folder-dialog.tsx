import { useMemo, useState, type ChangeEvent, type ReactNode } from "react"
import { FolderOpenIcon, PlusIcon } from "lucide-react"
import type { AddFolderInput, SyncMode } from "@shared/contracts"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

const defaultIgnorePatterns = [".DS_Store", "Thumbs.db", "desktop.ini", "*.tmp", "~$*"]

interface AddFolderDialogProps {
  onAdded: () => void
}

export function AddFolderDialog({ onAdded }: AddFolderDialogProps) {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [localPath, setLocalPath] = useState("")
  const [remotePath, setRemotePath] = useState("")
  const [mode, setMode] = useState<SyncMode>("two-way")
  const [patterns, setPatterns] = useState(defaultIgnorePatterns.join("\n"))

  const canSubmit = useMemo(() => localPath.trim() && remotePath.trim(), [localPath, remotePath])

  async function chooseLocalPath() {
    const selected = await window.folderSync.chooseDirectory()
    if (!selected) return
    setLocalPath(selected)
    if (!name) setName(selected.split(/[\\/]/).filter(Boolean).at(-1) ?? "Synced folder")
  }

  async function submit() {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError(null)

    const input: AddFolderInput = {
      name: name.trim(),
      localPath: localPath.trim(),
      remotePath: remotePath.trim(),
      mode,
      ignorePatterns: patterns
        .split("\n")
        .map((pattern) => pattern.trim())
        .filter(Boolean),
    }

    try {
      await window.folderSync.addFolder(input)
      setOpen(false)
      setName("")
      setLocalPath("")
      setRemotePath("")
      setMode("two-way")
      setPatterns(defaultIgnorePatterns.join("\n"))
      onAdded()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to add the folder.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <PlusIcon data-icon="inline-start" />
        Add folder
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a synced folder</DialogTitle>
          <DialogDescription>
            Configure the paths now. FolderSync will not transfer data until the second device is paired.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-6 grid gap-5">
          <Field label="Display name" hint="Optional; defaults to the local folder name.">
            <input
              className="field-control"
              value={name}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
              placeholder="Projects"
            />
          </Field>

          <Field label="Folder on this computer">
            <div className="flex gap-2">
              <input className="field-control min-w-0 flex-1" value={localPath} readOnly placeholder="Choose a folder" />
              <Button variant="outline" onClick={chooseLocalPath}>
                <FolderOpenIcon data-icon="inline-start" />
                Browse
              </Button>
            </div>
          </Field>

          <Field label="Folder on the paired computer" hint="You will browse this path remotely after pairing is implemented.">
            <input
              className="field-control"
              value={remotePath}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setRemotePath(event.target.value)}
              placeholder="D:\\Folders\\Projects or /home/tommy/Folders/Projects"
            />
          </Field>

          <Field label="Sync direction">
            <select className="field-control" value={mode} onChange={(event: ChangeEvent<HTMLSelectElement>) => setMode(event.target.value as typeof mode)}>
              <option value="two-way">Two-way sync</option>
              <option value="send-only">Send from this computer only</option>
              <option value="receive-only">Receive to this computer only</option>
            </select>
          </Field>

          <Field label="Ignore patterns" hint="One glob-style pattern per line. Subfolders sync recursively unless ignored.">
            <textarea
              className="field-control min-h-28 resize-y font-mono text-xs"
              value={patterns}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setPatterns(event.target.value)}
            />
          </Field>

          {error ? <p className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit || submitting} onClick={submit}>
            {submitting ? "Adding…" : "Add folder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid gap-2">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  )
}
