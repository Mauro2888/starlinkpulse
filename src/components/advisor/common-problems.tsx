import { useEffect, useState } from "react";
import { ChevronDown, LifeBuoy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { tk } from "@/i18n/keys";
import { api } from "@/lib/api";

interface Problem {
  title: string;
  intro: string;
  steps: string[];
  /** Shows the Starlink router's IPv6 state, when known. */
  ipv6Hint?: boolean;
}

const PROBLEMS: Problem[] = [
  {
    title: tk("Instagram or Facebook videos keep buffering on phones"),
    intro: tk(
      "Some Starlink users reported in 2021–22 that Instagram and Facebook load videos badly over QUIC, a newer protocol that runs on UDP. When the apps fall back to the older protocol (TCP), videos play normally. This can't be fixed from this computer: the change has to happen on your router or on the phone.",
    ),
    steps: [
      tk("Check it's the network: if videos play fine on mobile data but buffer on Starlink Wi-Fi, keep going."),
      tk(
        "Using your own router (Starlink in bypass mode)? Turn on IPv6 (often called DHCPv6 prefix delegation). Starlink provides IPv6 and Meta's servers support it, so traffic skips Starlink's shared IPv4 address (CGNAT).",
      ),
      tk(
        "Still buffering? On your own router, add a firewall rule that blocks outgoing UDP on ports 80 and 443. The apps then switch to TCP. The Starlink router doesn't offer firewall rules.",
      ),
      tk(
        "Without a router change: use a VPN on the phone, or on Android a firewall app that can block UDP for Instagram and Facebook. iOS has no setting for this.",
      ),
    ],
    ipv6Hint: true,
  },
];

/** Collapsible help for known issues the dish data cannot show. Only reads the local router's IPv6 state. */
export function CommonProblems() {
  const { t } = useTranslation();
  // null: no Starlink router (third-party router / bypass) or not read yet.
  const [ipv6, setIpv6] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    api.getWifiDevices().then(
      (w) => alive && setIpv6(w.available && w.router ? w.router.ipv6 : null),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);
  return (
    <section aria-labelledby="common-problems-title" className="flex flex-col gap-2">
      <h2 id="common-problems-title" className="eyebrow px-1">
        {t("Common problems")}
      </h2>
      {PROBLEMS.map((p) => (
        <details key={p.title} className="group rounded-xl bg-card ring-1 ring-border">
          <summary className="flex cursor-pointer items-center gap-2 rounded-xl px-3.5 py-2.5 text-xs font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-ring">
            <LifeBuoy className="size-4 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 flex-1">{t(p.title)}</span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <div className="flex flex-col gap-2 border-t border-border px-3.5 py-3 text-xs leading-relaxed">
            <p className="text-muted-foreground">{t(p.intro)}</p>
            {p.ipv6Hint && ipv6 !== null && (
              <p role="status" className="rounded-lg bg-muted/40 px-2.5 py-1.5">
                {ipv6
                  ? t("Checked: your Starlink router has IPv6, so phones on its Wi-Fi usually get it too. If videos still buffer, try a VPN or a firewall app on the phone.")
                  : t("Checked: your Starlink router has no IPv6 right now, so all traffic goes through the shared IPv4 address (CGNAT). If videos buffer, try a VPN or a firewall app on the phone.")}
              </p>
            )}
            <ol className="flex list-decimal flex-col gap-1.5 pl-4 marker:text-muted-foreground">
              {p.steps.map((s) => (
                <li key={s}>{t(s)}</li>
              ))}
            </ol>
            <p className="text-[0.6875rem] text-muted-foreground">{t("Based on user reports, not an official Starlink fix.")}</p>
          </div>
        </details>
      ))}
    </section>
  );
}
