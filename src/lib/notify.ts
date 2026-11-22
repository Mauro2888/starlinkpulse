import { toast } from "sonner";
import { errorTitle, normalizeError } from "@/lib/errors";

export function toastError(err: unknown, context?: string): void {
  const e = normalizeError(err);
  toast.error(context ? `${context}: ${errorTitle(e.kind)}` : errorTitle(e.kind), { description: e.message });
}

export function toastSuccess(title: string, description?: string): void {
  toast.success(title, description ? { description } : undefined);
}
