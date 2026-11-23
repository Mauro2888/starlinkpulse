import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, Loader2, Volume2, VolumeX, X } from "lucide-react";
import type { AlignmentModeEvent, TelemetrySnapshot } from "@/types/models";
import { api, events } from "@/lib/api";
import { toastError } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { fmtNum } from "@/lib/format";
import { useTranslation } from "react-i18next";
import { tr } from "@/i18n";
import { tk } from "@/i18n/keys";
import { compassPoint, normalizeAzimuth } from "@/lib/sky";
import {
  beepIntervalMs,
  closeness,
  HOLD_TO_FINISH_MS,
  initialGuide,
  stepGuide,
  toSample,
  type GuidePhase,
  type GuideState,
  type HoldReason,
} from "@/lib/align-guide";
import { AlignBeeper, loadAlignAudio, saveAlignAudio } from "@/lib/align-audio";
import { useNow } from "@/hooks/use-now";
import { useTelemetry } from "@/hooks/use-pulse";

// Outdoor mode deliberately ignores the dark theme: black on near-white is the
// most readable combination on a laptop screen in daylight.

type Action = { type: "sample"; snapshot: TelemetrySnapshot } | { type: "reset" };

function reducer(state: GuideState, action: Action): GuideState {
  if (action.type === "reset") return initialGuide();
  return stepGuide(state, toSample(action.snapshot.alignment, action.snapshot.timestampMs));
}

const HOLD_COPY: Record<HoldReason, string> = {
  uncertain: tk("The dish is measuring where it points. Keep it still for a few seconds."),
  estimating: tk("The dish is still working out its position. Keep it still."),
  moving: tk("Readings are settling after the last move. Keep it still."),
};

function fmtDeg(d: number): string {
  const a = Math.abs(d);
  return `${a >= 10 ? fmtNum(Math.round(a), 0) : fmtNum(a, 1, true)}°`;
}

function fmtClock(s: number): string {
  const v = Math.max(0, Math.round(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}

/** Big curved arrow: sweeps clockwise from the top, head at the end. Mirrored for counter-clockwise. */
function RotateArrow({ clockwise }: { clockwise: boolean }) {
  return (
    <svg viewBox="0 0 120 120" className={cn("size-40 sm:size-52", !clockwise && "-scale-x-100")} aria-hidden>
      <path d="M60 14 A46 46 0 1 1 18 78" fill="none" stroke="currentColor" strokeWidth="11" strokeLinecap="round" />
      {/* Arrowhead at the end of the clockwise sweep, pointing along the motion. */}
      <path d="M10 60 L30 73 L6 84 Z" fill="currentColor" />
    </svg>
  );
}

interface Props {
  snapshot: TelemetrySnapshot | null;
  onClose: () => void;
}

/** Full-window guided alignment for dishes without motors. Esc exits. */
export function AlignMode({ snapshot, onClose }: Props) {
  const { t } = useTranslation();
  const [guide, dispatch] = useReducer(reducer, undefined, initialGuide);
  const [sound, setSound] = useState(loadAlignAudio);
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [ended, setEnded] = useState(false);
  const now = useNow(1000);
  const rootRef = useRef<HTMLDivElement>(null);
  const beeper = useMemo(() => new AlignBeeper(), []);

  // Start fast polling; always stop it again when leaving.
  const start = useCallback(() => {
    setEnded(false);
    dispatch({ type: "reset" });
    api.setAlignmentMode(true).catch((e) => toastError(e, tr("Couldn't start guided alignment")));
  }, []);

  useEffect(() => {
    start();
    let off: (() => void) | null = null;
    let disposed = false;
    events
      .onAlignmentMode((e: AlignmentModeEvent) => {
        if (e.enabled) {
          setEndsAt(Date.now() + e.remainingS * 1000);
          setEnded(false);
        } else {
          setEndsAt(null);
          setEnded(true);
        }
      })
      .then(
        (u) => (disposed ? u() : (off = u)),
        () => undefined,
      );
    return () => {
      disposed = true;
      off?.();
      void api.setAlignmentMode(false).catch(() => undefined);
    };
  }, [start]);

  // Feed new readings into the guide.
  useEffect(() => {
    if (snapshot && !ended) dispatch({ type: "sample", snapshot });
  }, [snapshot, ended]);

  // Audio: beeps speed up as the error shrinks, steady tone in tolerance, silence otherwise.
  useEffect(() => {
    const close = closeness(guide.phase);
    if (!sound || ended || close === null || guide.phase.kind === "done") beeper.setMode({ kind: "silent" });
    else if (guide.phase.kind === "holding") beeper.setMode({ kind: "tone" });
    else beeper.setMode({ kind: "beep", intervalMs: beepIntervalMs(close) });
  }, [guide.phase, sound, ended, beeper]);
  useEffect(() => () => beeper.dispose(), [beeper]);

  // Keyboard: Esc exits, Tab stays inside the overlay.
  useEffect(() => {
    rootRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !rootRef.current) return;
      const items = rootRef.current.querySelectorAll<HTMLElement>("button:not([disabled])");
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === rootRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const toggleSound = () => {
    setSound((s) => {
      saveAlignAudio(!s);
      return !s;
    });
  };

  const remainingS = endsAt ? (endsAt - now) / 1000 : null;
  const a = snapshot?.alignment;
  const step = guide.phase.kind === "direction" ? 1 : guide.phase.kind === "tilt" ? 2 : guide.phase.kind === "holding" ? 3 : guide.done ? 3 : 0;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="align-title"
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex flex-col overflow-y-auto bg-[#f7f7f3] text-[#0b0b0b] outline-none"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-black/15 px-4 py-3 sm:px-8">
        <h1 id="align-title" className="text-lg font-semibold tracking-tight">
          {t("Guided alignment")}
        </h1>
        <span className="num text-sm text-black/70">
          {remainingS !== null ? t("{{time}} left", { time: fmtClock(remainingS) }) : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <OutdoorButton onClick={toggleSound} pressed={sound} label={sound ? t("Sound on") : t("Sound off")}>
            {sound ? <Volume2 className="size-5" aria-hidden /> : <VolumeX className="size-5" aria-hidden />}
            <span className="hidden sm:inline">{sound ? t("Sound on") : t("Sound off")}</span>
          </OutdoorButton>
          <OutdoorButton onClick={onClose} label={t("Exit guided alignment (Esc)")}>
            <X className="size-5" aria-hidden />
            <span className="hidden sm:inline">{t("Exit")}</span>
          </OutdoorButton>
        </div>
      </header>

      <ol className="flex justify-center gap-2 px-4 pt-4 text-sm font-medium sm:gap-4" aria-label={t("Steps")}>
        {[tk("Direction"), tk("Tilt"), tk("Hold")].map((label, i) => (
          <li
            key={label}
            aria-current={step === i + 1 ? "step" : undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1",
              step === i + 1 ? "bg-black text-white" : step > i + 1 ? "text-[#0a6b2b]" : "text-black/55",
            )}
          >
            {step > i + 1 ? <Check className="size-4" aria-hidden /> : <span className="num">{i + 1}</span>}
            {t(label)}
          </li>
        ))}
      </ol>

      <p role="status" className="sr-only">
        {ended ? t("Guided alignment stopped.") : announce(guide.phase)}
      </p>
      <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-6 text-center">
        {ended ? (
          <Stage title={t("Guided alignment stopped")} sub={t("Fast readings turn off automatically after 10 minutes.")}>
            <OutdoorButton onClick={start} big>
              {t("Start again")}
            </OutdoorButton>
          </Stage>
        ) : (
          <PhaseView phase={guide.phase} guide={guide} snapshot={snapshot} onRestart={() => dispatch({ type: "reset" })} onFinish={onClose} />
        )}
      </main>

      <footer className="flex flex-col items-center gap-1 border-t border-black/15 px-4 py-3 text-center text-sm text-black/75">
        {a && a.azimuthDeg !== null && a.desiredAzimuthDeg !== null && (
          <p className="num">
            {t("Facing {{now}}° · target {{target}}°", {
              now: fmtNum(normalizeAzimuth(a.azimuthDeg), 1, true),
              target: fmtNum(normalizeAzimuth(a.desiredAzimuthDeg), 1, true),
            })}
            {a.elevationDeg !== null &&
              a.desiredElevationDeg !== null &&
              ` · ${t("tilt {{now}}° / {{target}}°", { now: fmtNum(a.elevationDeg, 1, true), target: fmtNum(a.desiredElevationDeg, 1, true) })}`}
            {a.uncertaintyDeg !== null && ` · ±${fmtNum(a.uncertaintyDeg, 1, true)}°`}
          </p>
        )}
        <p>{t("The dish recalculates the recommended direction; it can shift slightly after you move it.")}</p>
      </footer>
    </div>
  );
}

/** Short screen-reader announcement: changes only when the instruction changes, not every reading. */
function announce(phase: GuidePhase): string {
  switch (phase.kind) {
    case "waiting":
      return tr("Waiting for the dish.");
    case "hold":
      return tr("Hold still.");
    case "direction":
      return phase.deltaDeg > 0 ? tr("Step 1: rotate clockwise.") : tr("Step 1: rotate counter-clockwise.");
    case "tilt":
      return phase.deltaDeg > 0 ? tr("Step 2: tilt up.") : tr("Step 2: tilt down.");
    case "holding":
      return tr("In position. Hold it there.");
    case "done":
      return tr("Aligned.");
  }
}

function PhaseView({
  phase,
  guide,
  snapshot,
  onRestart,
  onFinish,
}: {
  phase: GuidePhase;
  guide: GuideState;
  snapshot: TelemetrySnapshot | null;
  onRestart: () => void;
  onFinish: () => void;
}) {
  const { t } = useTranslation();
  switch (phase.kind) {
    case "waiting":
      return (
        <Stage icon={<Loader2 className="size-16 animate-spin motion-reduce:animate-none" aria-hidden />} title={t("Waiting for the dish…")}>
          {t("Alignment readings arrive about once a second.")}
        </Stage>
      );
    case "hold":
      return (
        <Stage icon={<Loader2 className="size-16 animate-spin motion-reduce:animate-none" aria-hidden />} title={t("Hold still…")}>
          {t(HOLD_COPY[phase.reason])}
        </Stage>
      );
    case "direction": {
      const cw = phase.deltaDeg > 0;
      const target = snapshot?.alignment.desiredAzimuthDeg;
      return (
        <>
          <span className="text-[#0b4fb3]">
            <RotateArrow clockwise={cw} />
          </span>
          <p className="text-2xl font-semibold sm:text-3xl">{cw ? t("Rotate clockwise") : t("Rotate counter-clockwise")}</p>
          <p className="num text-7xl leading-none font-semibold tracking-tight sm:text-9xl">{fmtDeg(phase.deltaDeg)}</p>
          <p className="text-lg text-black/75">
            {typeof target === "number"
              ? t("Seen from above, to face {{deg}}° {{point}}", {
                  deg: Math.round(normalizeAzimuth(target)),
                  point: t(compassPoint(target)),
                })
              : t("Seen from above")}
          </p>
        </>
      );
    }
    case "tilt": {
      const up = phase.deltaDeg > 0;
      const Icon = up ? ArrowUp : ArrowDown;
      return (
        <>
          <Icon className="size-36 text-[#0b4fb3] sm:size-48" strokeWidth={2.5} aria-hidden />
          <p className="text-2xl font-semibold sm:text-3xl">{up ? t("Tilt up") : t("Tilt down")}</p>
          <p className="num text-7xl leading-none font-semibold tracking-tight sm:text-9xl">{fmtDeg(phase.deltaDeg)}</p>
          <p className="text-lg text-black/75">
            {up
              ? t("Point the dish face higher. Direction is already good.")
              : t("Point the dish face lower. Direction is already good.")}
          </p>
        </>
      );
    }
    case "holding": {
      const left = Math.ceil(phase.remainingMs / 1000);
      const pct = 100 * (1 - phase.remainingMs / HOLD_TO_FINISH_MS);
      return (
        <>
          <Check className="size-32 text-[#0a6b2b] sm:size-40" strokeWidth={3} aria-hidden />
          <p className="text-3xl font-semibold sm:text-4xl">{t("Hold it there")}</p>
          <p className="text-lg text-black/75">{t("Keep the dish still for {{count}} more seconds.", { count: left })}</p>
          <div
            role="progressbar"
            aria-label={t("Holding in position")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct)}
            className="h-3 w-64 overflow-hidden rounded-full bg-black/10"
          >
            <div className="h-full rounded-full bg-[#0a6b2b] transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        </>
      );
    }
    case "done": {
      const last = guide.samples[guide.samples.length - 1];
      return (
        <>
          <Check className="size-32 text-[#0a6b2b] sm:size-40" strokeWidth={3} aria-hidden />
          <p className="text-4xl font-semibold sm:text-5xl">{t("Aligned ✓")}</p>
          {guide.start && last && (
            <table className="num text-lg">
              <caption className="sr-only">{t("Before and after")}</caption>
              <thead>
                <tr className="text-sm text-black/65">
                  <th scope="col" className="px-3 font-normal">
                    <span className="sr-only">{t("Axis")}</span>
                  </th>
                  <th scope="col" className="px-3 font-normal">{t("Before")}</th>
                  <th scope="col" className="px-3 font-normal">{t("Now")}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" className="px-3 text-left font-normal text-black/75">{t("Direction")}</th>
                  <td className="px-3">{fmtNum(guide.start.az, 1, true)}°</td>
                  <td className="px-3 font-semibold">{fmtNum(last.az, 1, true)}°</td>
                </tr>
                {guide.start.el !== null && last.el !== null && (
                  <tr>
                    <th scope="row" className="px-3 text-left font-normal text-black/75">{t("Tilt")}</th>
                    <td className="px-3">{fmtNum(guide.start.el, 1, true)}°</td>
                    <td className="px-3 font-semibold">{fmtNum(last.el, 1, true)}°</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          <p className="text-lg text-black/75">{t("Check the Sky view again in a few hours.")}</p>
          <div className="flex gap-3">
            <OutdoorButton onClick={onFinish} big primary>
              {t("Finish")}
            </OutdoorButton>
            <OutdoorButton onClick={onRestart} big>
              {t("Check again")}
            </OutdoorButton>
          </div>
        </>
      );
    }
  }
}

function Stage({ icon, title, sub, children }: { icon?: ReactNode; title: string; sub?: string; children?: ReactNode }) {
  return (
    <>
      {icon}
      <p className="text-3xl font-semibold sm:text-4xl">{title}</p>
      {sub && <p className="text-lg text-black/75">{sub}</p>}
      {children && <div className="max-w-md text-lg text-black/75">{children}</div>}
    </>
  );
}

function OutdoorButton({
  onClick,
  children,
  label,
  pressed,
  big,
  primary,
}: {
  onClick: () => void;
  children: ReactNode;
  label?: string;
  pressed?: boolean;
  big?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg font-medium ring-2 ring-black outline-none focus-visible:ring-4 focus-visible:ring-[#0b4fb3] focus-visible:ring-offset-2",
        big ? "px-6 py-3 text-lg" : "px-3 py-1.5 text-sm",
        primary ? "bg-black text-white hover:bg-black/85" : "bg-white text-black hover:bg-black/5",
      )}
    >
      {children}
    </button>
  );
}

/** Container: live snapshot from the shared telemetry state. */
export default function AlignModePanel({ onClose }: { onClose: () => void }) {
  const { snapshot } = useTelemetry();
  return <AlignMode snapshot={snapshot} onClose={onClose} />;
}
