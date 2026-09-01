import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, MessageSquare, Send, Loader2, AlertCircle } from "lucide-react";
import { getClient, userIdOf, type DemoIdentity } from "../lib/client";
import type { Issue, IssueStatus, Project, User } from "../lib/types";
import { STATUS_LABELS, STATUS_ORDER } from "../lib/types";

const TINTS = ["bg-pink-500", "bg-amber-500", "bg-violet-500", "bg-cyan-500", "bg-rose-500", "bg-lime-600"];
function tintFor(id: number) { return TINTS[id % TINTS.length]; }
function initialsOf(name?: string) {
  if (!name) return "?";
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function IssueDrawer({
  issue,
  project,
  users,
  identity,
  onClose,
  onMutated,
}: {
  issue: Issue;
  project: Project;
  users: User[];
  identity: DemoIdentity;
  onClose: () => void;
  onMutated: () => void;
}) {
  const reporter = users.find(u => u.id === issue.reporter_id);
  const assignee = users.find(u => u.id === issue.assignee_id);
  const userId = userIdOf(identity);
  const canComment = identity.key !== "anon";

  return (
    <Dialog.Root open onOpenChange={open => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-40 animate-in fade-in" />
        <Dialog.Content
          className="fixed right-0 top-0 h-full w-[640px] max-w-full bg-white shadow-2xl z-50
                     flex flex-col animate-in slide-in-from-right outline-none"
        >
          <header className="flex items-start justify-between px-6 py-4 border-b border-slate-100">
            <div className="flex-1 min-w-0">
              <Dialog.Title asChild>
                <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
                  <span>{project.key}-{issue.id}</span>
                  <span className="text-slate-300">·</span>
                  <span>{issue.priority}</span>
                  <span className="text-slate-300">·</span>
                  <span>{issue.story_points ?? "—"}p</span>
                </div>
              </Dialog.Title>
              <Dialog.Description asChild>
                <h2 className="text-xl font-semibold text-slate-900 mt-1 leading-tight">
                  {issue.title}
                </h2>
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="btn-icon flex-shrink-0"><X size={18} /></button>
            </Dialog.Close>
          </header>

          <div className="flex-1 overflow-y-auto scrollbar-thin">
            <div className="grid grid-cols-3 gap-x-6 px-6 py-5">
              <div className="col-span-2 space-y-6">
                {/* Description */}
                <div>
                  <h3 className="text-xs uppercase tracking-wider text-slate-400 font-semibold mb-2">
                    Description
                  </h3>
                  <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                    {issue.description ?? <span className="italic text-slate-400">No description.</span>}
                  </p>
                </div>

                {/* Comments */}
                <div>
                  <h3 className="text-xs uppercase tracking-wider text-slate-400 font-semibold mb-2 flex items-center gap-1.5">
                    <MessageSquare size={12} />
                    Comments
                    <span className="text-slate-300 font-mono">{issue.kanbanComments.length}</span>
                  </h3>
                  <div className="space-y-3">
                    {issue.kanbanComments.length === 0 && (
                      <p className="text-xs italic text-slate-400">No comments yet.</p>
                    )}
                    {issue.kanbanComments.map(c => {
                      const author = users.find(u => u.id === c.author_id);
                      return (
                        <div key={c.id} className="flex gap-2.5">
                          <span className={`avatar w-7 h-7 mt-0.5 flex-shrink-0 ${tintFor(c.author_id)}`}>
                            {initialsOf(author?.name) || `U${c.author_id}`}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 text-xs">
                              <span className="font-medium text-slate-800">{author?.name ?? `User ${c.author_id}`}</span>
                              <span className="text-slate-400">{new Date(c.created_at).toLocaleString()}</span>
                            </div>
                            <p className="text-sm text-slate-700 mt-1 leading-relaxed whitespace-pre-wrap">{c.body}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {canComment ? (
                    <CommentForm
                      issueId={issue.id}
                      authorId={userId}
                      identity={identity}
                      onPosted={onMutated}
                    />
                  ) : (
                    <div className="mt-4 px-3 py-2.5 rounded-md bg-amber-50 ring-1 ring-amber-200 text-sm text-amber-900 flex items-start gap-2">
                      <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
                      <span>
                        Sign in to comment. The active role <span className="font-mono">{identity.pgRole}</span>{" "}
                        has no <span className="font-mono">INSERT</span> grant on{" "}
                        <span className="font-mono">kanban.comments</span> — RLS rejects the write before it reaches the table.
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Side panel */}
              <aside className="col-span-1 space-y-4">
                <SideField label="Status">
                  <StatusSelect
                    issueId={issue.id}
                    current={String(issue.status).toLowerCase() as IssueStatus}
                    canEdit={identity.key !== "anon" && (identity.pgRole === "app_admin" || issue.reporter_id === userId)}
                    onChanged={onMutated}
                  />
                </SideField>
                <SideField label="Assignee">
                  {assignee ? (
                    <div className="flex items-center gap-2">
                      <span className={`avatar w-6 h-6 ${tintFor(assignee.id)}`}>
                        {initialsOf(assignee.name)}
                      </span>
                      <span className="text-sm text-slate-700">{assignee.name}</span>
                    </div>
                  ) : (
                    <span className="text-sm text-slate-400 italic">Unassigned</span>
                  )}
                </SideField>
                <SideField label="Reporter">
                  {reporter ? (
                    <div className="flex items-center gap-2">
                      <span className={`avatar w-6 h-6 ${tintFor(reporter.id)}`}>
                        {initialsOf(reporter.name)}
                      </span>
                      <span className="text-sm text-slate-700">{reporter.name}</span>
                    </div>
                  ) : (
                    <span className="text-sm text-slate-400 italic">—</span>
                  )}
                </SideField>
                <SideField label="Created">
                  <span className="text-sm text-slate-700">{new Date(issue.created_at).toLocaleDateString()}</span>
                </SideField>
                <SideField label="Updated">
                  <span className="text-sm text-slate-700">{new Date(issue.updated_at).toLocaleDateString()}</span>
                </SideField>
              </aside>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SideField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-1.5">
        {label}
      </div>
      {children}
    </div>
  );
}

function StatusSelect({
  issueId,
  current,
  canEdit,
  onChanged,
}: {
  issueId: number;
  current: IssueStatus;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: IssueStatus) {
    if (next === current) return;
    setPending(true);
    setError(null);
    try {
      await getClient().rest.patch(
        `/issues?id=eq.${issueId}`,
        { status: next },
        { headers: { "Content-Profile": "kanban" } }
      );
      onChanged();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setPending(false);
    }
  }

  if (!canEdit) {
    return (
      <span className="pill bg-slate-100 text-slate-700">
        {STATUS_LABELS[current] ?? current}
      </span>
    );
  }
  return (
    <div>
      <select
        value={current}
        onChange={e => change(e.target.value as IssueStatus)}
        disabled={pending}
        className="input"
      >
        {STATUS_ORDER.map(s => (
          <option key={s} value={s}>{STATUS_LABELS[s]}</option>
        ))}
      </select>
      {error && (
        <div className="text-xs text-amber-900 bg-amber-50 ring-1 ring-amber-200 rounded px-2 py-1 mt-1.5 flex items-start gap-1.5">
          <AlertCircle size={12} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Translate raw SDK / Postgres errors into a friendlier inline message.
 * The raw text usually contains "permission denied for table X", "row-level
 * security policy", or "REST request failed" — we map each to something a
 * human reading a demo can immediately understand.
 */
function humanizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("permission denied")) {
    const m = msg.match(/permission denied for (?:table|relation) ['"]?(\w+)['"]?/i);
    return m
      ? `Blocked by RLS — current role has no access to ${m[1]}.`
      : "Blocked by RLS — current role doesn't have permission for this action.";
  }
  if (lower.includes("row-level security") || lower.includes("violates row-level")) {
    return "RLS WITH CHECK rejected the row — you can only write rows you own.";
  }
  if (lower.includes("rest request failed") || lower.includes("network")) {
    return "Couldn't reach the API. Check the dev server is up and try again.";
  }
  return msg.slice(0, 180);
}

function CommentForm({
  issueId,
  authorId,
  identity,
  onPosted,
}: {
  issueId: number;
  authorId: number;
  identity: DemoIdentity;
  onPosted: () => void;
}) {
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setPosting(true);
    setError(null);
    try {
      await getClient().rest.post(
        "/comments",
        { issue_id: issueId, author_id: authorId, body: body.trim() },
        { headers: { "Content-Profile": "kanban" } }
      );
      setBody("");
      onPosted();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setPosting(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-2">
      <div className="flex gap-2 items-start">
        <span className={`avatar w-7 h-7 mt-1 flex-shrink-0 ${identity.tint}`}>
          {identity.initials}
        </span>
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          rows={2}
          placeholder={`Comment as ${identity.label}…`}
          className="input flex-1 resize-none"
          disabled={posting}
        />
      </div>
      {error && (
        <div className="text-xs text-amber-900 bg-amber-50 ring-1 ring-amber-200 rounded px-2.5 py-2 flex items-start gap-1.5">
          <AlertCircle size={12} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <button
          type="submit"
          disabled={posting || !body.trim()}
          className="btn btn-primary"
        >
          {posting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          Post
        </button>
      </div>
    </form>
  );
}
