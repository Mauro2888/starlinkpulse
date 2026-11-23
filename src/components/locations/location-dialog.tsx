import { useState, type FormEvent } from "react";
import { Check, Loader2, MapPin, Pencil, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { toastError, toastSuccess } from "@/lib/notify";
import { formatDuration } from "@/lib/format";
import { useLocationStats, useSettings } from "@/hooks/use-pulse";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const MAX_NAME = 40;

/** Set, rename and remove location tags. New data is tagged with the active location. */
export function LocationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const { settings, save } = useSettings();
  const stats = useLocationStats();
  const current = settings?.activeLocation ?? null;
  const [name, setName] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const names = (stats.data ?? []).map((l) => l.name).filter((n) => n !== "");
  const trimmed = name.trim();
  const tooLong = trimmed.length > MAX_NAME;

  const setActive = async (next: string | null) => {
    if (!settings) return;
    setBusy(true);
    try {
      await save({ ...settings, activeLocation: next });
      toastSuccess(next ? t("Location set to {{name}}", { name: next }) : t("Location cleared"));
      onOpenChange(false);
    } catch (e) {
      toastError(e, t("Couldn't change the location"));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || tooLong) return;
    void setActive(trimmed);
  };

  const rename = async (from: string) => {
    const to = editValue.trim();
    if (!to || to.length > MAX_NAME || to === from) {
      setEditing(null);
      return;
    }
    try {
      await api.renameLocation(from, to);
      if (current === from && settings) await save({ ...settings, activeLocation: to });
      stats.refresh();
      setEditing(null);
    } catch (err) {
      toastError(err, t("Couldn't rename the location"));
    }
  };

  const remove = async (target: string) => {
    try {
      await api.deleteLocation(target);
      if (current === target && settings) await save({ ...settings, activeLocation: null });
      stats.refresh();
      setConfirmDelete(null);
    } catch (err) {
      toastError(err, t("Couldn't remove the location"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Location")}</DialogTitle>
          <DialogDescription>
            {t("New measurements are tagged with this location, so you can compare places later (home, campsite, boat…).")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-1.5">
          <Label htmlFor="location-name" className="text-xs">
            {t("Current location")}
          </Label>
          <div className="flex gap-2">
            <Input
              id="location-name"
              list="location-suggestions"
              value={name}
              maxLength={MAX_NAME + 10}
              placeholder={t("e.g. Home")}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={tooLong || undefined}
              aria-describedby="location-name-desc"
              autoComplete="off"
            />
            <datalist id="location-suggestions">
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            <Button type="submit" disabled={busy || !trimmed || tooLong || trimmed === current}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <MapPin aria-hidden />}
              {t("Use")}
            </Button>
          </div>
          <p id="location-name-desc" className={tooLong ? "text-[0.6875rem] text-critical" : "text-[0.6875rem] text-muted-foreground"}>
            {tooLong
              ? t("Use at most {{max}} characters.", { max: MAX_NAME })
              : t("Type a new name or pick one you used before.")}
          </p>
          {current && (
            <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => void setActive(null)} disabled={busy}>
              {t("Stop tagging (no location)")}
            </Button>
          )}
        </form>

        {names.length > 0 && (
          <section aria-labelledby="saved-locations" className="flex flex-col gap-1.5 border-t border-border pt-3">
            <h3 id="saved-locations" className="eyebrow">
              {t("Saved locations")}
            </h3>
            <ul className="flex flex-col divide-y divide-border">
              {(stats.data ?? [])
                .filter((l) => l.name !== "")
                .map((l) => (
                  <li key={l.name} className="flex items-center gap-2 py-1.5 text-sm">
                    {editing === l.name ? (
                      <form
                        className="flex flex-1 items-center gap-1.5"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void rename(l.name);
                        }}
                      >
                        <Label htmlFor={`rename-${l.name}`} className="sr-only">
                          {t("New name for {{name}}", { name: l.name })}
                        </Label>
                        <Input
                          id={`rename-${l.name}`}
                          value={editValue}
                          maxLength={MAX_NAME}
                          onChange={(e) => setEditValue(e.target.value)}
                          autoFocus
                          className="h-7"
                        />
                        <Button type="submit" size="icon-sm" variant="ghost" aria-label={t("Save name")}>
                          <Check aria-hidden />
                        </Button>
                        <Button type="button" size="icon-sm" variant="ghost" aria-label={t("Cancel")} onClick={() => setEditing(null)}>
                          <X aria-hidden />
                        </Button>
                      </form>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate">
                          {l.name}
                          {l.name === current && <span className="ml-1.5 text-xs text-primary">· {t("current")}</span>}
                          <span className="block text-[0.6875rem] text-muted-foreground">
                            {t("{{duration}} of data", { duration: formatDuration(l.coveredS) })}
                          </span>
                        </span>
                        {confirmDelete === l.name ? (
                          <>
                            <Button size="sm" variant="destructive" onClick={() => void remove(l.name)}>
                              {t("Remove tag")}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                              {t("Keep")}
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={t("Rename {{name}}", { name: l.name })}
                              onClick={() => {
                                setEditing(l.name);
                                setEditValue(l.name);
                              }}
                            >
                              <Pencil aria-hidden />
                            </Button>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={t("Remove {{name}}", { name: l.name })}
                              onClick={() => setConfirmDelete(l.name)}
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          </>
                        )}
                      </>
                    )}
                  </li>
                ))}
            </ul>
            <p className="text-[0.6875rem] text-muted-foreground">
              {t("Removing a tag keeps the measurements; they just no longer belong to that place.")}
            </p>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
