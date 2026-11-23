import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, FileText, Loader2, Save, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { normalizeError, type ApiError } from "@/lib/errors";
import { toastError, toastSuccess } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** "Support report" button + preview dialog (copy / save). */
export function SupportReportButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);

  // Request counter: ignore responses that were superseded or arrive after close.
  const reqId = useRef(0);

  const show = () => {
    const id = ++reqId.current;
    setOpen(true);
    setReport(null);
    setError(null);
    api.getSupportReport().then(
      (r) => {
        if (id === reqId.current) setReport(r);
      },
      (e) => {
        if (id === reqId.current) setError(normalizeError(e));
      },
    );
  };

  const onOpenChange = (o: boolean) => {
    if (!o) reqId.current++;
    setOpen(o);
  };

  const copy = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report);
      toastSuccess(t("Report copied"), t("Paste it into your message to Starlink support."));
    } catch (e) {
      toastError(e, t("Could not copy"));
    }
  };

  const save = async () => {
    if (!report) return;
    setSaving(true);
    try {
      // Native save dialog; null = cancelled, say nothing.
      const path = await api.exportSupportReport(report);
      if (path) toastSuccess(t("Report saved"), t("Saved to {{path}}", { path }));
    } catch (e) {
      toastError(e, t("Could not save"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={show}>
        <FileText aria-hidden />
        {t("Support report")}
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-lg">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t("Report for Starlink support")}</DialogTitle>
            <DialogDescription className="flex items-start gap-1.5">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-good" aria-hidden />
              {t("A summary of the last 24 hours, outages from the last 48 hours and uptime up to 30 days. It contains no serial numbers or IDs, no location and no device names.")}
            </DialogDescription>
          </DialogHeader>
          {/* Only the body scrolls: header and buttons stay visible. */}
          <div className="-mx-4 flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
            {report !== null ? (
              <pre
                tabIndex={0}
                aria-label={t("Report preview")}
                className="num rounded-lg bg-muted/50 px-3 py-2 text-[0.6875rem] leading-relaxed whitespace-pre-wrap text-muted-foreground ring-1 ring-border"
              >
                {report}
              </pre>
            ) : error ? (
              <p role="alert" className="text-sm text-critical">
                {error.message}
              </p>
            ) : (
              <Skeleton className="h-48 rounded-lg" />
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={copy} disabled={!report}>
              <Copy aria-hidden />
              {t("Copy")}
            </Button>
            <Button onClick={save} disabled={!report || saving}>
              {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
              {t("Save…")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
