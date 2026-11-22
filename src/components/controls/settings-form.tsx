import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import type { MockMode, MockProfile, Settings } from "@/types/models";
import { CLAUDE_MODEL_OPTIONS } from "@/lib/advisor";
import {
  MOCK_MODE_LABELS,
  MOCK_PROFILE_LABELS,
  validateSettings,
  type SettingsErrors,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Section } from "@/components/state-panels";

interface Props {
  settings: Settings;
  onSave: (next: Settings) => Promise<void>;
  /** Id applied to the read-only switch so other screens can focus it. */
  readOnlySwitchId?: string;
}

export function SettingsForm({ settings, onSave, readOnlySwitchId = "read-only-switch" }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [saving, setSaving] = useState(false);

  // Adopt fresh server values unless the user is editing.
  useEffect(() => setDraft(settings), [settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const clean = { ...draft, dishAddress: draft.dishAddress.trim(), routerAddress: draft.routerAddress.trim(), claudeModel: draft.claudeModel.trim() };
    const errs = validateSettings(clean);
    setErrors(errs);
    if (Object.keys(errs).length) {
      const form = ev.currentTarget as HTMLFormElement;
      requestAnimationFrame(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setSaving(true);
    try {
      await onSave(clean);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Settings" id="settings">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">Safety</legend>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor={readOnlySwitchId} className="text-sm">
                Read-only mode
              </Label>
              <p id="read-only-desc" className="mt-0.5 text-xs text-muted-foreground">
                Blocks reboot, stow and snow melt changes.
              </p>
            </div>
            <Switch
              id={readOnlySwitchId}
              aria-describedby="read-only-desc"
              checked={draft.readOnly}
              onCheckedChange={(v) => set("readOnly", v)}
            />
          </div>
          {settings.readOnly && !draft.readOnly && (
            <p className="flex items-start gap-2 text-xs text-warning">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>Dish controls will be unlocked after you save. Each action still asks for confirmation.</span>
            </p>
          )}
        </fieldset>

        <fieldset className="border-t border-border pt-4">
          <legend className="eyebrow mb-2">App</legend>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor="close-to-tray-switch" className="text-sm">
                Keep running in the menu bar / tray when the window is closed
              </Label>
              <p id="close-to-tray-desc" className="mt-0.5 text-xs text-muted-foreground">
                History keeps recording in the background. Quit from the tray menu.
              </p>
            </div>
            <Switch
              id="close-to-tray-switch"
              aria-describedby="close-to-tray-desc"
              checked={draft.closeToTray}
              onCheckedChange={(v) => set("closeToTray", v)}
            />
          </div>
        </fieldset>

        <fieldset className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
          <legend className="eyebrow mb-2">Connection</legend>
          <Field label="Dish address" error={errors.dishAddress} hint="Default 192.168.100.1:9200">
            {(p) => (
              <Input
                {...p}
                value={draft.dishAddress}
                onChange={(e) => set("dishAddress", e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                className="num"
              />
            )}
          </Field>
          <Field label="Router address" error={errors.routerAddress} hint="Optional. Starlink router only.">
            {(p) => (
              <Input
                {...p}
                value={draft.routerAddress}
                onChange={(e) => set("routerAddress", e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                placeholder="192.168.1.1:9000"
                className="num"
              />
            )}
          </Field>
          <Field label="Live refresh" error={errors.livePollIntervalS} hint="Seconds between live readings (1–60).">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={1}
                max={60}
                step={1}
                inputMode="numeric"
                value={Number.isFinite(draft.livePollIntervalS) ? draft.livePollIntervalS : ""}
                onChange={(e) => set("livePollIntervalS", e.target.value === "" ? NaN : Number(e.target.value))}
                className="num"
              />
            )}
          </Field>
        </fieldset>

        <fieldset className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
          <legend className="eyebrow mb-2">Mock mode</legend>
          <Field label="Use simulated data" hint="For testing without a dish.">
            {(p) => (
              <Select value={draft.mockMode} onValueChange={(v) => set("mockMode", v as MockMode)}>
                <SelectTrigger id={p.id} aria-describedby={p["aria-describedby"]} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(MOCK_MODE_LABELS) as MockMode[]).map((m) => (
                    <SelectItem key={m} value={m}>
                      {MOCK_MODE_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label="Mock profile" hint={draft.mockMode === "off" ? "Mock mode is off." : "Dish model and condition to simulate."}>
            {(p) => (
              <Select
                value={draft.mockProfile}
                onValueChange={(v) => set("mockProfile", v as MockProfile)}
                disabled={draft.mockMode === "off"}
              >
                <SelectTrigger id={p.id} aria-describedby={p["aria-describedby"]} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(MOCK_PROFILE_LABELS) as MockProfile[]).map((m) => (
                    <SelectItem key={m} value={m}>
                      {MOCK_PROFILE_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
        </fieldset>

        <fieldset className="grid gap-3 border-t border-border pt-4">
          <legend className="eyebrow mb-2">AI Advisor</legend>
          <ModelPicker
            value={draft.claudeModel}
            error={errors.claudeModel}
            onChange={(v) => set("claudeModel", v)}
          />
        </fieldset>

        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          {dirty && <span className="mr-auto text-xs text-muted-foreground">Unsaved changes</span>}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(settings);
              setErrors({});
            }}
          >
            Revert
          </Button>
          <Button type="submit" size="sm" disabled={!dirty || saving}>
            {saving && <Loader2 className="animate-spin" aria-hidden />}
            Save settings
          </Button>
        </div>
      </form>
    </Section>
  );
}

interface FieldA11y {
  id: string;
  "aria-describedby": string;
  "aria-invalid"?: true;
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (props: FieldA11y) => ReactNode;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children({ id, "aria-describedby": descId, ...(error ? { "aria-invalid": true as const } : {}) })}
      <p id={descId} className={cn("text-[0.6875rem]", error ? "text-critical" : "text-muted-foreground")}>
        {error ?? hint}
      </p>
    </div>
  );
}

const CUSTOM = "__custom__";

/** Preset Claude models plus a free-text custom model id. */
function ModelPicker({ value, error, onChange }: { value: string; error?: string; onChange: (v: string) => void }) {
  const isPreset = CLAUDE_MODEL_OPTIONS.some((m) => m.id === value);
  const [custom, setCustom] = useState(!isPreset);
  const selected = custom ? CUSTOM : value;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor="claude-model" className="text-xs">
          Claude model
        </Label>
        <Select
          value={selected}
          onValueChange={(v) => {
            if (v === CUSTOM) {
              setCustom(true);
              return;
            }
            setCustom(false);
            onChange(v);
          }}
        >
          <SelectTrigger id="claude-model" aria-describedby="claude-model-desc" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CLAUDE_MODEL_OPTIONS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
                <span className="text-muted-foreground"> · {m.hint}</span>
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM}>Custom model ID</SelectItem>
          </SelectContent>
        </Select>
        <p id="claude-model-desc" className={cn("text-[0.6875rem]", error && !custom ? "text-critical" : "text-muted-foreground")}>
          {error && !custom ? error : custom ? "Enter any model ID your key can use." : "Used for AI Advisor analysis."}
        </p>
      </div>
      {custom && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="claude-model-custom" className="text-xs">
            Custom model ID
          </Label>
          <Input
            id="claude-model-custom"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            placeholder="claude-…"
            aria-invalid={error ? true : undefined}
            aria-describedby="claude-model-custom-desc"
            className="num"
          />
          <p id="claude-model-custom-desc" className={cn("text-[0.6875rem]", error ? "text-critical" : "text-muted-foreground")}>
            {error ?? "For example a dated model snapshot."}
          </p>
        </div>
      )}
    </div>
  );
}
