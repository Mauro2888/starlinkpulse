import { useTranslation } from "react-i18next";
import { useRef, useState, type FormEvent } from "react";
import { CircleCheck, KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Group } from "@/components/controls/settings-ui";

interface Props {
  hasKey: boolean | null;
  error: string | null;
  onSave: (key: string) => Promise<void>;
  onDelete: () => Promise<void>;
}

/** Write-only key entry: the stored key is never read back or displayed. */
export function ApiKeyCard({ hasKey, error, onSave, onDelete }: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleted = useRef(false);
  const showForm = hasKey === false || editing;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    try {
      await onSave(value.trim());
      setValue("");
      setEditing(false);
    } catch {
      // Error toast is raised by the caller; keep the field for correction.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group title={t("Anthropic API key")} id="api-key">
      <div className="flex flex-col gap-3 px-4 py-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("Used only when you ask Claude to explain a diagnosis. Stored in your system keychain, never shown again.")}
        </p>

        {hasKey === null && !error && <p className="text-sm text-muted-foreground">{t("Checking keychain…")}</p>}
        {error && <p className="text-sm text-critical">{error}</p>}

        {hasKey && !editing && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto flex items-center gap-2 text-sm" role="status">
              <CircleCheck className="size-4 text-good" aria-hidden /> {t("Key saved")}
            </span>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              {t("Replace")}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setConfirmDelete(true)}>
              {t("Delete")}
            </Button>
          </div>
        )}

        {showForm && (
          <form onSubmit={submit} className="flex flex-col gap-1.5">
            <Label htmlFor="api-key-input" className="text-xs">
              {hasKey ? t("New API key") : t("API key")}
            </Label>
            <div className="flex gap-2">
              <Input
                id="api-key-input"
                autoFocus={editing}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-ant-…"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="num"
              />
              <Button type="submit" size="default" disabled={!value.trim() || busy}>
                {busy ? <Loader2 className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />}
                {t("Save")}
              </Button>
              {editing && (
                <Button type="button" variant="ghost" onClick={() => { setEditing(false); setValue(""); }}>
                  {t("Cancel")}
                </Button>
              )}
            </div>
          </form>
        )}
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            // After deleting, the Delete button is gone: move focus to the key field.
            if (deleted.current) {
              e.preventDefault();
              deleted.current = false;
              requestAnimationFrame(() => document.getElementById("api-key-input")?.focus());
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Delete the API key?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("The key is removed from your keychain. Claude explanations stop working until you add a key again. Diagnose keeps working.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => {
                deleted.current = true;
                void onDelete().catch(() => undefined);
              }}>
              {t("Delete key")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Group>
  );
}
