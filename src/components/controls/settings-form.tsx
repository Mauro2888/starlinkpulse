import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { tk } from "@/i18n/keys";
import { BellRing, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import type {
  AiProvider,
  AppLanguage,
  BatteryConfig,
  LanDashboardSettings,
  LocalAiKind,
  MockMode,
  MockProfile,
  NotificationSettings,
  Settings,
} from "@/types/models";
import { resolveLanguage } from "@/i18n";
import { batteryWh } from "@/lib/energy";
import { fmtNum } from "@/lib/format";
import { CLAUDE_MODEL_OPTIONS, isLoopbackUrl } from "@/lib/advisor";
import { normalizeError } from "@/lib/errors";
import { api } from "@/lib/api";
import { toastError, toastSuccess } from "@/lib/notify";
import {
  MOCK_MODE_LABELS,
  MOCK_PROFILE_LABELS,
  NOTIFICATION_TYPES,
  formatHour,
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
import { AppUpdates } from "@/components/controls/app-updates";
import { LanDashboardStatus } from "@/components/controls/lan-dashboard";
import { useRefreshAll } from "@/hooks/use-pulse";

interface Props {
  settings: Settings;
  onSave: (next: Settings) => Promise<void>;
  /** Id applied to the read-only switch so other screens can focus it. */
  readOnlySwitchId?: string;
}

export function SettingsForm({ settings, onSave, readOnlySwitchId = "read-only-switch" }: Props) {
  const { t } = useTranslation();
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
    <Section title={t("Settings")} id="settings">
      {/* Sections flow into two columns on wide windows. */}
      <form onSubmit={submit} noValidate className="grid gap-x-6 gap-y-4 dash3:grid-cols-2">
        <fieldset className="flex flex-col gap-3 dash3:col-span-2">
          <legend className="sr-only">{t("Safety")}</legend>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor={readOnlySwitchId} className="text-sm">
                {t("Read-only mode")}
              </Label>
              <p id="read-only-desc" className="mt-0.5 text-xs text-muted-foreground">
                {t("Blocks reboot, stow and snow melt changes.")}
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
              <span>{t("Dish controls will be unlocked after you save. Each action still asks for confirmation.")}</span>
            </p>
          )}
        </fieldset>

        <fieldset className="border-t border-border pt-4">
          <legend className="eyebrow mb-2">{t("App")}</legend>
          <div className="mb-3">
            <Field label={t("Language")} hint={t("Applies after you save.")}>
              {(p) => (
                <Select value={draft.language} onValueChange={(v) => set("language", v as AppLanguage)}>
                  <SelectTrigger id={p.id} aria-describedby={p["aria-describedby"]} className="w-full sm:w-64">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">
                      {t("System ({{language}})", { language: LANGUAGE_NAMES[resolveLanguage("system")] })}
                    </SelectItem>
                    <SelectItem value="en" lang="en">
                      {LANGUAGE_NAMES.en}
                    </SelectItem>
                    <SelectItem value="it" lang="it">
                      {LANGUAGE_NAMES.it}
                    </SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor="close-to-tray-switch" className="text-sm">
                {t("Keep running in the menu bar / tray when the window is closed")}
              </Label>
              <p id="close-to-tray-desc" className="mt-0.5 text-xs text-muted-foreground">
                {t("History keeps recording in the background. Quit from the tray menu.")}
              </p>
            </div>
            <Switch
              id="close-to-tray-switch"
              aria-describedby="close-to-tray-desc"
              checked={draft.closeToTray}
              onCheckedChange={(v) => set("closeToTray", v)}
            />
          </div>
          <div className="mt-3 flex items-start justify-between gap-4">
            <div>
              <Label htmlFor="launch-at-login-switch" className="text-sm">
                {t("Open StarlinkPulse when you log in")}
              </Label>
              <p id="launch-at-login-desc" className="mt-0.5 text-xs text-muted-foreground">
                {t("Starts in the menu bar / tray so history keeps recording.")}
              </p>
            </div>
            <Switch
              id="launch-at-login-switch"
              aria-describedby="launch-at-login-desc"
              checked={draft.launchAtLogin}
              onCheckedChange={(v) => set("launchAtLogin", v)}
            />
          </div>
          <div className="mt-3">
            <AppUpdates />
          </div>
        </fieldset>

        <NotificationFields
          value={draft.notifications}
          error={errors.quietHours}
          onChange={(n) => {
            setDraft((d) => ({ ...d, notifications: n }));
            setErrors((e) => ({ ...e, quietHours: undefined }));
          }}
        />

        <fieldset className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
          <legend className="eyebrow mb-2">{t("Data plan")}</legend>
          <Field label={t("Monthly data cap (GB)")} error={errors.dataCapGb} hint={t("Optional. Used for usage alerts.")}>
            {(p) => (
              <Input
                {...p}
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                placeholder={t("No cap")}
                value={draft.dataCapGb === null ? "" : Number.isFinite(draft.dataCapGb) ? draft.dataCapGb : ""}
                onChange={(e) => set("dataCapGb", e.target.value === "" ? null : Number(e.target.value))}
                className="num"
              />
            )}
          </Field>
          <Field label={t("Cycle resets on day")} error={errors.billingCycleDay} hint={t("Day of the month (1–28), as on your bill.")}>
            {(p) => (
              <Select value={String(draft.billingCycleDay)} onValueChange={(v) => set("billingCycleDay", Number(v))}>
                <SelectTrigger id={p.id} aria-describedby={p["aria-describedby"]} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
        </fieldset>

        <fieldset className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
          <legend className="eyebrow mb-2">{t("Connection")}</legend>
          <Field label={t("Dish address")} error={errors.dishAddress} hint={t("Default 192.168.100.1:9200")}>
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
          <Field label={t("Router address")} error={errors.routerAddress} hint={t("Optional. Starlink router only.")}>
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
          <Field label={t("Live refresh")} error={errors.livePollIntervalS} hint={t("Seconds between live readings (1–60).")}>
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
          <legend className="eyebrow mb-2">{t("Mock mode")}</legend>
          <Field label={t("Use simulated data")} hint={t("For testing without a dish.")}>
            {(p) => (
              <Select value={draft.mockMode} onValueChange={(v) => set("mockMode", v as MockMode)}>
                <SelectTrigger id={p.id} aria-describedby={p["aria-describedby"]} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(MOCK_MODE_LABELS) as MockMode[]).map((m) => (
                    <SelectItem key={m} value={m}>
                      {t(MOCK_MODE_LABELS[m])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label={t("Mock profile")} hint={draft.mockMode === "off" ? t("Mock mode is off.") : t("Dish model and condition to simulate.")}>
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
                      {t(MOCK_PROFILE_LABELS[m])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
        </fieldset>

        <AiFields draft={draft} saved={settings} errors={errors} set={set} />

        <BatteryFields
          value={draft.battery}
          error={errors.battery}
          onChange={(b) => {
            setDraft((d) => ({ ...d, battery: b }));
            setErrors((e) => ({ ...e, battery: undefined }));
          }}
        />

        <LanFields
          value={draft.lanDashboard ?? DEFAULT_LAN}
          saved={settings.lanDashboard ?? DEFAULT_LAN}
          error={errors.lanDashboard}
          onChange={(v) => set("lanDashboard", v)}
        />

        <div className="flex items-center justify-end gap-2 border-t border-border pt-3 dash3:col-span-2">
          {dirty && <span className="mr-auto text-xs text-muted-foreground">{t("Unsaved changes")}</span>}
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
            {t("Revert")}
          </Button>
          <Button type="submit" size="sm" disabled={!dirty || saving}>
            {saving && <Loader2 className="animate-spin" aria-hidden />}
            {t("Save settings")}
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
  const { t } = useTranslation();
  const isPreset = CLAUDE_MODEL_OPTIONS.some((m) => m.id === value);
  const [custom, setCustom] = useState(!isPreset);
  const selected = custom ? CUSTOM : value;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor="claude-model" className="text-xs">
          {t("Claude model")}
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
                <span className="text-muted-foreground"> · {t(m.hint)}</span>
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM}>{t("Custom model ID")}</SelectItem>
          </SelectContent>
        </Select>
        <p id="claude-model-desc" className={cn("text-[0.6875rem]", error && !custom ? "text-critical" : "text-muted-foreground")}>
          {error && !custom ? error : custom ? t("Enter any model ID your key can use.") : t("Used for AI explanations.")}
        </p>
      </div>
      {custom && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="claude-model-custom" className="text-xs">
            {t("Custom model ID")}
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
            {error ?? t("For example a dated model snapshot.")}
          </p>
        </div>
      )}
    </div>
  );
}

const OFF = "off";
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function HourSelect({
  id,
  value,
  onChange,
  disabled,
  describedBy,
  invalid,
}: {
  invalid?: boolean;
  id: string;
  value: number | null;
  onChange: (h: number | null) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  const { t } = useTranslation();
  return (
    <Select
      value={value === null ? OFF : String(value)}
      onValueChange={(v) => onChange(v === OFF ? null : Number(v))}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={OFF}>{t("Off")}</SelectItem>
        {HOURS.map((h) => (
          <SelectItem key={h} value={String(h)}>
            {formatHour(h)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NotificationFields({
  value,
  error,
  onChange,
}: {
  value: NotificationSettings;
  error?: string;
  onChange: (n: NotificationSettings) => void;
}) {
  const { t } = useTranslation();
  const [testing, setTesting] = useState(false);
  const set = <K extends keyof NotificationSettings>(k: K, v: NotificationSettings[K]) => onChange({ ...value, [k]: v });
  const off = !value.enabled;

  const sendTest = async () => {
    setTesting(true);
    try {
      await api.sendTestNotification();
      toastSuccess(t("Test notification sent"), t("Nothing appeared? Allow notifications for StarlinkPulse in your system settings."));
    } catch (e) {
      toastError(e, t("Test notification failed"));
    } finally {
      setTesting(false);
    }
  };

  return (
    <fieldset className="flex flex-col gap-3 border-t border-border pt-4">
      <legend className="eyebrow mb-2">{t("Notifications")}</legend>
      <div className="flex items-start justify-between gap-4">
        <div>
          <Label htmlFor="notif-enabled" className="text-sm">
            {t("Desktop notifications")}
          </Label>
          <p id="notif-enabled-desc" className="mt-0.5 text-xs text-muted-foreground">
            {t("Alerts for problems with your connection, with a cooldown to avoid repeats.")}
          </p>
        </div>
        <Switch
          id="notif-enabled"
          aria-describedby="notif-enabled-desc"
          checked={value.enabled}
          onCheckedChange={(v) => set("enabled", v)}
        />
      </div>

      <ul className={cn("grid gap-x-4 gap-y-2.5 sm:grid-cols-2", off && "opacity-60")} aria-label={t("Notification types")}>
        {NOTIFICATION_TYPES.map((nt) => {
          const id = `notif-${nt.key}`;
          return (
            <li key={nt.key} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Label htmlFor={id} className="text-xs">
                  {t(nt.label)}
                </Label>
                <p id={`${id}-desc`} className="text-[0.6875rem] text-muted-foreground">
                  {t(nt.hint)}
                </p>
              </div>
              <Switch
                id={id}
                size="sm"
                aria-describedby={`${id}-desc`}
                checked={value[nt.key]}
                disabled={off}
                onCheckedChange={(v) => set(nt.key, v)}
              />
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-1.5">
        <span id="quiet-label" className="text-xs font-medium">
          {t("Quiet hours")}
        </span>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="quiet-start" className="text-[0.6875rem] font-normal text-muted-foreground">
              {t("From")}
            </Label>
            <HourSelect
              id="quiet-start"
              invalid={Boolean(error)}
              value={value.quietStartHour}
              disabled={off}
              describedBy="quiet-desc"
              onChange={(h) => set("quietStartHour", h)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="quiet-end" className="text-[0.6875rem] font-normal text-muted-foreground">
              {t("Until")}
            </Label>
            <HourSelect
              id="quiet-end"
              value={value.quietEndHour}
              disabled={off}
              describedBy="quiet-desc"
              onChange={(h) => set("quietEndHour", h)}
            />
          </div>
        </div>
        <p id="quiet-desc" className={cn("text-[0.6875rem]", error ? "text-critical" : "text-muted-foreground")} role={error ? "alert" : undefined}>
          {error ??
            (value.quietStartHour !== null && value.quietEndHour !== null
              ? t("No notifications from {{from}} to {{to}}.", {
                  from: formatHour(value.quietStartHour),
                  to: formatHour(value.quietEndHour),
                })
              : t("Off. Notifications can arrive at any time."))}
        </p>
      </div>

      <div>
        <Button type="button" size="sm" variant="outline" onClick={sendTest} disabled={testing || off}>
          {testing ? <Loader2 className="animate-spin" aria-hidden /> : <BellRing aria-hidden />}
          {t("Send test notification")}
        </Button>
      </div>
    </fieldset>
  );
}

const PROVIDERS: { value: AiProvider; label: string; hint: string }[] = [
  { value: "off", label: tk("Off"), hint: tk("Built-in rules only. Nothing is sent anywhere.") },
  { value: "local", label: tk("Local model"), hint: tk("Ollama, LM Studio or llama.cpp on your computer. Free, no key.") },
  { value: "claude", label: tk("Claude"), hint: tk("Anthropic API with your own key. Billed to your Anthropic account.") },
];

const LOCAL_KIND_LABELS: Record<LocalAiKind, string> = {
  ollama: tk("Ollama"),
  openai_compatible: tk("OpenAI-compatible (LM Studio, llama.cpp)"),
};

const LOCAL_DEFAULT_URL: Record<LocalAiKind, string> = {
  ollama: "http://localhost:11434",
  openai_compatible: "http://localhost:1234",
};

function AiFields({
  draft,
  saved,
  errors,
  set,
}: {
  draft: Settings;
  saved: Settings;
  errors: SettingsErrors;
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
}) {
  const { t } = useTranslation();
  const remote = draft.aiProvider === "local" && draft.localAiUrl.trim() !== "" && !isLoopbackUrl(draft.localAiUrl.trim());
  return (
    <fieldset id="ai-settings" className="flex flex-col gap-3 border-t border-border pt-4">
      <legend className="eyebrow mb-2">{t("AI explanations")}</legend>
      <p className="-mt-1 text-xs text-muted-foreground">
        {t("Optional. Diagnose always works with the built-in rules; AI adds a plain-language explanation when you ask for one.")}
      </p>
      <div role="radiogroup" aria-label={t("AI provider")} className="grid gap-1.5">
        {PROVIDERS.map((p) => {
          const id = `ai-provider-${p.value}`;
          const checked = draft.aiProvider === p.value;
          return (
            <label
              key={p.value}
              htmlFor={id}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2 ring-1 transition-colors",
                checked ? "bg-primary/10 ring-primary/50" : "ring-border hover:bg-muted/50",
              )}
            >
              <input
                id={id}
                type="radio"
                name="ai-provider"
                value={p.value}
                checked={checked}
                onChange={() => set("aiProvider", p.value)}
                aria-describedby={`${id}-desc`}
                className="mt-0.5 size-3.5 shrink-0 accent-[var(--primary)]"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{t(p.label)}</span>
                <span id={`${id}-desc`} className="block text-[0.6875rem] text-muted-foreground">
                  {t(p.hint)}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {draft.aiProvider === "claude" && (
        <>
          <ModelPicker value={draft.claudeModel} error={errors.claudeModel} onChange={(v) => set("claudeModel", v)} />
          <p className="text-[0.6875rem] text-muted-foreground">
            {saved.aiProvider === "claude"
              ? t("Your API key is managed in the Anthropic API key card.")
              : t("After saving, add your API key in the Anthropic API key card that appears.")}
          </p>
        </>
      )}

      {draft.aiProvider === "local" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Server type")} hint={t("How StarlinkPulse talks to your model server.")}>
            {(p) => (
              <Select
                value={draft.localAiKind}
                onValueChange={(v) => {
                  const kind = v as LocalAiKind;
                  // Switch the default port too, unless the user typed a custom address.
                  if (Object.values(LOCAL_DEFAULT_URL).includes(draft.localAiUrl)) set("localAiUrl", LOCAL_DEFAULT_URL[kind]);
                  set("localAiKind", kind);
                }}
              >
                <SelectTrigger id={p.id} aria-describedby={p["aria-describedby"]} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(LOCAL_KIND_LABELS) as LocalAiKind[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(LOCAL_KIND_LABELS[k])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label={t("Server address")} error={errors.localAiUrl} hint={t("Default {{url}}", { url: LOCAL_DEFAULT_URL[draft.localAiKind] })}>
            {(p) => (
              <Input
                {...p}
                value={draft.localAiUrl}
                onChange={(e) => set("localAiUrl", e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                placeholder={LOCAL_DEFAULT_URL[draft.localAiKind]}
                className="num"
              />
            )}
          </Field>
          {remote && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs ring-1 ring-warning/40 sm:col-span-2">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
              <span>
                {t("This address is not this computer. Your connection summary will be sent over the network to it when you ask for an explanation.")}
              </span>
            </p>
          )}
          <div className="sm:col-span-2">
            <LocalModelPicker
              value={draft.localAiModel}
              error={errors.localAiModel}
              onChange={(v) => set("localAiModel", v)}
              serverSaved={
                saved.aiProvider === "local" &&
                saved.localAiUrl === draft.localAiUrl &&
                saved.localAiKind === draft.localAiKind
              }
            />
          </div>
        </div>
      )}
    </fieldset>
  );
}

const OTHER_MODEL = "__other__";

/** Models from `list_local_models` (for the saved server) with a free-text fallback. */
function LocalModelPicker({
  value,
  error,
  onChange,
  serverSaved,
}: {
  value: string;
  error?: string;
  onChange: (v: string) => void;
  serverSaved: boolean;
}) {
  const { t } = useTranslation();
  const [models, setModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setModels(await api.listLocalModels());
    } catch (e) {
      setModels(null);
      setLoadError(normalizeError(e).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (serverSaved) void load();
    else setModels(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSaved]);

  const list = models ?? [];
  const useSelect = list.length > 0 && !typing && (value === "" || list.includes(value));
  const hint = !serverSaved
    ? t("Save settings to load the models from this server, or type a model name.")
    : loadError
      ? t("Couldn't list models: {{error}} Type a model name instead.", { error: loadError })
      : list.length === 0 && !loading
        ? t("No models found on the server. Install one (e.g. ollama pull llama3.2:3b) or type a name.")
        : t("Models installed on your server.");

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="local-model" className="text-xs">
          {t("Model")}
        </Label>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => void load()}
          disabled={!serverSaved || loading}
          aria-label={t("Refresh model list")}
        >
          <RefreshCw className={cn(loading && "animate-spin motion-reduce:animate-none")} aria-hidden />
          {t("Refresh")}
        </Button>
      </div>
      {useSelect ? (
        <Select
          value={value || undefined}
          onValueChange={(v) => {
            if (v === OTHER_MODEL) {
              setTyping(true);
              return;
            }
            onChange(v);
          }}
        >
          <SelectTrigger
            id="local-model"
            aria-describedby="local-model-desc"
            aria-invalid={error ? true : undefined}
            className="w-full"
          >
            <SelectValue placeholder={t("Choose a model")} />
          </SelectTrigger>
          <SelectContent>
            {list.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
            <SelectItem value={OTHER_MODEL}>{t("Type a model name…")}</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <Input
          id="local-model"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          placeholder="llama3.2:3b"
          aria-describedby="local-model-desc"
          aria-invalid={error ? true : undefined}
          className="num"
        />
      )}
      <p id="local-model-desc" className={cn("text-[0.6875rem]", error ? "text-critical" : "text-muted-foreground")}>
        {error ?? hint}
      </p>
    </div>
  );
}

/** Native names: shown untranslated so people can find their language. */
const LANGUAGE_NAMES = { en: "English", it: "Italiano" } as const;

const DEFAULT_BATTERY: BatteryConfig = { capacityAh: 100, voltage: 12, usableFraction: 0.8 };

/** Optional battery for off-grid runtime estimates. */
function BatteryFields({
  value,
  error,
  onChange,
}: {
  value: BatteryConfig | null;
  error?: string;
  onChange: (b: BatteryConfig | null) => void;
}) {
  const { t } = useTranslation();
  const num = (v: string) => (v === "" ? NaN : Number(v));
  return (
    <fieldset className="flex flex-col gap-3 border-t border-border pt-4">
      <legend className="eyebrow mb-2">{t("Battery (off-grid)")}</legend>
      <div className="flex items-start justify-between gap-4">
        <div>
          <Label htmlFor="battery-switch" className="text-sm">
            {t("I power the dish from a battery")}
          </Label>
          <p id="battery-desc" className="mt-0.5 text-xs text-muted-foreground">
            {t("Shows how long the battery lasts at the current power draw.")}
          </p>
        </div>
        <Switch
          id="battery-switch"
          aria-describedby="battery-desc"
          checked={value !== null}
          onCheckedChange={(on) => onChange(on ? (value ?? DEFAULT_BATTERY) : null)}
        />
      </div>
      {value && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t("Capacity (Ah)")}>
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  step={1}
                  inputMode="decimal"
                  value={Number.isFinite(value.capacityAh) ? value.capacityAh : ""}
                  onChange={(e) => onChange({ ...value, capacityAh: num(e.target.value) })}
                  aria-invalid={error ? true : undefined}
                  className="num"
                />
              )}
            </Field>
            <Field label={t("Voltage (V)")}>
              {(p) => (
                <>
                  <Input
                    {...p}
                    type="number"
                    min={1}
                    step={0.1}
                    inputMode="decimal"
                    list="battery-voltages"
                    value={Number.isFinite(value.voltage) ? value.voltage : ""}
                    onChange={(e) => onChange({ ...value, voltage: num(e.target.value) })}
                    aria-invalid={error ? true : undefined}
                    className="num"
                  />
                  <datalist id="battery-voltages">
                    <option value="12" />
                    <option value="24" />
                    <option value="48" />
                  </datalist>
                </>
              )}
            </Field>
            <Field label={t("Usable (%)")}>
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={10}
                  max={100}
                  step={5}
                  inputMode="numeric"
                  value={Number.isFinite(value.usableFraction) ? Math.round(value.usableFraction * 100) : ""}
                  onChange={(e) => onChange({ ...value, usableFraction: num(e.target.value) / 100 })}
                  aria-invalid={error ? true : undefined}
                  className="num"
                />
              )}
            </Field>
          </div>
          <p className={cn("text-[0.6875rem]", error ? "text-critical" : "text-muted-foreground")} role={error ? "alert" : undefined}>
            {error ??
              t("≈ {{wh}} Wh usable. LiFePO4: about 80–90 %, lead-acid: about 50 %.", {
                wh: fmtNum(batteryWh(value), 0),
              })}
          </p>
        </>
      )}
    </fieldset>
  );
}

const DEFAULT_LAN: LanDashboardSettings = { enabled: false, port: 8787, token: "" };

/** Read-only LAN dashboard for phones and TVs (opt-in). */
function LanFields({
  value,
  saved,
  error,
  onChange,
}: {
  value: LanDashboardSettings;
  saved: LanDashboardSettings;
  error?: string;
  onChange: (v: LanDashboardSettings) => void;
}) {
  const { t } = useTranslation();
  const refreshAll = useRefreshAll();
  return (
    <fieldset className="flex flex-col gap-3 border-t border-border pt-4">
      <legend className="eyebrow mb-2">{t("Dashboard on phone / TV")}</legend>
      <div className="flex items-start justify-between gap-4">
        <div>
          <Label htmlFor="lan-switch" className="text-sm">
            {t("Show a read-only dashboard on your home network")}
          </Label>
          <p id="lan-desc" className="mt-0.5 text-xs text-muted-foreground">
            {t("Open it in the browser of a phone or TV. No commands, no device names.")}
          </p>
        </div>
        <Switch
          id="lan-switch"
          aria-describedby="lan-desc"
          checked={value.enabled}
          onCheckedChange={(enabled) => onChange({ ...value, enabled })}
        />
      </div>
      {value.enabled && (
        <Field label={t("Port")} error={error} hint={t("1024–65535. Save to apply.")}>
          {(p) => (
            <Input
              {...p}
              type="number"
              min={1024}
              max={65535}
              step={1}
              inputMode="numeric"
              value={Number.isFinite(value.port) ? value.port : ""}
              onChange={(e) => onChange({ ...value, port: e.target.value === "" ? NaN : Number(e.target.value) })}
              className="num sm:w-32"
            />
          )}
        </Field>
      )}
      {saved.enabled && <LanDashboardStatus saved={saved} onTokenChanged={refreshAll} />}
    </fieldset>
  );
}
