import { afterEach, describe, expect, it } from "vitest";
import { applyLanguage } from "@/i18n";
import {
  explainCause,
  explainDisablement,
  explainEstimation,
  explainRestriction,
  explainSoftwareUpdate,
} from "@/lib/explain";

afterEach(() => applyLanguage("en"));

describe("dish enum labels", () => {
  it("labels software update states, with or without the enum prefix", () => {
    expect(explainSoftwareUpdate("IDLE")).toBe("Up to date");
    expect(explainSoftwareUpdate("SOFTWARE_UPDATE_STATE_REBOOT_REQUIRED")).toBe("Restart needed to finish update");
    expect(explainSoftwareUpdate("FETCHING")).toBe("Downloading update");
    expect(explainSoftwareUpdate(null)).toBeNull();
  });

  it("labels disablement codes and hides OKAY", () => {
    expect(explainDisablement("OKAY")).toBeNull();
    expect(explainDisablement("NO_ACTIVE_ACCOUNT")).toBe("No active account");
    expect(explainDisablement("TOO_FAR_FROM_SERVICE_ADDRESS")).toBe("Too far from the service address");
  });

  it("labels restriction reasons and outage causes", () => {
    expect(explainRestriction("POLICY_LIMIT").title).toBe("Speed limited by plan");
    expect(explainRestriction("NO_LIMIT").restricted).toBe(false);
    expect(explainCause("NO_SATS")).toBe("No satellites in view");
    expect(explainCause("OUTAGE_ACTUATOR_ACTIVITY")).toBe("Dish moving");
  });

  it("labels estimator states", () => {
    expect(explainEstimation("FILTER_CONVERGED")).toBe("Position settled");
    expect(explainEstimation("FILTER_CONVERGING")).toBe("Settling position");
    expect(explainEstimation("ATTITUDE_FILTER_RESET")).toBe("Position estimate restarted");
  });

  it("falls back to a humanized name for unknown values", () => {
    expect(explainSoftwareUpdate("SOME_NEW_STATE")).toBe("Some new state");
    expect(explainDisablement("BRAND_NEW_CODE")).toBe("Brand new code");
    expect(explainRestriction("NEW_REASON").title).toBe("New reason");
    expect(explainEstimation("FILTER_SOMETHING_ELSE")).toBe("Something else");
  });

  it("translates the labels into Italian", () => {
    applyLanguage("it");
    expect(explainSoftwareUpdate("IDLE")).toBe("Aggiornato");
    expect(explainDisablement("NO_ACTIVE_ACCOUNT")).toBe("Nessun account attivo");
    expect(explainEstimation("FILTER_CONVERGING")).toBe("Posizione in stabilizzazione");
    expect(explainCause("NO_DOWNLINK")).toBe("Nessun downlink");
    expect(explainRestriction("POLICY_LIMIT").title).toBe("Velocità limitata dal piano");
  });
});
