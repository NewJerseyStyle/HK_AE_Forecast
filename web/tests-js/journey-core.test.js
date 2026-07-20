import { describe, expect, it } from "vitest";
import { planningRecommendation } from "../journey-core.js";

describe("pre-arrival safety journey", () => {
  it("never shows wait-time ranking for emergency or uncertain urgent paths", () => {
    expect(planningRecommendation("emergency").showForecast).toBe(false);
    expect(planningRecommendation("urgent").showForecast).toBe(false);
  });

  it("shows IV/V reference only for the explicitly stable A&E path", () => {
    expect(planningRecommendation("stable_ae").showForecast).toBe(true);
    expect(planningRecommendation("primary_care").showForecast).toBe(false);
  });

  it("rejects unknown paths instead of defaulting to a clinical category", () => {
    expect(planningRecommendation("t3")).toBeNull();
    expect(planningRecommendation()).toBeNull();
  });
});
