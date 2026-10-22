import { useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { OmniRouteStatus } from "../../shared/protocol.ts";
import { omniRouteRequest } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";

/** The OmniRoute gateway's URL and a `read` access token, saved on the server like the Hub's key. */
export function UsageOmniRouteConnect({ gateway, onConnected, onDone }: {
  readonly gateway: OmniRouteStatus | null;
  readonly onConnected: (status: OmniRouteStatus) => void;
  readonly onDone: () => void;
}) {
  const t = useT();
  const [url, setUrl] = useState(gateway?.url ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenShown, setTokenShown] = useState(false);
  const [connected, setConnected] = useState(false);
  const token = useRef<HTMLInputElement>(null);
  if (connected) return <div className="account-auth-form">
    <p className="settings-label" role="status">{t("Connected")}</p>
    <p className="settings-hint">{t("Choose the providers to show under OmniRoute in Subscription usage.")}</p>
    <button className="btn" type="button" onClick={onDone}>{t("Done")}</button>
  </div>;
  return <form className="account-auth-form" onSubmit={(event) => {
    event.preventDefault();
    const secret = token.current?.value.trim() ?? "";
    if (token.current) token.current.value = "";
    setBusy(true); setError(null);
    void omniRouteRequest({
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, ...(secret ? { token: secret } : {}) }),
    }).then((status) => {
      onConnected(status);
      if (!status.ok) { setError(status.problem ?? t("Could not reach OmniRoute")); return; }
      setConnected(true);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t("OmniRoute request failed")))
      .finally(() => setBusy(false));
  }}>
    <p className="settings-hint">{t("A read-only access token (oma_…) from OmniRoute's API keys. It stays on this PC.")}</p>
    <label className="settings-label" htmlFor="usage-omniroute-url">{t("OmniRoute URL")}</label>
    <input id="usage-omniroute-url" className="input" type="url" placeholder="http://localhost:20128" value={url} onChange={(event) => setUrl(event.target.value)} required disabled={busy} />
    <label className="settings-label" htmlFor="usage-omniroute-token">{t("Access token")}</label>
    <div className="usage-hub-key">
      <input ref={token} id="usage-omniroute-token" className="input" type={tokenShown ? "text" : "password"} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={busy} placeholder={gateway?.source === "saved" ? t("Blank keeps the saved token") : undefined} required={gateway?.source !== "saved"} />
      <button type="button" className="icon-button" aria-pressed={tokenShown} aria-controls="usage-omniroute-token" aria-label={t("Show token")} title={t("Show token")} onClick={() => setTokenShown(!tokenShown)}>
        {tokenShown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </button>
    </div>
    {error && <p className="settings-hint account-error" role="alert">{error}</p>}
    <button className="btn" type="submit" disabled={busy || !url}>{busy ? t("Connecting…") : t("Connect")}</button>
  </form>;
}
