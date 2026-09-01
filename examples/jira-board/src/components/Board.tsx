import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Globe, Lock, Loader2 } from "lucide-react";
import { Column } from "./Column";
import { IssueCard } from "./IssueCard";
import { getClient, type DemoIdentity } from "../lib/client";
import { STATUS_ORDER, type Issue, type IssueStatus, type Project, type User } from "../lib/types";

export function Board({
  project,
  issues,
  users,
  loading,
  identity,
  onIssueClick,
  onMoveIssue,
}: {
  project: Project | null;
  issues: Issue[];
  users: User[];
  loading: boolean;
  identity: DemoIdentity;
  onIssueClick: (id: number) => void;
  onMoveIssue: () => void;
}) {
  // Local optimistic copy so drag-drop feels instant; server roundtrip
  // either confirms or rolls back via the parent invalidate.
  const [local, setLocal] = useState<Issue[]>(issues);
  useEffect(() => setLocal(issues), [issues]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [activeIssue, setActiveIssue] = useState<Issue | null>(null);

  const grouped = useMemo(() => {
    const out: Record<IssueStatus, Issue[]> = {
      backlog: [], todo: [], in_progress: [], review: [], done: [],
    };
    // Excalibase's GraphQL emits enum values UPPERCASE (DONE, IN_PROGRESS) while
    // the underlying Postgres enum and our column keys are lowercase. Normalize
    // before lookup so cards land in the right column.
    for (const issue of local) {
      const status = String(issue.status).toLowerCase() as IssueStatus;
      (out[status] ?? out.backlog).push(issue);
    }
    return out;
  }, [local]);

  function onDragStart(e: DragStartEvent) {
    const id = Number(e.active.id);
    const found = local.find(i => i.id === id) ?? null;
    setActiveIssue(found);
  }

  async function onDragEnd(e: DragEndEvent) {
    setActiveIssue(null);
    if (!e.over) return;
    const issueId = Number(e.active.id);
    const targetStatus = String(e.over.id) as IssueStatus;
    if (!STATUS_ORDER.includes(targetStatus)) return;

    const issue = local.find(i => i.id === issueId);
    if (!issue || issue.status === targetStatus) return;

    // Optimistic update.
    setLocal(prev =>
      prev.map(i => (i.id === issueId ? { ...i, status: targetStatus } : i))
    );

    try {
      // PATCH /api/v1/issues?id=eq.<id> — REST surface; routes through
      // setRlsContext + SET LOCAL ROLE. Authenticated users may only
      // update their own reported issues; admin can update any in-org.
      await getClient().rest.patch(
        `/issues?id=eq.${issueId}`,
        { status: targetStatus },
        { headers: { "Content-Profile": "kanban" } }
      );
      onMoveIssue();
    } catch {
      // Rollback the optimistic change on failure (RLS rejection, etc.).
      setLocal(prev =>
        prev.map(i => (i.id === issueId ? { ...i, status: issue.status } : i))
      );
    }
  }

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
        Pick a project from the sidebar
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-end justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">{project.name}</h1>
            {project.is_public ? (
              <span className="pill bg-emerald-50 text-emerald-700 ring-1 ring-emerald-500/20">
                <Globe size={11} /> public
              </span>
            ) : (
              <span className="pill bg-slate-100 text-slate-600 ring-1 ring-slate-300">
                <Lock size={11} /> private
              </span>
            )}
            <span className="font-mono text-xs text-slate-400">{project.key}</span>
          </div>
          {project.description && (
            <p className="text-sm text-slate-500 mt-1">{project.description}</p>
          )}
        </div>
        {loading && (
          <Loader2 size={16} className="animate-spin text-slate-300" />
        )}
      </div>

      <div className="flex-1 overflow-x-auto overflow-y-hidden scrollbar-thin">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <div className="h-full flex gap-3 px-6 py-4 min-w-max">
            {STATUS_ORDER.map(status => (
              <Column
                key={status}
                status={status}
                issues={grouped[status]}
                users={users}
                identity={identity}
                onIssueClick={onIssueClick}
              />
            ))}
          </div>
          <DragOverlay>
            {activeIssue && (
              <div className="rotate-2 scale-105 shadow-card-hover">
                <IssueCard issue={activeIssue} users={users} identity={identity} />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  );
}
