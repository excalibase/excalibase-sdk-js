/**
 * Live: one client against a running platform's edge, given only the base URL,
 * the project id and the key. Skipped unless SDK_LIVE_URL is set.
 *
 * The project comes from test/live/platform-setup.mjs (a `notes` table the
 * `user` role reads and inserts, realtime on it, the `uploads.mint` and
 * `uploads.complete` functions, an end user); test/live/k3d-platform.sh brings
 * up platform-aio on k3d behind the HAProxy edge and runs both.
 */
import WebSocket from "ws";
import { createClient, memoryStorageAdapter } from "../src";

const env = (name: string): string => process.env[name] ?? "";
const LIVE = env("SDK_LIVE_URL").length > 0;
const describeLive = LIVE ? describe : describe.skip;

interface Note {
  id: number;
  body: string;
}

interface NoteChange {
  operation: string;
  data: Note | { new?: Note };
}

function client() {
  return createClient({
    url: env("SDK_LIVE_URL"),
    projectId: env("SDK_LIVE_PROJECT_ID"),
    orgSlug: env("SDK_LIVE_ORG_SLUG") || undefined,
    key: env("SDK_LIVE_KEY"),
    storage: memoryStorageAdapter(),
    autoRefreshToken: false,
    WebSocket,
  });
}

describeLive("live: createClient({ url, projectId, key }) on the platform edge", () => {
  let db: ReturnType<typeof client>;
  const marker = `live-${Date.now()}`;

  beforeAll(async () => {
    db = client();
    await db.auth.signInWithPassword({ email: env("SDK_LIVE_EMAIL"), password: env("SDK_LIVE_PASSWORD") });
  }, 30_000);

  afterAll(async () => {
    await db.auth.signOut().catch(() => undefined);
  });

  it("signs in through /auth/{org}/{projectId}", () => {
    const session = db.auth.currentSession();
    expect(session?.accessToken).toEqual(expect.any(String));
    expect(session?.user?.email).toBe(env("SDK_LIVE_EMAIL"));
  });

  it("writes and reads through /{projectId}/graphql", async () => {
    const created = await db.graphql.mutation<{ createPublicNotes: Note }>(
      "mutation ($body: String!) { createPublicNotes(input: { body: $body }) { id body } }",
      { body: `${marker}-graphql` },
    );
    expect(created.createPublicNotes.body).toBe(`${marker}-graphql`);
    const read = await db.graphql.query<{ publicNotes: Note[] }>("{ publicNotes(orderBy: { id: ASC }) { id body } }");
    expect(read.publicNotes.map((n) => n.body)).toContain(`${marker}-graphql`);
  }, 30_000);

  it("writes and reads through /{projectId}/api/v1", async () => {
    await db.rest.post("/notes", { body: `${marker}-rest` });
    const rows = await db.rest.get<Note[] | { data: Note[] }>(`/notes?select=id,body&body=eq.${marker}-rest`);
    const list = Array.isArray(rows) ? rows : rows.data;
    expect(list.map((n) => n.body)).toEqual([`${marker}-rest`]);
  }, 30_000);

  it("receives an insert over the realtime WebSocket at /{projectId}/graphql", async () => {
    const body = `${marker}-realtime`;
    const received = new Promise<NoteChange>((resolve, reject) => {
      const sub = db.graphql.subscribe<{ publicNotesChanges: NoteChange }>(
        "subscription { publicNotesChanges { operation table data } }",
        {
          next: (data) => {
            const change = data.publicNotesChanges;
            const row = "new" in change.data ? change.data.new : (change.data as Note);
            if (row?.body === body) {
              sub.unsubscribe();
              resolve(change);
            }
          },
          error: reject,
        },
      );
    });
    // The change stream may need a moment to attach; insert until one arrives.
    let arrived = false;
    void received.then(() => (arrived = true), () => (arrived = true));
    for (let attempt = 0; attempt < 30 && !arrived; attempt += 1) {
      await db.graphql.mutation("mutation ($body: String!) { createPublicNotes(input: { body: $body }) { id } }", { body });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const change = await received;
    expect(change.operation).toBe("INSERT");
  }, 90_000);

  it("uploads a file through /functions/v1/{projectId}", async () => {
    const blob = new Blob([`hello from ${marker}`], { type: "text/plain" });
    const { storageId } = await db.storage.uploadFile(blob, {
      ref: { moduleName: "uploads", exportName: "mint" },
      completeRef: { moduleName: "uploads", exportName: "complete" },
    });
    expect(storageId).toEqual(expect.any(String));
    expect(storageId.length).toBeGreaterThan(0);
  }, 60_000);
});
