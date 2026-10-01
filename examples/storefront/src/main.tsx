import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { NotConfigured } from "./components/NotConfigured";
import { SessionProvider } from "./hooks/session";
import { createStoreClient } from "./lib/client";
import { readConfig } from "./lib/config";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 5_000 } },
});

const config = readConfig();
const root = ReactDOM.createRoot(document.getElementById("root")!);

root.render(
  <React.StrictMode>
    {config ? (
      <QueryClientProvider client={queryClient}>
        <SessionProvider db={createStoreClient(config)} config={config}>
          <App />
        </SessionProvider>
      </QueryClientProvider>
    ) : (
      <NotConfigured />
    )}
  </React.StrictMode>,
);
