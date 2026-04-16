import { useEffect, useState } from "react";
import {
  createClient,
  type Session,
  type AuthChangeEvent,
  type DbClient,
} from "@excalibase/sdk";

/**
 * Single DbClient instance for the whole app. The Vite dev server proxies
 * /auth to http://localhost:24004 and /graphql + /api/v1 to
 * http://localhost:10004, so from the browser's perspective everything
 * lives on the Vite origin — no CORS, no separate auth base URL.
 */
const db: DbClient = createClient({
  url: window.location.origin,
  projectId: "study-cases/kanban",
  publishableKey: "esk_pub_live_react_demo_key_1234567890",
});

interface Issue {
  id: number;
  title: string;
  priority: string;
  status: string;
  created_at?: string;
  project_id?: number;
  sprint_id?: number;
}

type Mode = "list" | "dashboard" | "paginate" | "aggregate" | "search" | "webSearch" | "vector" | "rest";

type StatusFilter = "ALL" | "TODO" | "IN_PROGRESS" | "DONE";

interface AggregateResult {
  issues: {
    count: number;
    sum: { story_points: number };
    avg: { story_points: number };
    min: { story_points: number };
    max: { story_points: number };
  };
  timeEntries: {
    count: number;
    sum: { hours: number };
    avg: { hours: number };
    min: { hours: number };
    max: { hours: number };
  };
}

export function App() {
  const [session, setSession] = useState<Session | null>(db.auth.currentSession());
  const [email, setEmail] = useState(`demo-${Date.now()}@example.com`);
  const [password, setPassword] = useState("Demo123!");
  const [fullName, setFullName] = useState("React Demo User");

  const [mode, setMode] = useState<Mode>("list");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [status, setStatus] = useState<{ kind: "ok" | "err" | "info"; msg: string } | null>(null);
  const [loading, setLoading] = useState(false);

  // list mode
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [orderDir, setOrderDir] = useState<"ASC" | "DESC">("DESC");
  const [listLimit, setListLimit] = useState(10);

  // paginate mode
  const [cursor, setCursor] = useState<string | null>(null);
  const [prevCursors, setPrevCursors] = useState<string[]>([]);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [totalCount, setTotalCount] = useState<number | null>(null);

  // aggregate mode
  const [aggregate, setAggregate] = useState<AggregateResult | null>(null);
  const [aggTimingMs, setAggTimingMs] = useState<number | null>(null);

  // search / webSearch
  const [query, setQuery] = useState("kubernetes");

  // rest mode
  const [restPayload, setRestPayload] = useState<unknown>(null);

  // dashboard mode — multi-table co-fetch
  const [dashboard, setDashboard] = useState<{
    issues: Array<{ id: number; title: string; status: string; priority: string }>;
    projects: Array<{ id: number; name: string }>;
    sprints: Array<{ id: number; name: string }>;
    users: Array<{ id: number; email: string }>;
    issueCount: number;
    projectCount: number;
  } | null>(null);

  useEffect(() => {
    void db.auth.hydrate();
    const sub = db.auth.onAuthStateChange((event: AuthChangeEvent, s) => {
      setSession(s);
      if (event === "SIGNED_IN") setStatus({ kind: "ok", msg: `Signed in as ${s?.user?.email ?? "anon"}` });
      if (event === "SIGNED_OUT") setStatus({ kind: "info", msg: "Signed out" });
      if (event === "TOKEN_REFRESHED") setStatus({ kind: "info", msg: "Token refreshed" });
    });
    return () => sub.unsubscribe();
  }, []);

  async function handleRegister() {
    setStatus(null);
    try {
      await db.auth.signUp({ email, password, fullName });
    } catch (e: unknown) {
      const msg = (e as Error).message;
      if (!/409|already/i.test(msg)) {
        setStatus({ kind: "err", msg: `Register failed: ${msg}` });
        return;
      }
    }
    await handleSignIn();
  }

  async function handleSignIn() {
    setStatus(null);
    try {
      await db.auth.signInWithPassword({ email, password });
    } catch (e: unknown) {
      setStatus({ kind: "err", msg: `Sign-in failed: ${(e as Error).message}` });
    }
  }

  async function handleSignOut() {
    await db.auth.signOut();
    resetResults();
  }

  function resetResults() {
    setIssues([]);
    setCursor(null);
    setPrevCursors([]);
    setHasNextPage(false);
    setTotalCount(null);
    setAggregate(null);
    setAggTimingMs(null);
    setRestPayload(null);
    setDashboard(null);
  }

  function buildWhereFragment(): string {
    if (mode === "list" && statusFilter !== "ALL") {
      return `where: { status: { eq: ${statusFilter.toLowerCase()} } }`;
    }
    return "";
  }

  async function runList() {
    const where = buildWhereFragment();
    const whereArg = where ? `${where}, ` : "";
    const gql = `{
      kanbanIssues(${whereArg}orderBy: { id: ${orderDir} }, limit: ${listLimit}) {
        id title status priority created_at project_id sprint_id
      }
      kanbanIssuesAggregate${where ? `(${where})` : ""} { count }
    }`;
    const data = await db.graphql.query<{ kanbanIssues: Issue[]; kanbanIssuesAggregate: { count: number } }>(gql);
    setIssues(data.kanbanIssues ?? []);
    setTotalCount(data.kanbanIssuesAggregate?.count ?? null);
  }

  async function runPaginate(direction: "first" | "next" | "prev" = "first") {
    let afterArg = "";
    let nextPrevCursors = prevCursors;
    if (direction === "next" && cursor) {
      afterArg = `, after: "${cursor}"`;
      nextPrevCursors = [...prevCursors, cursor];
    } else if (direction === "prev") {
      const stack = [...prevCursors];
      const prev = stack.pop();
      nextPrevCursors = stack;
      if (prev && stack.length > 0) {
        afterArg = `, after: "${stack[stack.length - 1]}"`;
      }
    } else if (direction === "first") {
      nextPrevCursors = [];
    }

    const gql = `{
      kanbanIssuesConnection(first: 5${afterArg}) {
        totalCount
        edges { cursor node { id title status priority } }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    const data = await db.graphql.query<{
      kanbanIssuesConnection: {
        totalCount: number;
        edges: Array<{ cursor: string; node: Issue }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(gql);

    const conn = data.kanbanIssuesConnection;
    setIssues(conn.edges.map((e) => e.node));
    setCursor(conn.pageInfo.endCursor);
    setHasNextPage(conn.pageInfo.hasNextPage);
    setTotalCount(conn.totalCount);
    setPrevCursors(nextPrevCursors);
  }

  async function runAggregate() {
    // One GraphQL document → one SQL statement on the server. The excalibase
    // compiler turns this into a single `SELECT jsonb_build_object(...)` with
    // nested subqueries for each aggregate function. Ten aggregate functions
    // across two tables in ~1 ms of SQL time, one HTTP round trip.
    const start = performance.now();
    const gql = `{
      kanbanIssuesAggregate {
        count
        sum { story_points }
        avg { story_points }
        min { story_points }
        max { story_points }
      }
      kanbanTimeEntriesAggregate {
        count
        sum { hours }
        avg { hours }
        min { hours }
        max { hours }
      }
    }`;
    const data = await db.graphql.query<{
      kanbanIssuesAggregate: AggregateResult["issues"];
      kanbanTimeEntriesAggregate: AggregateResult["timeEntries"];
    }>(gql);
    setAggregate({
      issues: data.kanbanIssuesAggregate,
      timeEntries: data.kanbanTimeEntriesAggregate,
    });
    setAggTimingMs(Math.round(performance.now() - start));
    setIssues([]);
  }

  async function runRest() {
    // Demonstrates db.rest.get() — hits the PostgREST-compatible surface
    // at /api/v1/{table}. The SDK folds the same bearer token + publishable
    // key headers used for GraphQL, and wraps errors in AuthError/NetworkError.
    const data = await db.rest.get<{
      data: Array<{ id: number; title: string; status: string; priority: string }>;
      pagination: { total: number; limit: number; offset: number };
    }>("/issues?select=id,title,status,priority&limit=5", {
      headers: {
        "Accept-Profile": "kanban",
        Prefer: "count=exact",
      },
    });
    setRestPayload(data);
    setIssues(
      (data.data ?? []).map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status.toUpperCase(),
        priority: r.priority.toUpperCase(),
      })),
    );
    setTotalCount(data.pagination?.total ?? null);
  }

  async function runSearch() {
    const esc = query.replace(/"/g, '\\"');
    const gql = `{ kanbanIssues(where: { search_vec: { search: "${esc}" } }, limit: 20) { id title status priority } }`;
    const data = await db.graphql.query<{ kanbanIssues: Issue[] }>(gql);
    setIssues(data.kanbanIssues ?? []);
  }

  async function runWebSearch() {
    const esc = query.replace(/"/g, '\\"');
    const gql = `{ kanbanIssues(where: { search_vec: { webSearch: "${esc}" } }, limit: 20) { id title status priority } }`;
    const data = await db.graphql.query<{ kanbanIssues: Issue[] }>(gql);
    setIssues(data.kanbanIssues ?? []);
  }

  async function runDashboard() {
    // The core GraphQL superpower: fetch everything a page needs in ONE
    // round trip. 6 distinct payloads — 4 lists + 2 aggregates — from 4
    // different tables, keyed by their field names in the response. No
    // aliases, no joins, no client-side stitching. Replaces 6 REST calls.
    const gql = `{
      kanbanIssues(orderBy: { id: DESC }, limit: 5) {
        id title status priority
      }
      kanbanProjects(limit: 5) { id name }
      kanbanSprints(limit: 5) { id name }
      kanbanUsers(limit: 5) { id email }
      kanbanIssuesAggregate { count }
      kanbanProjectsAggregate { count }
    }`;
    const data = await db.graphql.query<{
      kanbanIssues: Array<{ id: number; title: string; status: string; priority: string }>;
      kanbanProjects: Array<{ id: number; name: string }>;
      kanbanSprints: Array<{ id: number; name: string }>;
      kanbanUsers: Array<{ id: number; email: string }>;
      kanbanIssuesAggregate: { count: number };
      kanbanProjectsAggregate: { count: number };
    }>(gql);
    setDashboard({
      issues: data.kanbanIssues ?? [],
      projects: data.kanbanProjects ?? [],
      sprints: data.kanbanSprints ?? [],
      users: data.kanbanUsers ?? [],
      issueCount: data.kanbanIssuesAggregate?.count ?? 0,
      projectCount: data.kanbanProjectsAggregate?.count ?? 0,
    });
    setIssues([]);
  }

  async function runVector() {
    const gql = `{
      kanbanIssues(vector: {
        column: "embedding"
        near: [0.0, 0.0, 1.0]
        distance: "COSINE"
        limit: 5
      }) { id title status priority }
    }`;
    const data = await db.graphql.query<{ kanbanIssues: Issue[] }>(gql);
    setIssues(data.kanbanIssues ?? []);
  }

  async function run() {
    setLoading(true);
    setStatus(null);
    try {
      switch (mode) {
        case "list":
          await runList();
          break;
        case "dashboard":
          await runDashboard();
          break;
        case "paginate":
          await runPaginate("first");
          break;
        case "aggregate":
          await runAggregate();
          break;
        case "search":
          await runSearch();
          break;
        case "webSearch":
          await runWebSearch();
          break;
        case "vector":
          await runVector();
          break;
        case "rest":
          await runRest();
          break;
      }
      setStatus({ kind: "ok", msg: `${mode} query completed` });
    } catch (e: unknown) {
      setStatus({ kind: "err", msg: `${mode} failed: ${(e as Error).message}` });
      setIssues([]);
    } finally {
      setLoading(false);
    }
  }

  async function paginateNext() {
    setLoading(true);
    try {
      await runPaginate("next");
    } catch (e: unknown) {
      setStatus({ kind: "err", msg: `next failed: ${(e as Error).message}` });
    } finally {
      setLoading(false);
    }
  }

  async function paginatePrev() {
    setLoading(true);
    try {
      await runPaginate("prev");
    } catch (e: unknown) {
      setStatus({ kind: "err", msg: `prev failed: ${(e as Error).message}` });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container">
      <h1>Excalibase SDK — Kanban Demo</h1>
      <p className="sub">
        React + Vite app wired to a live excalibase-auth + excalibase-graphql stack
        (<code>study-cases</code> / <code>kanban</code>) via <code>@excalibase/sdk</code>.
      </p>

      {status && <div className={`status ${status.kind}`}>{status.msg}</div>}

      <div className="panel">
        <h2>{session ? `Signed in — ${session.user?.email ?? "anon"}` : "Sign in"}</h2>
        {session == null ? (
          <>
            <label>Email</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} />
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <label>Full name (for sign-up)</label>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
            <div style={{ marginTop: 16, display: "flex", gap: 12 }}>
              <button onClick={handleRegister}>Sign up &amp; sign in</button>
              <button className="ghost" onClick={handleSignIn}>
                Sign in
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, color: "#90a0b7" }}>
              JWT expires at: {new Date(session.expiresAt).toLocaleTimeString()}
            </div>
            <button className="ghost" onClick={handleSignOut} style={{ marginTop: 12 }}>
              Sign out
            </button>
          </>
        )}
      </div>

      <div className="panel">
        <h2>Query mode</h2>
        <div className="mode-tabs">
          {(["list", "dashboard", "paginate", "aggregate", "search", "webSearch", "vector", "rest"] as Mode[]).map((m) => (
            <button
              key={m}
              className={`tab ${mode === m ? "active" : ""}`}
              onClick={() => {
                setMode(m);
                resetResults();
                setStatus(null);
              }}
            >
              {m}
            </button>
          ))}
        </div>

        {mode === "list" && (
          <>
            <div className="row" style={{ marginTop: 12 }}>
              <div style={{ flex: 1 }}>
                <label>Status filter</label>
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
                  <option value="ALL">ALL</option>
                  <option value="TODO">TODO</option>
                  <option value="IN_PROGRESS">IN_PROGRESS</option>
                  <option value="DONE">DONE</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label>Order by id</label>
                <select value={orderDir} onChange={(e) => setOrderDir(e.target.value as "ASC" | "DESC")}>
                  <option value="ASC">ASC</option>
                  <option value="DESC">DESC</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label>Limit</label>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={listLimit}
                  onChange={(e) => setListLimit(Math.min(30, Math.max(1, Number(e.target.value) || 1)))}
                />
              </div>
              <button onClick={run} disabled={loading || session == null}>
                {loading ? "..." : "Run"}
              </button>
            </div>
            <div style={{ fontSize: 12, color: "#90a0b7", marginTop: 8 }}>
              {`kanbanIssues(where: { status: { eq: ${statusFilter === "ALL" ? "—" : statusFilter.toLowerCase()} } }, orderBy: { id: ${orderDir} }, limit: ${listLimit})`}
            </div>
          </>
        )}

        {mode === "dashboard" && (
          <>
            <div style={{ marginTop: 12 }}>
              <button onClick={run} disabled={loading || session == null}>
                {loading ? "..." : "Co-fetch 4 tables + 2 counts in ONE request"}
              </button>
            </div>
            <div style={{ fontSize: 12, color: "#90a0b7", marginTop: 8 }}>
              <code>{"{ kanbanIssues { ... } kanbanProjects { ... } kanbanSprints { ... } kanbanUsers { ... } kanbanIssuesAggregate { count } kanbanProjectsAggregate { count } }"}</code>
              <br />
              Replaces what would be 6 separate REST round trips. This is the
              real reason to pick GraphQL over REST for a dashboard-style page.
            </div>
            {dashboard && (
              <>
                <div className="grid" style={{ marginTop: 16 }}>
                  <StatCard label="Total issues" value={dashboard.issueCount} color="#7cbfff" />
                  <StatCard label="Total projects" value={dashboard.projectCount} color="#9bb5ff" />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 20 }}>
                  <div>
                    <div className="pill" style={{ marginBottom: 8 }}>
                      Recent issues
                    </div>
                    <ul className="issues">
                      {dashboard.issues.map((i) => (
                        <li key={i.id}>
                          <span>
                            <span className="issue-id">#{i.id}</span> {i.title}
                          </span>
                          <span className="pill">{i.status}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="pill" style={{ marginBottom: 8 }}>
                      Projects
                    </div>
                    <ul className="issues">
                      {dashboard.projects.map((p) => (
                        <li key={p.id}>
                          <span>
                            <span className="issue-id">#{p.id}</span> {p.name}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className="pill" style={{ margin: "16px 0 8px" }}>
                      Sprints
                    </div>
                    <ul className="issues">
                      {dashboard.sprints.map((s) => (
                        <li key={s.id}>
                          <span>
                            <span className="issue-id">#{s.id}</span> {s.name}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className="pill" style={{ margin: "16px 0 8px" }}>
                      Users
                    </div>
                    <ul className="issues">
                      {dashboard.users.map((u) => (
                        <li key={u.id}>
                          <span>
                            <span className="issue-id">#{u.id}</span> {u.email}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {mode === "paginate" && (
          <>
            <div style={{ marginTop: 12, display: "flex", gap: 12, alignItems: "center" }}>
              <button onClick={run} disabled={loading || session == null}>
                {loading ? "..." : "Load first page (5)"}
              </button>
              <button
                className="ghost"
                onClick={paginatePrev}
                disabled={loading || session == null || prevCursors.length === 0}
              >
                ← Prev
              </button>
              <button
                className="ghost"
                onClick={paginateNext}
                disabled={loading || session == null || !hasNextPage}
              >
                Next →
              </button>
            </div>
            <div style={{ fontSize: 12, color: "#90a0b7", marginTop: 8 }}>
              Cursor-based pagination via <code>kanbanIssuesConnection(first, after)</code>
              {totalCount != null && ` — total ${totalCount}`}
            </div>
          </>
        )}

        {mode === "aggregate" && (
          <>
            <div style={{ marginTop: 12 }}>
              <button onClick={run} disabled={loading || session == null}>
                {loading ? "..." : "Run aggregate (1 request)"}
              </button>
            </div>
            <div style={{ fontSize: 12, color: "#90a0b7", marginTop: 8 }}>
              One GraphQL document → one SQL statement. <code>count / sum / avg / min / max</code>{" "}
              across <code>issues.story_points</code> and <code>time_entries.hours</code> in the same request.
              The server compiles this to <code>SELECT jsonb_build_object(...)</code> with nested
              subqueries — the classic SQL aggregate functions, not a filter-and-count workaround.
            </div>
            {aggTimingMs != null && (
              <div className="status info" style={{ marginTop: 12 }}>
                1 GraphQL request · 1 SQL statement · 10 aggregate functions · {aggTimingMs} ms
              </div>
            )}
            {aggregate && (
              <>
                <div className="pill" style={{ marginTop: 16 }}>
                  kanbanIssuesAggregate · story_points
                </div>
                <div className="grid">
                  <StatCard label="COUNT" value={aggregate.issues.count} color="#7cbfff" />
                  <StatCard label="SUM" value={aggregate.issues.sum.story_points} color="#9bb5ff" />
                  <StatCard
                    label="AVG"
                    value={Math.round(aggregate.issues.avg.story_points * 100) / 100}
                    color="#ffb86c"
                  />
                  <StatCard label="MIN" value={aggregate.issues.min.story_points} color="#7ce0a1" />
                  <StatCard label="MAX" value={aggregate.issues.max.story_points} color="#ff7979" />
                </div>
                <div className="pill" style={{ marginTop: 20 }}>
                  kanbanTimeEntriesAggregate · hours
                </div>
                <div className="grid">
                  <StatCard label="COUNT" value={aggregate.timeEntries.count} color="#7cbfff" />
                  <StatCard label="SUM" value={aggregate.timeEntries.sum.hours} color="#9bb5ff" />
                  <StatCard
                    label="AVG"
                    value={Math.round(aggregate.timeEntries.avg.hours * 100) / 100}
                    color="#ffb86c"
                  />
                  <StatCard label="MIN" value={aggregate.timeEntries.min.hours} color="#7ce0a1" />
                  <StatCard label="MAX" value={aggregate.timeEntries.max.hours} color="#ff7979" />
                </div>
              </>
            )}
          </>
        )}

        {(mode === "search" || mode === "webSearch") && (
          <>
            <label style={{ marginTop: 12 }}>Query</label>
            <div className="row">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={mode === "webSearch" ? 'e.g. stripe OR "credit card" -refund' : "e.g. kubernetes"}
              />
              <button onClick={run} disabled={loading || session == null}>
                {loading ? "..." : "Run"}
              </button>
            </div>
            <div style={{ fontSize: 12, color: "#90a0b7", marginTop: 8 }}>
              {mode === "search" ? "plainto_tsquery — always safe, tokenizes raw input" : 'websearch_to_tsquery — supports "phrase" / OR / -exclude'}
            </div>
          </>
        )}

        {mode === "rest" && (
          <>
            <div style={{ marginTop: 12 }}>
              <button onClick={run} disabled={loading || session == null}>
                {loading ? "..." : "db.rest.get('/issues')"}
              </button>
            </div>
            <div style={{ fontSize: 12, color: "#90a0b7", marginTop: 8 }}>
              <code>GET /api/v1/issues?select=id,title,status,priority&amp;limit=5</code>
              <br />
              Headers: <code>Accept-Profile: kanban</code>, <code>Prefer: count=exact</code>
              <br />
              <code>Prefer: count=exact</code> asks the server to return the total row count in the{" "}
              <code>pagination.total</code> envelope field and the <code>Content-Range</code> header — a single round
              trip that returns both the page and the count, PostgREST-style.
            </div>
            {restPayload != null && (
              <pre style={{ marginTop: 12, maxHeight: 260 }}>{JSON.stringify(restPayload, null, 2)}</pre>
            )}
          </>
        )}

        {mode === "vector" && (
          <>
            <div style={{ marginTop: 12 }}>
              <button onClick={run} disabled={loading || session == null}>
                {loading ? "..." : "Run k-NN near [0,0,1]"}
              </button>
            </div>
            <div style={{ fontSize: 12, color: "#90a0b7", marginTop: 8 }}>
              <code>vector: &#123; column: "embedding", near: [0,0,1], distance: "COSINE", limit: 5 &#125;</code>
            </div>
          </>
        )}

        {issues.length > 0 && (
          <>
            {totalCount != null && (
              <div style={{ fontSize: 12, color: "#90a0b7", marginTop: 16 }}>
                Showing {issues.length}
                {totalCount > 0 ? ` of ${totalCount}` : ""}
              </div>
            )}
            <ul className="issues" style={{ marginTop: 12 }}>
              {issues.map((i) => (
                <li key={i.id}>
                  <span>
                    <span className="issue-id">#{i.id}</span> {i.title}
                  </span>
                  <span className="pill">
                    {i.priority} · {i.status}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="panel">
        <h2>SDK introspection</h2>
        <pre>
{`url:         ${db.url}
projectId:   ${db.projectId}
graphql:     ${db.graphqlEndpoint()}
rest:        ${db.restEndpoint("/issues")}
auth token:  ${db.authEndpoint("/token")}
session:     ${session ? session.accessToken.slice(0, 20) + "…" : "(none)"}`}
        </pre>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="stat">
      <div className="stat-label" style={{ color }}>
        {label}
      </div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
