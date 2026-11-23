import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { tk } from "@/i18n/keys";
import {
  Bell,
  BellRing,
  CloudRain,
  CloudSun,
  Loader2,
  RefreshCw,
  Satellite,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  TriangleAlert,
  Wifi,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type {
  AiProvider,
  AppLanguage,
  BatteryConfig,
  EnergyPrice,
  LocalAiKind,
  MockMode,
  MockProfile,
  NotificationSettings,
  Settings,
  WeatherLocation,
  WeatherPlace,
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
  loadControlsSection,
  rememberControlsSection,
  sectionOfError,
  validateSettings,
  type ControlsSectionId,
  type SettingsErrors,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AppUpdates } from "@/components/controls/app-updates";
import { Field, Group, Row } from "@/components/controls/settings-ui";

interface Props {
  settings: Settings;
  onSave: (next: Settings) => Promise<void>;
  /** Id applied to the read-only switch so other screens can focus it. */
  readOnlySwitchId?: string;
  /** Extra content for the Dish section (below the read-only switch). */
  dish?: ReactNode;
  /** Extra content for the AI section (e.g. the API key card). */
  aiExtra?: ReactNode;
}

const SECTIONS: { id: ControlsSectionId; label: string; intro: string; icon: LucideIcon }[] = [
  { id: "dish", label: tk("Dish"), intro: tk("Control the dish and export your history."), icon: Satellite },
  { id: "general", label: tk("General"), intro: tk("Language, startup behavior and app updates."), icon: SettingsIcon },
  { id: "notifications", label: tk("Notifications"), intro: tk("Choose which problems alert you and when."), icon: Bell },
  { id: "data", label: tk("Data & energy"), intro: tk("Track your data plan, power cost and battery."), icon: Zap },
  { id: "connection", label: tk("Connection"), intro: tk("Where StarlinkPulse finds your dish."), icon: Wifi },
  {
    id: "ai",
    label: tk("AI explanations"),
    intro: tk("Optional. Diagnose always works with the built-in rules; AI adds a plain-language explanation when you ask for one."),
    icon: Sparkles,
  },
  { id: "weather", label: tk("Weather"), intro: tk("Show rain and snow next to outages."), icon: CloudSun },
];

export function SettingsForm({ settings, onSave, readOnlySwitchId = "read-only-switch", dish, aiExtra }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Settings>(settings);
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState<ControlsSectionId>(loadControlsSection);
  const rootRef = useRef<HTMLDivElement>(null);
  const errorSections = useMemo(
    () => new Set((Object.keys(errors) as (keyof SettingsErrors)[]).filter((k) => errors[k]).map(sectionOfError)),
    [errors],
  );
  const go = (id: ControlsSectionId) => {
    setSection(id);
    rememberControlsSection(id);
  };

  // Adopt fresh server values unless the user is editing.
  useEffect(() => setDraft(settings), [settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const submit = async () => {
    const clean = { ...draft, dishAddress: draft.dishAddress.trim(), routerAddress: draft.routerAddress.trim(), claudeModel: draft.claudeModel.trim() };
    const errs = validateSettings(clean);
    setErrors(errs);
    if (Object.keys(errs).length) {
      const first = SECTIONS.find((s) => (Object.keys(errs) as (keyof SettingsErrors)[]).some((k) => sectionOfError(k) === s.id));
      if (first) go(first.id);
      requestAnimationFrame(() =>
        rootRef.current?.querySelector<HTMLElement>(`#controls-${first?.id ?? section} [aria-invalid="true"]`)?.focus(),
      );
      return;
    }
    setSaving(true);
    try {
      await onSave(clean);
    } finally {
      setSaving(false);
    }
  };

  const panelForm = (children: ReactNode) => (
    <form
      onSubmit={(ev) => {
        ev.preventDefault();
        void submit();
      }}
      noValidate
      className="flex flex-col gap-5"
    >
      {children}
    </form>
  );

  return (
    <div ref={rootRef} className="flex flex-col gap-3 sm:flex-row sm:gap-8">
      <nav
        aria-label={t("Settings sections")}
        className="-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 pb-1 sm:sticky sm:top-3 sm:mx-0 sm:w-48 sm:flex-col sm:self-start sm:overflow-visible sm:p-0"
      >
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          const active = s.id === section;
          return (
            <button
              key={s.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => go(s.id)}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                active ? "bg-primary/15 font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {t(s.label)}
              {errorSections.has(s.id) && (
                <span className="size-1.5 shrink-0 rounded-full bg-critical" role="img" aria-label={t("Needs attention")} />
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex min-w-0 max-w-[680px] flex-1 flex-col gap-4">
        {SECTIONS.map((s) => (
          <section
            key={s.id}
            id={`controls-${s.id}`}
            aria-labelledby={`controls-${s.id}-title`}
            hidden={s.id !== section}
            className="flex flex-col gap-5"
          >
            <header>
              <h2 id={`controls-${s.id}-title`} className="text-xl font-semibold tracking-tight">
                {t(s.label)}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{t(s.intro)}</p>
            </header>

            {s.id === "dish" && (
              <>
                {panelForm(
                  <Group
                    title={t("Safety")}
                    footer={
                      settings.readOnly && !draft.readOnly ? (
                        <span className="flex items-start gap-1.5 text-warning">
                          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                          {t("Dish controls will be unlocked after you save. Each action still asks for confirmation.")}
                        </span>
                      ) : undefined
                    }
                  >
                    <Row label={t("Read-only mode")} htmlFor={readOnlySwitchId} descId="read-only-desc" description={t("Blocks reboot, stow and snow melt changes.")}>
                      <Switch
                        id={readOnlySwitchId}
                        aria-describedby="read-only-desc"
                        checked={draft.readOnly}
                        onCheckedChange={(v) => set("readOnly", v)}
                      />
                    </Row>
                  </Group>,
                )}
                {dish}
              </>
            )}

            {s.id === "general" &&
              panelForm(
                <>
                  <Group title={t("App")}>
                    <Field label={t("Language")} hint={t("Applies after you save.")}>
                      {(p) => (
                        <Select value={draft.language} onValueChange={(v) => set("language", v as AppLanguage)}>
                          <SelectTrigger id={p.id} aria-describedby={p["aria-describedby"]} className="w-full">
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
                    <Row
                      label={t("Keep running in the menu bar / tray when the window is closed")}
                      htmlFor="close-to-tray-switch"
                      descId="close-to-tray-desc"
                      description={t("History keeps recording in the background. Quit from the tray menu.")}
                    >
                      <Switch
                        id="close-to-tray-switch"
                        aria-describedby="close-to-tray-desc"
                        checked={draft.closeToTray}
                        onCheckedChange={(v) => set("closeToTray", v)}
                      />
                    </Row>
                    <Row
                      label={t("Open StarlinkPulse when you log in")}
                      htmlFor="launch-at-login-switch"
                      descId="launch-at-login-desc"
                      description={t("Starts in the menu bar / tray so history keeps recording.")}
                    >
                      <Switch
                        id="launch-at-login-switch"
                        aria-describedby="launch-at-login-desc"
                        checked={draft.launchAtLogin}
                        onCheckedChange={(v) => set("launchAtLogin", v)}
                      />
                    </Row>
                  </Group>
                  <Group title={t("About")}>
                    <AppUpdates />
                  </Group>
                </>,
              )}

            {s.id === "notifications" &&
              panelForm(
                <NotificationFields
                  value={draft.notifications}
                  error={errors.quietHours}
                  onChange={(n) => {
                    setDraft((d) => ({ ...d, notifications: n }));
                    setErrors((e) => ({ ...e, quietHours: undefined }));
                  }}
                />,
              )}

            {s.id === "data" &&
              panelForm(
                <>
                  <Group title={t("Data plan")}>
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
                  </Group>
                  <EnergyPriceFields
                    value={draft.energyPrice}
                    error={errors.energyPrice}
                    onChange={(p) => {
                      setDraft((d) => ({ ...d, energyPrice: p }));
                      setErrors((e) => ({ ...e, energyPrice: undefined }));
                    }}
                  />
                  <BatteryFields
                    value={draft.battery}
                    error={errors.battery}
                    onChange={(b) => {
                      setDraft((d) => ({ ...d, battery: b }));
                      setErrors((e) => ({ ...e, battery: undefined }));
                    }}
                  />
                </>,
              )}

            {s.id === "connection" &&
              panelForm(
                <>
                  <Group title={t("Connection")}>
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
                  </Group>
                  <Group title={t("Advanced")}>
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
                  </Group>
                </>,
              )}

            {s.id === "ai" && (
              <>
                {panelForm(<AiFields draft={draft} saved={settings} errors={errors} set={set} />)}
                {aiExtra}
              </>
            )}

            {s.id === "weather" &&
              panelForm(<WeatherFields value={draft.weatherLocation} onChange={(w) => set("weatherLocation", w)} />)}
          </section>
        ))}

        {dirty && (
          <div className="sticky bottom-0 z-10 -mx-1 mt-2 flex items-center justify-end gap-2 rounded-xl bg-card/95 px-3 py-2 ring-1 ring-border backdrop-blur">
            <span className="mr-auto text-xs text-muted-foreground" role="status">
              {t("Unsaved changes")}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                setDraft(settings);
                setErrors({});
              }}
            >
              {t("Revert")}
            </Button>
            <Button type="button" size="sm" disabled={saving} onClick={() => void submit()}>
              {saving && <Loader2 className="animate-spin" aria-hidden />}
              {t("Save settings")}
            </Button>
          </div>
        )}
      </div>
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
    <>
      <Row
        wide
        label={t("Claude model")}
        htmlFor="claude-model"
        descId="claude-model-desc"
        tone={error && !custom ? "error" : undefined}
        description={error && !custom ? error : custom ? t("Enter any model ID your key can use.") : t("Used for AI explanations.")}
      >
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
      </Row>
      {custom && (
        <Row
          wide
          label={t("Custom model ID")}
          htmlFor="claude-model-custom"
          descId="claude-model-custom-desc"
          tone={error ? "error" : undefined}
          description={error ?? t("For example a dated model snapshot.")}
        >
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
        </Row>
      )}
    </>
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
  label,
}: {
  invalid?: boolean;
  id: string;
  value: number | null;
  onChange: (h: number | null) => void;
  disabled?: boolean;
  describedBy?: string;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <Select
      value={value === null ? OFF : String(value)}
      onValueChange={(v) => onChange(v === OFF ? null : Number(v))}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={label} aria-describedby={describedBy} aria-invalid={invalid || undefined} className="w-full">
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
    <>
      <Group>
        <Row
          label={t("Desktop notifications")}
          htmlFor="notif-enabled"
          descId="notif-enabled-desc"
          description={t("Alerts for problems with your connection, with a cooldown to avoid repeats.")}
        >
          <Switch id="notif-enabled" aria-describedby="notif-enabled-desc" checked={value.enabled} onCheckedChange={(v) => set("enabled", v)} />
        </Row>
      </Group>

      <Group title={t("Notification types")}>
        {NOTIFICATION_TYPES.map((nt) => {
          const id = `notif-${nt.key}`;
          return (
            <Row key={nt.key} label={t(nt.label)} htmlFor={id} descId={`${id}-desc`} description={t(nt.hint)}>
              <Switch
                id={id}
                aria-describedby={`${id}-desc`}
                checked={value[nt.key]}
                disabled={off}
                onCheckedChange={(v) => set(nt.key, v)}
              />
            </Row>
          );
        })}
      </Group>

      <Group title={t("Quiet hours")}>
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t("From")}</span>
              <HourSelect
                id="quiet-start"
                label={t("From")}
                invalid={Boolean(error)}
                value={value.quietStartHour}
                disabled={off}
                describedBy="quiet-desc"
                onChange={(h) => set("quietStartHour", h)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t("Until")}</span>
              <HourSelect
                id="quiet-end"
                label={t("Until")}
                value={value.quietEndHour}
                disabled={off}
                describedBy="quiet-desc"
                onChange={(h) => set("quietEndHour", h)}
              />
            </div>
          </div>
          <p id="quiet-desc" className={cn("text-xs", error ? "text-critical" : "text-muted-foreground")} role={error ? "alert" : undefined}>
            {error ??
              (value.quietStartHour !== null && value.quietEndHour !== null
                ? t("No notifications from {{from}} to {{to}}.", {
                    from: formatHour(value.quietStartHour),
                    to: formatHour(value.quietEndHour),
                  })
                : t("Off. Notifications can arrive at any time."))}
          </p>
        </div>
      </Group>

      <div>
        <Button type="button" size="sm" variant="outline" onClick={sendTest} disabled={testing || off}>
          {testing ? <Loader2 className="animate-spin" aria-hidden /> : <BellRing aria-hidden />}
          {t("Send test notification")}
        </Button>
      </div>
    </>
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
    <div id="ai-settings" className="flex flex-col gap-5">
      <div role="radiogroup" aria-label={t("AI provider")} className="flex flex-col divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-border">
        {PROVIDERS.map((p) => {
          const id = `ai-provider-${p.value}`;
          const checked = draft.aiProvider === p.value;
          return (
            <label
              key={p.value}
              htmlFor={id}
              className={cn("flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors", checked ? "bg-primary/10" : "hover:bg-muted/50")}
            >
              <input
                id={id}
                type="radio"
                name="ai-provider"
                value={p.value}
                checked={checked}
                onChange={() => set("aiProvider", p.value)}
                aria-describedby={`${id}-desc`}
                className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
              />
              <span className="min-w-0">
                <span className="block text-sm">{t(p.label)}</span>
                <span id={`${id}-desc`} className="mt-0.5 block text-xs text-muted-foreground">
                  {t(p.hint)}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {draft.aiProvider === "claude" && (
        <Group
          footer={
            saved.aiProvider === "claude"
              ? t("Your API key is managed in the Anthropic API key card.")
              : t("After saving, add your API key in the Anthropic API key card that appears.")
          }
        >
          <ModelPicker value={draft.claudeModel} error={errors.claudeModel} onChange={(v) => set("claudeModel", v)} />
        </Group>
      )}

      {draft.aiProvider === "local" && (
        <Group>
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
            <p role="alert" className="flex items-start gap-2 bg-warning/10 px-4 py-3 text-xs">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
              <span>
                {t("This address is not this computer. Your connection summary will be sent over the network to it when you ask for an explanation.")}
              </span>
            </p>
          )}
          <LocalModelPicker
            value={draft.localAiModel}
            error={errors.localAiModel}
            onChange={(v) => set("localAiModel", v)}
            serverSaved={
              saved.aiProvider === "local" && saved.localAiUrl === draft.localAiUrl && saved.localAiKind === draft.localAiKind
            }
          />
        </Group>
      )}
    </div>
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
    <Row wide label={t("Model")} htmlFor="local-model" descId="local-model-desc" tone={error ? "error" : undefined} description={error ?? hint}>
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
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
              <SelectTrigger id="local-model" aria-describedby="local-model-desc" aria-invalid={error ? true : undefined} className="w-full">
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
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={() => void load()}
          disabled={!serverSaved || loading}
          aria-label={t("Refresh model list")}
          title={t("Refresh")}
        >
          <RefreshCw className={cn(loading && "animate-spin motion-reduce:animate-none")} aria-hidden />
        </Button>
      </div>
    </Row>
  );
}

/** Native names: shown untranslated so people can find their language. */
const LANGUAGE_NAMES = { en: "English", it: "Italiano" } as const;

const DEFAULT_PRICE: EnergyPrice = { perKwh: 0.25, currency: "EUR" };

/** Optional electricity price: the Energy card then shows the dish's running cost. */
function EnergyPriceFields({
  value,
  error,
  onChange,
}: {
  value: EnergyPrice | null;
  error?: string;
  onChange: (p: EnergyPrice | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <Group
      title={t("Electricity cost")}
      footer={
        error ? (
          <span className="text-critical" role="alert">
            {error}
          </span>
        ) : undefined
      }
    >
      <Row
        label={t("Show what the dish costs to run")}
        htmlFor="price-switch"
        descId="price-desc"
        description={t("Uses the dish's measured energy and your price per kWh. Include taxes and fees for a realistic figure.")}
      >
        <Switch
          id="price-switch"
          aria-describedby="price-desc"
          checked={value !== null}
          onCheckedChange={(on) => onChange(on ? (value ?? DEFAULT_PRICE) : null)}
        />
      </Row>
      {value && (
        <>
          <Field label={t("Price per kWh")}>
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0.001}
                max={10}
                step={0.001}
                inputMode="decimal"
                value={Number.isFinite(value.perKwh) ? value.perKwh : ""}
                onChange={(e) => onChange({ ...value, perKwh: e.target.value === "" ? NaN : Number(e.target.value) })}
                aria-invalid={error ? true : undefined}
                className="num"
              />
            )}
          </Field>
          <Field label={t("Currency")}>
            {(p) => (
              <>
                <Input
                  {...p}
                  maxLength={3}
                  list="price-currencies"
                  value={value.currency}
                  onChange={(e) => onChange({ ...value, currency: e.target.value.toUpperCase() })}
                  aria-invalid={error ? true : undefined}
                  className="num uppercase"
                />
                <datalist id="price-currencies">
                  {["EUR", "USD", "GBP", "CHF", "CAD", "AUD"].map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
        </>
      )}
    </Group>
  );
}

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
    <Group
      title={t("Battery (off-grid)")}
      footer={
        value ? (
          <span className={cn(error && "text-critical")} role={error ? "alert" : undefined}>
            {error ??
              t("≈ {{wh}} Wh usable. LiFePO4: about 80–90 %, lead-acid: about 50 %.", {
                wh: fmtNum(batteryWh(value), 0),
              })}
          </span>
        ) : undefined
      }
    >
      <Row
        label={t("I power the dish from a battery")}
        htmlFor="battery-switch"
        descId="battery-desc"
        description={t("Shows how long the battery lasts at the current power draw.")}
      >
        <Switch
          id="battery-switch"
          aria-describedby="battery-desc"
          checked={value !== null}
          onCheckedChange={(on) => onChange(on ? (value ?? DEFAULT_BATTERY) : null)}
        />
      </Row>
      {value && (
        <>
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
        </>
      )}
    </Group>
  );
}

/** Opt-in weather place. Only the typed query and the rounded coordinates leave the device. */
function WeatherFields({ value, onChange }: { value: WeatherLocation | null; onChange: (v: WeatherLocation | null) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [places, setPlaces] = useState<WeatherPlace[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (busy) return;
    const q = query.trim();
    if (q.length < 2) {
      setError(t("Type at least 2 characters."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPlaces(await api.searchWeatherLocations(q));
    } catch (e) {
      setPlaces(null);
      setError(normalizeError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = (p: WeatherPlace) => {
    const label = [p.name, p.admin1, p.country].filter(Boolean).join(", ");
    const label100 = Array.from(label).slice(0, 100).join("");
    onChange({ name: label100, latitude: p.latitude, longitude: p.longitude });
    setPlaces(null);
    setQuery("");
  };

  return (
    <Group
      footer={t("Optional. Shows rain and snow next to outages. The place name you type and its coordinates, rounded to about 1 km, are sent to Open-Meteo. Your dish location is never used.")}
    >
      {value ? (
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <CloudRain className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{value.name}</span>
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
            <X aria-hidden /> {t("Remove")}
          </Button>
        </div>
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">{t("No place set. Weather is off.")}</p>
      )}
      <div className="flex flex-col gap-2 px-4 py-3">
        <div className="flex gap-2">
          <Input
            aria-label={t("Search for a place")}
            placeholder={t("City or town")}
            value={query}
            maxLength={100}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void search();
              }
            }}
          />
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void search()}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Search aria-hidden />} {t("Search")}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-critical">
            {error}
          </p>
        )}
        {places && places.length === 0 && <p className="text-xs text-muted-foreground">{t("No places found.")}</p>}
      </div>
      {places && places.length > 0 && (
        <ul className="flex flex-col divide-y divide-border" aria-label={t("Search results")}>
          {places.map((p, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => pick(p)}
                className="w-full px-4 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                {p.name}
                <span className="text-xs text-muted-foreground">
                  {[p.admin1, p.country].filter(Boolean).length > 0 && `  ${[p.admin1, p.country].filter(Boolean).join(", ")}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Group>
  );
}
