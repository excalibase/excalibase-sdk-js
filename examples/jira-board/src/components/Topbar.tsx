import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Search, Bell, HelpCircle, Settings, LogOut, ChevronDown } from "lucide-react";
import { IDENTITIES, type DemoIdentity } from "../lib/client";
import type { Project } from "../lib/types";

export function Topbar({
  identity,
  onIdentityChange,
  currentProject,
}: {
  identity: DemoIdentity;
  onIdentityChange: (next: DemoIdentity) => void;
  currentProject: Project | null;
}) {
  return (
    <header className="h-12 bg-white border-b border-slate-200 flex items-center px-3 gap-2 flex-shrink-0">
      {/* Brand */}
      <div className="flex items-center gap-2 pr-2">
        <div className="w-7 h-7 rounded bg-brand-500 grid place-items-center text-white font-bold text-sm">
          E
        </div>
        <span className="font-semibold text-slate-800 text-sm">Excalibase</span>
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-sm text-slate-500 ml-4">
        <span className="hover:text-slate-700 cursor-pointer">Projects</span>
        {currentProject && (
          <>
            <span className="text-slate-300">/</span>
            <span className="text-slate-800 font-medium">{currentProject.name}</span>
          </>
        )}
      </div>

      {/* Search */}
      <div className="flex-1 max-w-md mx-auto relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type="search"
          placeholder="Search issues, projects, people…"
          className="w-full pl-9 pr-3 py-1.5 rounded-md text-sm bg-slate-100 border border-transparent
                     focus:bg-white focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none transition"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1">
        <button className="btn-icon"><Bell size={16} /></button>
        <button className="btn-icon"><HelpCircle size={16} /></button>
        <button className="btn-icon"><Settings size={16} /></button>

        {/* Identity dropdown */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="ml-2 flex items-center gap-2 pl-1 pr-2 py-1 rounded-md hover:bg-slate-100 transition">
              <span className={`avatar w-7 h-7 ${identity.tint}`}>{identity.initials}</span>
              <span className="text-sm font-medium text-slate-700">{identity.label}</span>
              <ChevronDown size={14} className="text-slate-400" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="min-w-64 bg-white rounded-lg shadow-lg ring-1 ring-slate-200 p-1.5 z-50"
            >
              <DropdownMenu.Label className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
                Switch identity
              </DropdownMenu.Label>
              {IDENTITIES.map(id => (
                <DropdownMenu.Item
                  key={id.key}
                  onSelect={() => onIdentityChange(id)}
                  className={
                    "flex items-start gap-2.5 px-2 py-1.5 rounded text-sm cursor-pointer transition outline-none " +
                    (id.key === identity.key
                      ? "bg-brand-50 text-brand-700"
                      : "text-slate-700 hover:bg-slate-50 focus:bg-slate-50")
                  }
                >
                  <span className={`avatar w-7 h-7 mt-0.5 flex-shrink-0 ${id.tint}`}>
                    {id.initials}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium leading-tight">{id.label}</div>
                    <div className="text-xs text-slate-500 leading-tight mt-0.5">
                      {id.blurb}
                    </div>
                    <div className="text-[10px] font-mono text-slate-400 mt-1">
                      role: {id.pgRole}
                    </div>
                  </div>
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator className="my-1 h-px bg-slate-100" />
              <DropdownMenu.Item
                disabled
                className="flex items-center gap-2 px-2 py-1.5 rounded text-sm text-slate-400 outline-none"
              >
                <LogOut size={14} /> Sign out (demo only)
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}
