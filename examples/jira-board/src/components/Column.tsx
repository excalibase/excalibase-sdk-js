import { useDroppable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { IssueCard } from "./IssueCard";
import { STATUS_LABELS, type Issue, type IssueStatus, type User } from "../lib/types";
import type { DemoIdentity } from "../lib/client";

const HEADER_TINTS: Record<IssueStatus, string> = {
  backlog:     "border-l-slate-400",
  todo:        "border-l-blue-500",
  in_progress: "border-l-amber-500",
  review:      "border-l-violet-500",
  done:        "border-l-emerald-500",
};

export function Column({
  status,
  issues,
  users,
  identity,
  onIssueClick,
}: {
  status: IssueStatus;
  issues: Issue[];
  users: User[];
  identity: DemoIdentity;
  onIssueClick: (id: number) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: status });
  return (
    <div className="w-72 flex-shrink-0 flex flex-col bg-slate-100 rounded-lg overflow-hidden">
      <div className={`pl-3 pr-2 py-2.5 flex items-center gap-2 bg-white border-l-4 ${HEADER_TINTS[status]} border-b border-slate-200`}>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-700">
          {STATUS_LABELS[status]}
        </h2>
        <span className="ml-auto text-xs font-mono px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded">
          {issues.length}
        </span>
        <button
          title="Add issue (demo only)"
          className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition"
        >
          <Plus size={14} />
        </button>
      </div>
      <div
        ref={setNodeRef}
        className={
          "flex-1 overflow-y-auto scrollbar-thin px-2 py-2 space-y-2 transition-colors " +
          (isOver ? "bg-brand-50" : "")
        }
      >
        {issues.map(issue => (
          <IssueCard
            key={issue.id}
            issue={issue}
            users={users}
            identity={identity}
            onClick={() => onIssueClick(issue.id)}
          />
        ))}
        {issues.length === 0 && (
          <div className="text-xs text-slate-400 italic px-2 py-3">
            Drop an issue here
          </div>
        )}
      </div>
    </div>
  );
}
