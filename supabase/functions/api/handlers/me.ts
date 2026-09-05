import type { Handler } from "../index.ts";
import { allWindows } from "../../_shared/periods.ts";
import { loadSettings } from "./preferences.ts";

export const getMe: Handler = async (ctx) => {
  const settings = await loadSettings(ctx);
  const windows = allWindows(new Date(), settings.time_zone);
  return {
    status: 200,
    body: {
      ownerId: ctx.ownerId,
      principal: ctx.principal,
      scopes: [...ctx.scopes],
      timeZone: settings.time_zone,
      onboardingComplete: settings.onboarding_complete,
      windows: Object.fromEntries(
        Object.entries(windows).map(([h, w]) => [
          h,
          { periodKey: w.periodKey, label: w.label, start: w.startUtc.toISOString(), end: w.endUtc.toISOString() },
        ]),
      ),
    },
  };
};
