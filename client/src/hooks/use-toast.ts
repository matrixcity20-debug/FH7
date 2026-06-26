import { useState, useCallback } from "react";

export interface Toast {
  id: string;
  title?: string;
  description?: string;
  variant?: "default" | "destructive";
}

let toastListeners: Array<(toasts: Toast[]) => void> = [];
let toastList: Toast[] = [];

function notifyListeners() {
  toastListeners.forEach((fn) => fn([...toastList]));
}

export function toast(t: Omit<Toast, "id">) {
  const id = Math.random().toString(36).slice(2);
  const newToast: Toast = { id, ...t };
  toastList = [...toastList, newToast];
  notifyListeners();
  setTimeout(() => {
    toastList = toastList.filter((x) => x.id !== id);
    notifyListeners();
  }, 4000);
}

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const subscribe = useCallback(() => {
    const fn = (updated: Toast[]) => setToasts(updated);
    toastListeners.push(fn);
    setToasts([...toastList]);
    return () => {
      toastListeners = toastListeners.filter((l) => l !== fn);
    };
  }, []);

  useState(() => {
    return subscribe();
  });

  return { toast, toasts };
}
