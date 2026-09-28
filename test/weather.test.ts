import { describe, expect, it } from "vitest";
import { parseWeather } from "../src/weather";

describe("parseWeather", () => {
  it("reads Open-Meteo's answer", () => {
    // A real answer for Bandung, trimmed.
    const answer = {
      current: { time: "2026-09-28T13:45", interval: 900, temperature_2m: 23.5, precipitation: 0.1, is_day: 0 },
    };
    expect(parseWeather(answer)).toEqual({ tempC: 23.5, raining: true, isDay: false });
  });

  it("rejects anything unexpected", () => {
    const bad = [
      null,
      5,
      "sunny",
      {},
      { current: {} },
      { current: { temperature_2m: "hot", precipitation: 0, is_day: 1 } },
      { current: { temperature_2m: 20, precipitation: 0, is_day: 2 } },
    ];
    for (const b of bad) expect(parseWeather(b)).toBeNull();
  });
});