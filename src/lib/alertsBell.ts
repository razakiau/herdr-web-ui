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

/**
 * What the Alerts item in the header's More menu shows and does: upstream's item and words, read the
 * fork's way. In-app alerts, their sound and the server's ntfy topic do not wait on this device's
 * push (lib/useAlertSignals.ts); the item turns push alone on and off, so its tooltips say so, and
 * in-app alerts keep their own switch in Settings -> Alerts.
 */
export function alertsBell({ t, settings, alertsOn, notifications, pushOn, enableNotifications, disableNotifications, ntfyTopic = null }: AlertsBellParams) {
  // The item says what this device does, whatever the browser's permission: in-app alerts need
  // none, so they count as on. A device that has not answered the permission question is asked by
  // the item; one that has answered gets a plain switch.
  const pushing = alertsOn && notifications === "granted";
  const bell: { state: string; title: string; on: boolean; run: () => Promise<unknown> } =
    pushing
      ? pushOn
        ? { state: t("On, pushed to this device"), title: t("Alerts are pushed to this device, even with the app closed. Tap to stop pushing them here"), on: true, run: disableNotifications }
        : {
            state: t("On in this tab"),
            // turning them off and on again retries the push subscription
            title: pushSupported()
              ? t("The push service could not be reached: alerts show while this tab is open. Tap to stop pushing them here")
              : t("Alerts on while this tab is open (closed-app alerts need https, and on iPhone the home-screen app). Tap to stop pushing them here"),
            on: true,
            run: disableNotifications,
          }
      : !settings.alertInApp
        ? { state: t("Off on this device"), title: t("Push alerts to this device, even with the app closed. Tap to turn them on"), on: false, run: enableNotifications }
        // in-app alerts are on whatever push does: the item offers push, where the browser can still allow it
        : { state: t("On in the app"), title: notifications === "denied" ? t("Alerts on in the app. Notifications are blocked in this browser's settings") : t("Alerts on in the app. Tap to push them to this device when it is closed too"), on: true, run: enableNotifications };
  // hidden only where it could do nothing: no system notifications and in-app alerts off
  const bellVisible = notifications === "default" || notifications === "granted" || settings.alertInApp;
  // the menu's button carries a dot while nothing tells this device at all: no push, no in-app alerts, no ntfy topic
  const alertsOffDot = bellVisible && !bell.on && ntfyTopic === null;
  return { bell, bellVisible, alertsOffDot };
}
