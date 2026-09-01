import { Folder, Globe, Lock, Plus, FileBarChart, Calendar, Users as UsersIcon, ChevronDown } from "lucide-react";
import type { DemoIdentity } from "../lib/client";
import type { Project } from "../lib/types";

export function Sidebar({
  projects,
  loading,
  selectedId,
  onSelect,
  identity,
}: {
  projects: Project[];
  loading: boolean;
  selectedId: number | null;
  onSelect: (id: number) => void;
  identity: DemoIdentity;
}) {
  return (
    <aside className="w-64 bg-white border-r border-slate-200 flex flex-col flex-shrink-0">
      <div className="px-3 py-3 border-b border-slate-100">
        <button className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-50 transition text-left">
          <div className="w-7 h-7 rounded bg-gradient-to-br from-brand-500 to-brand-700 grid place-items-center text-white text-xs font-bold">
            AC
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-800 truncate">Acme Corp</div>
            <div className="text-xs text-slate-500">Free plan</div>
          </div>
          <ChevronDown size={14} className="text-slate-400" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto scrollbar-thin px-2 py-2">
        <NavSection title="Workspace">
          <NavItem icon={FileBarChart} label="Reports" />
          <NavItem icon={Calendar} label="Sprints" />
          <NavItem icon={UsersIcon} label="Team" />
        </NavSection>

        <NavSection
          title="Projects"
          action={
            <button
              title="New project (demo only)"
              className="text-slate-400 hover:text-slate-700 transition"
            >
              <Plus size={14} />
            </button>
          }
        >
          {loading && (
            <div className="px-2 py-2 text-xs text-slate-400">Loading…</div>
          )}
          {!loading && projects.length === 0 && (
            <div className="px-2 py-2 text-xs text-slate-400 italic leading-snug">
              No projects visible.<br/>
              Active role <span className="font-mono">{identity.pgRole}</span> has no SELECT grant on visible rows.
            </div>
          )}
          {projects.map(p => {
            const active = p.id === selectedId;
            return (
              <button
                key={p.id}
                onClick={() => onSelect(p.id)}
                className={
                  "w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition group " +
                  (active
                    ? "bg-brand-50 text-brand-700 font-medium"
                    : "text-slate-700 hover:bg-slate-50")
                }
              >
                <Folder size={14} className={active ? "text-brand-500" : "text-slate-400"} />
                <span className="flex-1 truncate text-left">{p.name}</span>
                {p.is_public ? (
                  <Globe size={11} className="text-emerald-500" />
                ) : (
                  <Lock size={11} className="text-slate-300" />
                )}
                <span className="font-mono text-[10px] text-slate-400 group-hover:text-slate-500">
                  {p.key}
                </span>
              </button>
            );
          })}
        </NavSection>
      </nav>

      <div className="px-3 py-2.5 border-t border-slate-100 text-[11px] text-slate-400 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
        <span>Connected to <span className="font-mono">{
          (import.meta.env.VITE_API_URL ?? "localhost:10004").replace(/^https?:\/\//, "")
        }</span></span>
      </div>
    </aside>
  );
}

function NavSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between px-2 mb-1">
        <h3 className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
          {title}
        </h3>
        {action}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function NavItem({ icon: Icon, label }: { icon: typeof Folder; label: string }) {
  return (
    <button
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-slate-700 hover:bg-slate-50 transition"
    >
      <Icon size={14} className="text-slate-400" />
      <span>{label}</span>
    </button>
  );
}
