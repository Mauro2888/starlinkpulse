//! Backend message catalog (EN/IT) for notifications, tray, rule-engine texts and
//! user-facing errors.
//!
//! Each catalog is declared with [`catalog!`]: every key carries its English and Italian
//! text side by side, so a missing translation is a compile error. Templates use `{name}`
//! placeholders filled by [`fill`]; a test checks that both languages use the same
//! placeholders.

use std::sync::atomic::{AtomicU8, Ordering};

use crate::models::AppLanguage;

/// Resolved language.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lang {
    #[default]
    En,
    It,
}

impl Lang {
    pub fn code(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::It => "it",
        }
    }
}

/// "system" follows the OS locale: Italian if it starts with "it", otherwise English.
pub fn resolve(setting: AppLanguage, os_locale: Option<&str>) -> Lang {
    match setting {
        AppLanguage::En => Lang::En,
        AppLanguage::It => Lang::It,
        AppLanguage::System => match os_locale {
            Some(l) if l.trim().to_ascii_lowercase().starts_with("it") => Lang::It,
            _ => Lang::En,
        },
    }
}

/// OS locale (e.g. "it-IT"), if available.
pub fn os_locale() -> Option<String> {
    sys_locale::get_locale()
}

static CURRENT: AtomicU8 = AtomicU8::new(0);

/// Language used for texts produced without an explicit language (notifications, tray,
/// errors). Set at startup and whenever the setting changes.
pub fn current() -> Lang {
    if CURRENT.load(Ordering::Relaxed) == 1 {
        Lang::It
    } else {
        Lang::En
    }
}

pub fn set_current(lang: Lang) {
    CURRENT.store(if lang == Lang::It { 1 } else { 0 }, Ordering::Relaxed);
}

/// Replaces `{name}` placeholders.
pub fn fill(template: &str, args: &[(&str, &str)]) -> String {
    let mut out = template.to_string();
    for (k, v) in args {
        out = out.replace(&format!("{{{k}}}"), v);
    }
    out
}

/// Number with `decimals` digits and the locale's decimal separator.
pub fn dec(lang: Lang, value: f64, decimals: usize) -> String {
    let s = format!("{value:.decimals$}");
    match lang {
        Lang::En => s,
        Lang::It => s.replace('.', ","),
    }
}

/// Like [`dec`] but drops a trailing ".0" (e.g. "11" instead of "11.0").
pub fn dec_trim(lang: Lang, value: f64, decimals: usize) -> String {
    let s = format!("{value:.decimals$}");
    let s = if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    };
    match lang {
        Lang::En => s,
        Lang::It => s.replace('.', ","),
    }
}

/// Declares a catalog struct with EN and IT instances.
macro_rules! catalog {
    ($name:ident { $($field:ident: $en:expr, $it:expr;)* }) => {
        #[derive(Debug)]
        pub struct $name {
            $(pub $field: &'static str,)*
        }

        impl $name {
            pub const EN: $name = $name { $($field: $en,)* };
            pub const IT: $name = $name { $($field: $it,)* };

            pub fn get(lang: Lang) -> &'static $name {
                match lang {
                    Lang::En => &Self::EN,
                    Lang::It => &Self::IT,
                }
            }

            /// `(key, en, it)` for every entry.
            #[allow(dead_code)]
            pub fn entries() -> Vec<(&'static str, &'static str, &'static str)> {
                vec![$((stringify!($field), $en, $it),)*]
            }
        }
    };
}

catalog!(ErrorTexts {
    read_only:
        "Read-only mode is on; turn it off in Settings to send commands to the dish.",
        "La modalità sola lettura è attiva; disattivala nelle Impostazioni per inviare comandi alla parabola.";
    write_denied:
        "This dish firmware does not allow this change from the local network. Use the Starlink app.",
        "Il firmware di questa parabola non consente questa modifica dalla rete locale. Usa l'app Starlink.";
    insufficient_data:
        "Not enough history yet: StarlinkPulse needs at least 1 hour of data. Keep the app running and try again.",
        "Storico ancora insufficiente: StarlinkPulse ha bisogno di almeno 1 ora di dati. Lascia l'app in esecuzione e riprova.";
    no_api_key:
        "No Anthropic API key configured; add one in Settings.",
        "Nessuna chiave API Anthropic configurata; aggiungila nelle Impostazioni.";
    ai_refused:
        "The model declined to analyze this data.",
        "Il modello ha rifiutato di analizzare questi dati.";
    ai_off:
        "AI explanations are turned off",
        "Le spiegazioni AI sono disattivate";
    alignment_manual_only:
        "Alignment mode is only available for dishes without motors.",
        "La modalità allineamento è disponibile solo per parabole senza motori.";
    weather_unreachable:
        "Weather service unreachable. Try again later.",
        "Servizio meteo non raggiungibile. Riprova più tardi.";
    not_connected:
        "Not connected to the dish.",
        "Non connesso alla parabola.";
});

catalog!(TrayTexts {
    show_hide: "Show/Hide dashboard", "Mostra/Nascondi dashboard";
    quit: "Quit StarlinkPulse", "Esci da StarlinkPulse";
    connecting: "Connecting…", "Connessione…";
    connected: "Connected", "Connesso";
    offline: "Offline", "Offline";
    mock: "Mock data", "Dati simulati";
    video: "Video", "Video";
    gaming: "Gaming", "Gioco";
    streaming: "Streaming", "Streaming";
});

catalog!(NotifyTexts {
    outage_title: "Starlink connection lost", "Connessione Starlink persa";
    outage_body: "No internet: {cause}.", "Nessuna connessione: {cause}.";
    restored_title: "Starlink connection restored", "Connessione Starlink ripristinata";
    restored_body: "Back online after {duration}.", "Di nuovo online dopo {duration}.";
    obstruction_title: "Dish view obstructed", "Visuale della parabola ostruita";
    obstruction_body:
        "Something blocks the dish's view of the sky ({pct} obstructed). Check the obstruction map.",
        "Qualcosa blocca la visuale del cielo della parabola ({pct} ostruito). Controlla la mappa delle ostruzioni.";
    thermal_title: "Dish overheating", "Parabola surriscaldata";
    thermal_body:
        "The dish is limiting performance because it is too hot.",
        "La parabola sta limitando le prestazioni perché è troppo calda.";
    throttle_on_title: "Starlink speed limited", "Velocità Starlink limitata";
    throttle_on_body:
        "Your plan is being deprioritized or limited by Starlink (POLICY_LIMIT).",
        "Il tuo piano è depriorizzato o limitato da Starlink (POLICY_LIMIT).";
    throttle_off_title: "Starlink speed limit lifted", "Limite di velocità Starlink rimosso";
    throttle_off_body:
        "Your plan is no longer limited by Starlink.",
        "Il tuo piano non è più limitato da Starlink.";
    reboot_title: "Dish restarted", "Parabola riavviata";
    reboot_body: "The dish rebooted (up for {duration}).", "La parabola si è riavviata (attiva da {duration}).";
    reboot_body_plain: "The dish rebooted.", "La parabola si è riavviata.";
    reboot_offline_body:
        "The dish restarted and was offline for {duration}.",
        "La parabola si è riavviata ed è rimasta offline per {duration}.";
    firmware_title: "Starlink firmware update ready", "Aggiornamento firmware Starlink pronto";
    firmware_body:
        "The dish will restart to install a software update.",
        "La parabola si riavvierà per installare un aggiornamento software.";
    datacap80_title: "80 % of data cap used", "80 % del limite dati usato";
    datacap100_title: "Data cap reached", "Limite dati raggiunto";
    datacap_body:
        "Estimated {used} GB of {cap} GB used this billing cycle.",
        "Stimati {used} GB su {cap} GB usati in questo ciclo di fatturazione.";
    unreachable_title: "Starlink dish not reachable", "Parabola Starlink non raggiungibile";
    unreachable_body:
        "StarlinkPulse has not reached the dish for {duration}. Check its power and cable.",
        "StarlinkPulse non raggiunge la parabola da {duration}. Controlla alimentazione e cavo.";
    reachable_title: "Starlink dish reachable again", "Parabola Starlink di nuovo raggiungibile";
    reachable_body: "The dish answers again after {duration}.", "La parabola risponde di nuovo dopo {duration}.";
    test_body: "Notifications are working.", "Le notifiche funzionano.";
    cause_obstructed:
        "something is blocking the dish's view of the sky",
        "qualcosa blocca la visuale del cielo della parabola";
    cause_no_signal: "no signal from the Starlink network", "nessun segnale dalla rete Starlink";
    cause_booting: "the dish is restarting", "la parabola si sta riavviando";
    cause_searching: "the dish is searching for satellites", "la parabola sta cercando i satelliti";
    cause_thermal: "the dish is too hot and shut down", "la parabola è troppo calda e si è spenta";
    cause_stowed: "the dish is stowed", "la parabola è in posizione di riposo";
    cause_motors: "the dish motors are stuck", "i motori della parabola sono bloccati";
    cause_unknown: "unknown cause", "causa sconosciuta";
});

catalog!(RuleTexts {
    limited_title: "Limited data", "Dati limitati";
    limited_detail:
        "Only {duration} of the last 24 hours were recorded, so intermittent problems may be missed.",
        "Sono state registrate solo {duration} delle ultime 24 ore, quindi problemi intermittenti potrebbero sfuggire.";
    limited_action:
        "Keep StarlinkPulse running (it can stay in the tray) and run the diagnosis again later.",
        "Lascia StarlinkPulse in esecuzione (può restare nella barra di sistema) e ripeti la diagnosi più tardi.";
    obstruction_title: "Dish view obstructed", "Visuale della parabola ostruita";
    obstruction_detail:
        "{pct} of the sky is obstructed and obstructions caused {duration} of outages in the last 24 h.",
        "Il {pct} del cielo è ostruito e le ostruzioni hanno causato {duration} di interruzioni nelle ultime 24 h.";
    obstruction_action_map:
        "Open the obstruction map to see where the blocked area is.",
        "Apri la mappa delle ostruzioni per vedere dov'è la zona bloccata.";
    obstruction_action_move:
        "Move the dish higher or to a spot with a clear view of the sky, or trim the obstacle (trees, roof edge, walls).",
        "Sposta la parabola più in alto o in un punto con cielo libero, oppure riduci l'ostacolo (alberi, bordo del tetto, muri).";
    orientation_unknown_title:
        "Dish orientation differs from the recommendation",
        "L'orientamento della parabola differisce da quello consigliato";
    orientation_unknown_detail:
        "The dish reports a correction of {az} in direction and {el} in tilt. It is not known whether this dish has motors.",
        "La parabola indica una correzione di {az} in direzione e {el} in inclinazione. Non è noto se questa parabola abbia motori.";
    orientation_unknown_action:
        "If your dish has no motors, open the alignment helper in the app and follow its guidance.",
        "Se la tua parabola non ha motori, apri l'assistente di allineamento nell'app e segui le indicazioni.";
    misaligned_title:
        "Dish not aimed where Starlink recommends",
        "Parabola non orientata come consigliato da Starlink";
    misaligned_detail:
        "The dish points {az} off in direction and {el} off in tilt from the recommended orientation, more than the {tol}° Starlink tolerates.",
        "La parabola è spostata di {az} in direzione e di {el} in inclinazione rispetto all'orientamento consigliato, oltre i {tol}° tollerati da Starlink.";
    rotate_cw: "Rotate the dish {deg} clockwise, seen from above.", "Ruota la parabola di {deg} in senso orario, vista dall'alto.";
    rotate_ccw: "Rotate the dish {deg} counter-clockwise, seen from above.", "Ruota la parabola di {deg} in senso antiorario, vista dall'alto.";
    tilt_up: "Tilt the dish {deg} up.", "Inclina la parabola di {deg} verso l'alto.";
    tilt_down: "Tilt the dish {deg} down.", "Inclina la parabola di {deg} verso il basso.";
    alignment_confirm:
        "Use the alignment helper in the app to confirm the new position.",
        "Usa l'assistente di allineamento nell'app per confermare la nuova posizione.";
    throttle_title: "Speed limited by your plan", "Velocità limitata dal tuo piano";
    throttle_detail:
        "Starlink limited your speed (POLICY_LIMIT) for {minutes} min, {pct} of the recorded time. This is a plan setting (deprioritization or data limit), not an equipment fault.",
        "Starlink ha limitato la tua velocità (POLICY_LIMIT) per {minutes} min, il {pct} del tempo registrato. È un'impostazione del piano (depriorizzazione o limite dati), non un guasto dell'apparecchiatura.";
    throttle_permanent:
        " The limit is active almost all the time, which is typical of deprioritized or limited plans.",
        " Il limite è attivo quasi sempre, come è tipico dei piani depriorizzati o limitati.";
    throttle_action_plan:
        "Check your plan and data usage in the Starlink app.",
        "Controlla il tuo piano e il consumo dati nell'app Starlink.";
    throttle_action_schedule:
        "Schedule large downloads outside the busiest evening hours.",
        "Pianifica i download pesanti fuori dalle ore serali più trafficate.";
    network_title: "Outages on the Starlink side", "Interruzioni lato Starlink";
    network_detail:
        "{duration} of outages without obstruction in the last 24 h ({causes}). {view}",
        "{duration} di interruzioni senza ostruzioni nelle ultime 24 h ({causes}). {view}";
    network_clear_view:
        "The dish had a clear view of the sky, so these most likely come from the satellite network or coverage.",
        "La parabola aveva il cielo libero, quindi molto probabilmente dipendono dalla rete satellitare o dalla copertura.";
    network_no_obstruction:
        "No significant obstruction was measured, so these most likely come from the satellite network or coverage.",
        "Non è stata misurata alcuna ostruzione significativa, quindi molto probabilmente dipendono dalla rete satellitare o dalla copertura.";
    network_sky_search:
        " SKY_SEARCH can also follow a restart, while the dish looks for satellites.",
        " SKY_SEARCH può anche seguire un riavvio, mentre la parabola cerca i satelliti.";
    network_action_status:
        "Check status.starlink.com or the Starlink app for known outages in your area.",
        "Controlla status.starlink.com o l'app Starlink per interruzioni note nella tua zona.";
    network_action_support:
        "If it keeps happening, report it to Starlink support with the outage times.",
        "Se continua, segnalalo all'assistenza Starlink indicando gli orari delle interruzioni.";
    reboot_title: "Frequent dish restarts", "Riavvii frequenti della parabola";
    reboot_detail:
        "The dish restarted {count} times in the last 24 h ({duration} of BOOTING outages). One restart per day for software updates is normal.",
        "La parabola si è riavviata {count} volte nelle ultime 24 h ({duration} di interruzioni BOOTING). Un riavvio al giorno per gli aggiornamenti software è normale.";
    reboot_action_power:
        "Check the power supply and cable connections; avoid power strips and loose plugs.",
        "Controlla l'alimentatore e i collegamenti dei cavi; evita ciabatte e spine allentate.";
    reboot_action_battery:
        "On battery or solar setups, check that the voltage stays stable under load.",
        "Con batterie o pannelli solari, verifica che la tensione resti stabile sotto carico.";
    reboot_action_support:
        "If restarts continue, contact Starlink support.",
        "Se i riavvii continuano, contatta l'assistenza Starlink.";
    slow_title: "Slow or unstable Starlink connection", "Connessione Starlink lenta o instabile";
    slow_detail:
        "Latency p95 is {p95} ms and {pct} of pings were lost (measured by the dish, so local Wi-Fi is not the cause).",
        "La latenza p95 è {p95} ms e il {pct} dei ping è andato perso (misurato dalla parabola, quindi il Wi-Fi locale non è la causa).";
    slow_congestion:
        " The worst hour ({hour}) reaches {worst} ms, well above the daily average of {avg} ms, which points to network congestion.",
        " L'ora peggiore ({hour}) arriva a {worst} ms, ben sopra la media giornaliera di {avg} ms: indica congestione della rete.";
    slow_action_hours:
        "If problems cluster at the same hours every day, it is likely congestion in your area.",
        "Se i problemi si concentrano alle stesse ore ogni giorno, è probabile congestione nella tua zona.";
    slow_action_wifi:
        "If devices feel slower than these numbers suggest, check your Wi-Fi as well.",
        "Se i dispositivi sembrano più lenti di quanto indicano questi numeri, controlla anche il Wi-Fi.";
    wifi_title: "Weak Wi-Fi signal", "Segnale Wi-Fi debole";
    wifi_detail:
        "The weakest connected device has {dbm} dBm (good is above {limit} dBm). Slowness on that device is local Wi-Fi, not Starlink.",
        "Il dispositivo connesso più debole ha {dbm} dBm (buono sopra {limit} dBm). La lentezza su quel dispositivo dipende dal Wi-Fi locale, non da Starlink.";
    wifi_action_move:
        "Move the device or the router closer, away from walls and metal objects.",
        "Avvicina il dispositivo o il router, lontano da muri e oggetti metallici.";
    wifi_action_mesh:
        "Add a Starlink mesh node or use a cable for fixed devices.",
        "Aggiungi un nodo mesh Starlink o usa un cavo per i dispositivi fissi.";
    thermal_shutdown_title: "Dish shut down from heat", "Parabola spenta per il calore";
    thermal_title: "Dish overheating", "Parabola surriscaldata";
    thermal_detail:
        "The dish reports a thermal alert and limits its performance to cool down.",
        "La parabola segnala un allarme termico e riduce le prestazioni per raffreddarsi.";
    thermal_action_air:
        "Give the dish free air flow and avoid enclosures or hot surfaces under it.",
        "Lascia circolare l'aria intorno alla parabola ed evita involucri o superfici calde sotto di essa.";
    thermal_action_cover:
        "Do not cover the dish; it cools down by itself when temperatures drop.",
        "Non coprire la parabola; si raffredda da sola quando la temperatura scende.";
    healthy_title: "Connection healthy", "Connessione in salute";
    healthy_detail:
        "Latency p95 {p95} ms, {pct} ping loss, {count} outages ({duration}) in the last 24 h.",
        "Latenza p95 {p95} ms, {pct} di ping persi, {count} interruzioni ({duration}) nelle ultime 24 h.";
    healthy_action: "No action needed.", "Nessuna azione necessaria.";
    not_available: "n/a", "n.d.";
    headline_none: "No problems found in the last 24 hours.", "Nessun problema rilevato nelle ultime 24 ore.";
    headline_one: "1 issue found: {title}.", "1 problema rilevato: {title}.";
    headline_many: "{count} issues found; most important: {title}.", "{count} problemi rilevati; il più importante: {title}.";
});

catalog!(ReportTexts {
    title: "StarlinkPulse support report", "Report di supporto StarlinkPulse";
    generated: "Generated {time} (local time) with StarlinkPulse {version}.", "Generato il {time} (ora locale) con StarlinkPulse {version}.";
    simulated: "Simulated data (mock mode), not a real dish.", "Dati simulati (modalità mock), non una parabola reale.";
    dish: "Dish", "Parabola";
    hardware: "Hardware", "Hardware";
    firmware: "Firmware", "Firmware";
    motorized: "Motorized", "Motorizzata";
    yes: "yes", "sì";
    no: "no", "no";
    unknown: "unknown", "sconosciuto";
    none: "none", "nessuno";
    coverage: "Data coverage (24 h)", "Copertura dati (24 h)";
    coverage_value: "{pct} ({minutes} min of history)", "{pct} ({minutes} min di storico)";
    uptime: "Uptime", "Disponibilità";
    window: "Window", "Periodo";
    outages: "Outages", "Interruzioni";
    downtime: "Downtime", "Tempo offline";
    last_24h: "Last 24 hours", "Ultime 24 ore";
    latency: "Latency avg / p95", "Latenza media / p95";
    loss: "Ping loss", "Ping persi";
    obstruction: "Sky obstructed", "Cielo ostruito";
    throttled: "Throttled minutes", "Minuti con banda limitata";
    alerts: "Active alerts", "Avvisi attivi";
    outages_48h: "Outages (last 48 h)", "Interruzioni (ultime 48 h)";
    no_outages: "No outages recorded.", "Nessuna interruzione registrata.";
    totals_by_cause: "Totals by cause", "Totali per causa";
    cause: "Cause", "Causa";
    count: "Count", "Numero";
    duration: "Duration", "Durata";
    start: "Start", "Inizio";
    more_rows: "{count} older outages not shown.", "{count} interruzioni meno recenti non mostrate.";
    diagnosis: "Diagnosis (built-in rules)", "Diagnosi (regole integrate)";
    no_findings: "No problems found.", "Nessun problema rilevato.";
    info: "info", "info";
    warning: "warning", "attenzione";
    critical: "critical", "critico";
    wifi: "Wi-Fi (Starlink router)", "Wi-Fi (router Starlink)";
    wifi_absent: "Starlink router not detected (third-party router or bypass mode).", "Router Starlink non rilevato (router di terze parti o modalità bypass).";
    wifi_devices: "Devices: {total} (2.4 GHz: {b24}, 5 GHz: {b5}, 6 GHz: {b6}, Ethernet: {eth}, other: {other})", "Dispositivi: {total} (2,4 GHz: {b24}, 5 GHz: {b5}, 6 GHz: {b6}, Ethernet: {eth}, altri: {other})";
    wifi_signal: "Wireless signal: good {good}, fair {fair}, poor {poor}; weakest {weakest}", "Segnale wireless: buono {good}, discreto {fair}, scarso {poor}; il più debole {weakest}";
    privacy: "This report contains no device IDs, location/GPS, MAC addresses or device names.", "Questo report non contiene ID dispositivo, posizione/GPS, indirizzi MAC né nomi dei dispositivi.";
});

/// Placeholders (`{name}`) used in a template, sorted.
#[cfg(test)]
pub(crate) fn placeholders(t: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = t;
    while let Some(i) = rest.find('{') {
        let after = &rest[i + 1..];
        if let Some(j) = after.find('}') {
            out.push(after[..j].to_string());
            rest = &after[j + 1..];
        } else {
            break;
        }
    }
    out.sort();
    out
}

#[cfg(test)]
pub(crate) fn check_catalog(entries: Vec<(&str, &str, &str)>) {
    for (key, en, it) in entries {
        assert!(
            !en.trim().is_empty() && !it.trim().is_empty(),
            "{key} empty"
        );
        assert_eq!(
            placeholders(en),
            placeholders(it),
            "placeholders differ for {key}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution() {
        assert_eq!(resolve(AppLanguage::En, Some("it-IT")), Lang::En);
        assert_eq!(resolve(AppLanguage::It, Some("en-US")), Lang::It);
        assert_eq!(resolve(AppLanguage::System, Some("it-IT")), Lang::It);
        assert_eq!(resolve(AppLanguage::System, Some("it_CH")), Lang::It);
        assert_eq!(resolve(AppLanguage::System, Some("IT")), Lang::It);
        assert_eq!(resolve(AppLanguage::System, Some("en-GB")), Lang::En);
        assert_eq!(resolve(AppLanguage::System, Some("de-DE")), Lang::En);
        assert_eq!(resolve(AppLanguage::System, None), Lang::En);
        assert_eq!(Lang::It.code(), "it");
    }

    #[test]
    fn catalogs_complete_and_consistent() {
        check_catalog(ErrorTexts::entries());
        check_catalog(TrayTexts::entries());
        check_catalog(NotifyTexts::entries());
        check_catalog(RuleTexts::entries());
        check_catalog(ReportTexts::entries());
    }

    #[test]
    fn number_and_template_formatting() {
        assert_eq!(dec(Lang::En, 1.25, 1), "1.2");
        assert_eq!(dec(Lang::It, 2.55, 1), "2,5");
        assert_eq!(dec_trim(Lang::It, 11.0, 1), "11");
        assert_eq!(dec_trim(Lang::It, 2.5, 1), "2,5");
        assert_eq!(dec_trim(Lang::En, 100.0, 0), "100");
        assert_eq!(fill("a {x} b {y}", &[("x", "1"), ("y", "2")]), "a 1 b 2");
        assert_eq!(placeholders("{b} and {a}"), vec!["a", "b"]);
    }
}
