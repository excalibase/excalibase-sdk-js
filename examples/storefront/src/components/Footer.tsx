import { useSession } from "../hooks/session";

export function Footer() {
  const { config } = useSession();
  return (
    <footer className="border-t border-stone-200 py-6 text-center text-xs text-stone-400">
      A demo store built on Excalibase · project {config.projectId}
    </footer>
  );
}
