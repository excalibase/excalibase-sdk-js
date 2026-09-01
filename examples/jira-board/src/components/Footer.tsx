import { Database, Activity } from "lucide-react";
import { getClient, type DemoIdentity } from "../lib/client";
import { WHOAMI } from "../lib/queries";
import { useCachedWhoami } from "../hooks/whoami";

type WhoamiResponse = { kanbanWhoamiView: Array<{ role: string }> };

const PILL_TINTS: Record<string, string> = {
  app_anon:          "bg-slate-100 text-slate-700 ring-slate-300",
  app_authenticated: "bg-brand-50 text-brand-700 ring-brand-200",
  app_admin:         "bg-rose-50 text-rose-700 ring-rose-200",
  app_service:       "bg-violet-50 text-violet-700 ring-violet-200",
};

export function Footer({ identity }: { identity: DemoIdentity }) {
  // Cached whoami — only fetches the first time we see this identity.
  // Result is persisted to localStorage so reloads don't hit the network.
  const serverRole = useCachedWhoami(identity.key, async () => {
    const data = (await getClient().graphql.query(WHOAMI)) as WhoamiResponse;
    return data?.kanbanWhoamiView?.[0]?.role ?? null;
  });

  const role = serverRole ?? identity.pgRole;
  const tint = PILL_TINTS[role] ?? PILL_TINTS.app_authenticated;

  return (
    <footer className="h-8 bg-white border-t border-slate-200 px-4 flex items-center gap-4 text-[11px] text-slate-500 flex-shrink-0">
      <span className="flex items-center gap-1.5">
        <Database size={11} />
        <span className="font-mono">
          {(import.meta.env.VITE_API_URL ?? "localhost:10004").replace(/^https?:\/\//, "")}
        </span>
      </span>
      <span className="text-slate-200">|</span>
      <span>
        scope: <span className="font-mono text-slate-700">{identity.scope}</span>
      </span>
      <span className="text-slate-200">|</span>
      <span className="flex items-center gap-1.5">
        Postgres role:
        <span className={`pill ring-1 ${tint}`}>
          <Activity size={10} /> {role}
        </span>
      </span>
      <div className="flex-1" />
      <span className="font-mono">@excalibase/sdk</span>
    </footer>
  );
}
