import { FolderIcon } from "lucide-react"

/** Compact empty state shared by the overview, folders, and activity views. */
export function CompactEmptyState({ icon: Icon, title, description }: { icon: typeof FolderIcon; title: string; description: string }) {
  return (
    <div className="compact-empty [display:flex] [min-height:112px] [align-items:center] [justify-content:center] [gap:12px] [padding:22px] [color:var(--muted-foreground)] [&>svg]:[width:20px] [&>svg]:[height:20px] [&_p]:[margin:0] [&_p]:[color:var(--foreground)] [&_p]:[font-size:12.5px] [&_p]:[font-weight:600] [&_span]:[display:block] [&_span]:[max-width:38ch] [&_span]:[margin-top:2px] [&_span]:[font-size:10.5px] [&_span]:[line-height:1.45]">
      <Icon />
      <div>
        <p>{title}</p>
        <span>{description}</span>
      </div>
    </div>
  )
}
