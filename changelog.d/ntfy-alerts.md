### Added
- Alerts can also go to an [ntfy](https://ntfy.sh) topic: set `HERDR_WEB_NTFY_URL` and
  `HERDR_WEB_NTFY_TOPIC` (and a token if the topic needs one). The topic gets what a device
  gets, on the same schedule, held while a window of the app is in use; a tap opens the pane
  when `HERDR_WEB_NTFY_CLICK_URL` names the app.
