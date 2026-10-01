import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { DbClient, Session } from "@excalibase/sdk";
import type { StoreConfig } from "../lib/config";
import { claimsOf, roleOf } from "../lib/token";

interface SessionState {
  db: DbClient;
  config: StoreConfig;
  ready: boolean;
  session: Session | null;
  role: string;
  email: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, fullName: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ db, config, children }: { db: DbClient; config: StoreConfig; children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    void db.auth.hydrate().then((restored) => {
      if (!live) return;
      setSession(restored);
      setReady(true);
    });
    const { unsubscribe } = db.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => {
      live = false;
      unsubscribe();
    };
  }, [db]);

  const value = useMemo<SessionState>(() => {
    const token = session?.accessToken ?? null;
    const claims = claimsOf(token);
    return {
      db,
      config,
      ready,
      session,
      role: roleOf(token),
      email: claims.email ?? session?.user?.email ?? null,
      signIn: async (email, password) => {
        await db.auth.signInWithPassword({ email, password });
      },
      signUp: async (email, password, fullName) => {
        await db.auth.signUp({ email, password, fullName });
      },
      signOut: async () => {
        await db.auth.signOut();
      },
    };
  }, [db, config, ready, session]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
