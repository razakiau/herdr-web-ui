import type { Translate } from "./i18n.ts";
import type { Settings } from "./settings.ts";
import type { NotificationState } from "./notifications.ts";
import { pushSupported } from "./push.ts";

export interface AlertsBellParams {
  t: Translate;
  settings: Settings;
  alertsOn: boolean;
  notifications: NotificationState;
  pushOn: boolean;
  enableNotifications: () => Promise<unknown>;
  disableNotifications: () => Promise<unknown>;
  /** the server's ntfy topic, when it has one: with it, push off here is a choice, not a gap */
  ntfyTopic?: string | null;
}

/** What the "Push to this device" item in the header's More menu shows and does. */
export function alertsBell({ t, settings, alertsOn, notifications, pushOn, enableNotifications, disableNotifications, ntfyTopic = null }: AlertsBellParams) {
  // The menu's push item: web push to this device, one channel of the alerts beside the in-app
  // ones and the server's ntfy topic (Settings -> Alerts holds all three). A device that has not
  // answered the permission question is asked by the item; one that has answered gets a plain switch.
  const bell: { state: string; title: string; on: boolean; run: () => Promise<unknown> } =
    !alertsOn || notifications !== "granted"
      ? { state: t("Off"), title: t("Push alerts to this device, even with the app closed. Tap to turn them on"), on: false, run: enableNotifications }
      : pushOn
        ? { state: t("On"), title: t("Alerts are pushed to this device, even with the app closed. Tap to turn them off"), on: true, run: disableNotifications }
        : {
            state: t("On while this tab is open"),
            // turning them off and on again retries the push subscription
            title: t("The push service could not be reached: alerts show while this tab is open. Tap to turn them off"),
            on: true,
            run: disableNotifications,
          };
  // hidden where push cannot work: no push in this browser, or notifications blocked
  const bellVisible = pushSupported() && notifications !== "denied";
  // the menu's button carries a dot while alerts are off here: the one state of the menu worth a glance,
  // only when nothing tells this device at all: no push, no in-app alerts, no ntfy topic
  const alertsOffDot = bellVisible && !bell.on && !settings.alertInApp && ntfyTopic === null;
  return { bell, bellVisible, alertsOffDot };
}
