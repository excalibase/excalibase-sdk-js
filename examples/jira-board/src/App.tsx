import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { Board } from "./components/Board";
import { IssueDrawer } from "./components/IssueDrawer";
import { Footer } from "./components/Footer";
import { IDENTITIES, getClient, setIdentity, type DemoIdentity } from "./lib/client";
import { PROJECTS, ISSUES_FOR_PROJECT, USERS } from "./lib/queries";
import type { Issue, Project, User } from "./lib/types";

export default function App() {
  const queryClient = useQueryClient();
  const [identity, setActiveIdentity] = useState<DemoIdentity>(IDENTITIES[0]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [openIssueId, setOpenIssueId] = useState<number | null>(null);

  // Identity change must update the global client synchronously (before
  // React Query refetches with the new key) — same race fix as kanban-roles.
  function handleIdentityChange(next: DemoIdentity) {
    setIdentity(next);
    setActiveIdentity(next);
    queryClient.invalidateQueries();
  }

  useEffect(() => {
    setIdentity(identity);
    // intentional mount-only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const projectsQ = useQuery<{ kanbanProjects: Project[] }, Error>({
    queryKey: ["projects", identity.key],
    queryFn: async () => (await getClient().graphql.query(PROJECTS)) as { kanbanProjects: Project[] },
  });

  const usersQ = useQuery<{ kanbanUsers: User[] }, Error>({
    queryKey: ["users", identity.key],
    queryFn: async () => (await getClient().graphql.query(USERS)) as { kanbanUsers: User[] },
  });

  const issuesQ = useQuery<{ kanbanIssues: Issue[] }, Error>({
    queryKey: ["issues", identity.key, selectedProjectId],
    enabled: selectedProjectId != null,
    queryFn: async () =>
      (await getClient().graphql.query(ISSUES_FOR_PROJECT, { projectId: selectedProjectId })) as { kanbanIssues: Issue[] },
  });

  const projects = projectsQ.data?.kanbanProjects ?? [];
  const users = usersQ.data?.kanbanUsers ?? [];
  const issues = issuesQ.data?.kanbanIssues ?? [];

  // First project becomes default selection when the visible set changes.
  useEffect(() => {
    if (!projects.length) {
      setSelectedProjectId(null);
      return;
    }
    if (selectedProjectId == null || !projects.find(p => p.id === selectedProjectId)) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  const selectedProject = useMemo(
    () => projects.find(p => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );

  const openIssue = useMemo(
    () => issues.find(i => i.id === openIssueId) ?? null,
    [issues, openIssueId]
  );

  const error = projectsQ.error || issuesQ.error || usersQ.error;
  const isPermDenied = (error?.message ?? "").toLowerCase().includes("permission denied");

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      <Topbar
        identity={identity}
        onIdentityChange={handleIdentityChange}
        currentProject={selectedProject}
      />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          projects={projects}
          loading={projectsQ.isLoading}
          selectedId={selectedProjectId}
          onSelect={setSelectedProjectId}
          identity={identity}
        />
        <main className="flex-1 flex flex-col overflow-hidden">
          {error && (
            <div className="px-6 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700">
              <span className="font-mono text-xs">
                {isPermDenied ? "RLS blocked: " : "Error: "}
                {error.message.split("\n")[0].slice(0, 240)}
              </span>
            </div>
          )}
          <Board
            project={selectedProject}
            issues={issues}
            users={users}
            loading={issuesQ.isLoading}
            identity={identity}
            onIssueClick={setOpenIssueId}
            onMoveIssue={() => {
              // After a successful drag-drop status mutation, refetch to
              // get authoritative state (including any trigger side-effects).
              queryClient.invalidateQueries({ queryKey: ["issues"] });
            }}
          />
        </main>
      </div>
      <Footer identity={identity} />
      {openIssue && selectedProject && (
        <IssueDrawer
          issue={openIssue}
          project={selectedProject}
          users={users}
          identity={identity}
          onClose={() => setOpenIssueId(null)}
          onMutated={() => queryClient.invalidateQueries({ queryKey: ["issues"] })}
        />
      )}
    </div>
  );
}
