import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { MessageSquare, AlertCircle, ChevronUp, Equal, ChevronDown } from "lucide-react";
import type { Issue, IssuePriority, User } from "../lib/types";
import type { DemoIdentity } from "../lib/client";
import { userIdOf } from "../lib/client";

const PRIORITY_ICONS = {
  critical: { Icon: AlertCircle, color: "text-prio-critical" },
  high:     { Icon: ChevronUp,   color: "text-prio-high" },
  medium:   { Icon: Equal,       color: "text-prio-medium" },
  low:      { Icon: ChevronDown, color: "text-prio-low" },
} as const;

const AVATAR_TINTS = ["bg-pink-500", "bg-amber-500", "bg-violet-500", "bg-cyan-500", "bg-rose-500", "bg-lime-600"];

function avatarTintFor(userId: number) {
  return AVATAR_TINTS[userId % AVATAR_TINTS.length];
}

function initialsOf(name?: string) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function IssueCard({
  issue,
  users,
  identity,
  onClick,
}: {
  issue: Issue;
  users: User[];
  identity: DemoIdentity;
  onClick?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: issue.id,
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
  };

  const assignee = users.find(u => u.id === issue.assignee_id);
  const isYours = userIdOf(identity) > 0 && issue.reporter_id === userIdOf(identity);
  // GraphQL emits enum values uppercase — our keys are lowercase.
  const prio = PRIORITY_ICONS[String(issue.priority).toLowerCase() as IssuePriority] ?? PRIORITY_ICONS.medium;
  const PrioIcon = prio.Icon;

  const labels = issue.kanbanIssueLabels?.map(il => il.kanbanLabels).filter(Boolean) ?? [];

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        // Only fire click when not dragging — listeners would otherwise
        // re-fire onClick after a drop.
        if (!isDragging) onClick?.();
        e.stopPropagation();
      }}
      className="bg-white rounded-md p-2.5 shadow-card hover:shadow-card-hover cursor-pointer transition group select-none"
    >
      {/* Labels row */}
      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {labels.map(l => (
            <span
              key={l.id}
              className="pill text-white"
              style={{ backgroundColor: l.color }}
            >
              {l.name}
            </span>
          ))}
        </div>
      )}

      {/* Title */}
      <h3 className="text-sm text-slate-800 leading-snug group-hover:text-brand-700 transition mb-2">
        {issue.title}
      </h3>

      {/* Footer row */}
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="font-mono">PLAT-{issue.id}</span>
        <span title={issue.priority}>
          <PrioIcon size={14} className={prio.color} />
        </span>
        {issue.story_points != null && (
          <span className="ml-auto inline-flex items-center justify-center w-5 h-5 rounded-full bg-slate-100 text-[10px] font-semibold text-slate-600">
            {issue.story_points}
          </span>
        )}
        {issue.kanbanComments?.length > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <MessageSquare size={11} />
            {issue.kanbanComments.length}
          </span>
        )}
        {assignee && (
          <span
            className={`avatar w-5 h-5 ${avatarTintFor(assignee.id)} ${issue.story_points == null && issue.kanbanComments?.length === 0 ? "ml-auto" : ""}`}
            title={assignee.name}
          >
            {initialsOf(assignee.name)}
          </span>
        )}
        {isYours && (
          <span className="text-[10px] font-mono text-brand-500">yours</span>
        )}
      </div>
    </div>
  );
}
