import { ActivityIcon, CheckCircle2Icon, CircleAlertIcon } from "lucide-react"
import type { ActivityEvent } from "@shared/contracts"
import { CompactEmptyState } from "@/components/compact-empty-state"
import { cn } from "@/lib/utils"
import { formatDateTime, formatRelative } from "@/lib/format"

export function ActivityView({ activity }: { activity: ActivityEvent[] }) {
  return (
    <div className="page-stack [display:grid] [gap:16px] [width:100%] [max-width:1180px] [margin:0_auto]">
      <section className="section-intro [display:flex] [align-items:center] [justify-content:space-between] [gap:24px] [&_h2]:[margin:0] [&_h2]:[font-size:17px] [&_h2]:[font-weight:650] [&_h2]:[letter-spacing:-0.03em] [&_p]:[margin:3px_0_0] [&_p]:[max-width:80ch] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:11.5px] [&_p]:[line-height:1.5]">
        <div>
          <h2>Activity log</h2>
          <p>Configuration, connections, transfers, conflicts and recovery operations are recorded locally.</p>
        </div>
      </section>

      <section className="card [position:relative] [display:flex] [min-width:0] [flex-direction:column] [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--card-sheen)] [box-shadow:var(--elevation-card)]">
        {activity.length === 0 ? (
          <CompactEmptyState icon={ActivityIcon} title="No activity yet" description="Events appear when you configure or sync folders." />
        ) : (
          <div className="activity-list [position:relative] [&.compact_.activity-row]:[padding:11px_16px]">
            {activity.map((event) => (
              <ActivityRow key={event.id} event={event} showDate />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export function ActivityRow({ event, showDate = false }: { event: ActivityEvent; showDate?: boolean }) {
  const Icon = event.level === "success" ? CheckCircle2Icon : event.level === "warning" || event.level === "error" ? CircleAlertIcon : ActivityIcon
  return (
    <div className="activity-row [position:relative] [display:flex] [align-items:flex-start] [gap:12px] [border-bottom:1px_solid_color-mix(in_oklab,_var(--border)_55%,_transparent)] [padding:14px_16px] [&:last-child]:[border-bottom:0] [&:hover]:[background:color-mix(in_oklab,_var(--accent)_40%,_transparent)]">
      <div className={cn("activity-icon [display:grid] [width:28px] [height:28px] [flex:0_0_auto] [place-items:center] [border-radius:9px] [&_svg]:[width:14px] [&_svg]:[height:14px]", {
        "[background:color-mix(in_oklab,var(--info)_12%,var(--surface))] [color:var(--info)]": event.level === "info",
        "[background:color-mix(in_oklab,var(--success)_12%,var(--surface))] [color:var(--success)]": event.level === "success",
        "[background:color-mix(in_oklab,var(--warning)_12%,var(--surface))] [color:var(--warning)]": event.level === "warning",
        "[background:color-mix(in_oklab,var(--danger)_12%,var(--surface))] [color:var(--danger)]": event.level === "error",
      })}>
        <Icon />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-semibold">{event.title}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--muted-foreground)]">{event.detail}</p>
      </div>
      <time className="shrink-0 text-[10px] tabular-nums text-[var(--muted-foreground)]" dateTime={event.occurredAt}>
        {showDate ? formatDateTime(event.occurredAt) : formatRelative(event.occurredAt)}
      </time>
    </div>
  )
}
