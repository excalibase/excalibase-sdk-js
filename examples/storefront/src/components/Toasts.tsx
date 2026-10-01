import { useCallback, useState } from "react";
import { BellRing } from "lucide-react";

export interface Toast {
  id: number;
  text: string;
}

export function useToasts() {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setItems((current) => [...current, { id, text }]);
    setTimeout(() => setItems((current) => current.filter((toast) => toast.id !== id)), 6000);
  }, []);
  return { items, push };
}

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} data-testid="toast" className="flex items-center gap-2 rounded-lg bg-stone-900 text-white px-4 py-3 shadow-lg text-sm">
          <BellRing size={16} className="text-amber-300" />
          {toast.text}
        </div>
      ))}
    </div>
  );
}
