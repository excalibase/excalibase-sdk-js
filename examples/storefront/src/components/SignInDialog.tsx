import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useSession } from "../hooks/session";
import { messageOf } from "../lib/store";

export function SignInDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { signIn, signUp } = useSession();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "sign-in") await signIn(email.trim(), password);
      else await signUp(email.trim(), password, fullName.trim());
      setPassword("");
      onClose();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-stone-900/40 z-40" />
        <Dialog.Content className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[380px] card p-6" data-testid="sign-in-dialog">
          <div className="flex items-center justify-between mb-4">
            <Dialog.Title className="font-display text-xl">{mode === "sign-in" ? "Welcome back" : "Create an account"}</Dialog.Title>
            <Dialog.Close className="btn-icon" aria-label="Close"><X size={16} /></Dialog.Close>
          </div>
          <Dialog.Description className="text-sm text-stone-500 mb-4">
            Accounts belong to this store's project, signed in through Excalibase auth.
          </Dialog.Description>
          <form onSubmit={submit} className="flex flex-col gap-3">
            {mode === "sign-up" && (
              <input className="input" placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
            )}
            <input className="input" type="email" placeholder="Email" autoComplete="username" data-testid="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input className="input" type="password" placeholder="Password" autoComplete="current-password" data-testid="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            {error && <p className="text-sm text-red-600" data-testid="sign-in-error">{error}</p>}
            <button className="btn btn-primary justify-center" disabled={busy} data-testid="sign-in-submit">
              {mode === "sign-in" ? "Sign in" : "Create account"}
            </button>
          </form>
          <button className="mt-3 text-sm text-stone-500 hover:text-stone-800" onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}>
            {mode === "sign-in" ? "New here? Create an account" : "Have an account? Sign in"}
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
