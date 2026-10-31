import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Eye, EyeOff, Network, Plus } from "lucide-react";
import type { CLIProxyStatus, OmniRouteStatus, ProviderUsage, UsageProviderName } from "../../shared/protocol.ts";
import { useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { formatPercent, moveInOrder, newOmniRouteProviders, orderProviders, providerMark, providerName, tightestWindow, usageName, useUsage, viaOmniRoute } from "../lib/usage.ts";
import { AgentMark } from "./AgentMark.tsx";
import { cliProxyRequest, fetchOmniRouteStatus, omniRouteRequest } from "../lib/api.ts";
import { UsageAccountDialog } from "./UsageAccountDialog.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Segmented, SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";
import "./UsageSettings.css";

function ProviderAccounts({ id, providers }: { readonly id: UsageProviderName; readonly providers: readonly ProviderUsage[] }) {
  const { settings, update } = useSettings();
  const t = useT();
  const all = orderProviders(providers, settings.usageOrder);
  const ordered = all.filter((usage) => usage.id === id);
  const move = (key: string, by: -1 | 1) => {
    const group = moveInOrder(ordered.map((usage) => usage.key), [], key, by);
    let index = 0;
    const keys = all.map((usage) => usage.id === id ? group[index++] ?? usage.key : usage.key);
    update({ usageOrder: [...keys, ...settings.usageOrder.filter((known) => !keys.includes(known))] });
  };
  return ordered.length === 0 ? <p className="settings-item settings-hint">{t("No accounts signed in")}</p> : <ol aria-label={providerName(id)}>
    {ordered.map((usage, index) => {
      const name = usageName(usage);
      const hidden = settings.usageHidden.includes(usage.key);
      const status = usage.problem === null ? t("Signed in") : {
        expired: t("Expired"), failed: t("Failed"), rate_limited: t("Failed"), locked: t("Failed"),
      }[usage.problem];
      return <li key={usage.key} className={`usage-accounts-row${hidden ? " is-hidden" : ""}`}>
        <div className="usage-account-identity">
          <span className="usage-accounts-account" title={usage.account ?? undefined}>{usage.account ?? providerName(id)}</span>
          <span className="usage-account-meta">
            <span className="usage-account-source">{usage.key.startsWith(`${id}:cliproxy:`) ? t("Hub") : viaOmniRoute(usage) ? <><AgentMark agent="omniroute" size={12} />OmniRoute</> : t("This PC")}{usage.plan ? ` · ${usage.plan}` : ""}</span>
            <span className={`usage-account-status${usage.problem ? " has-problem" : ""}`}>{status}</span>
          </span>
        </div>
        <span className="usage-accounts-actions">
          <button type="button" className="icon-button" aria-label={t("Move {name} up", { name })} disabled={index === 0} onClick={() => move(usage.key, -1)}><ChevronUp aria-hidden="true" /></button>
          <button type="button" className="icon-button" aria-label={t("Move {name} down", { name })} disabled={index === ordered.length - 1} onClick={() => move(usage.key, 1)}><ChevronDown aria-hidden="true" /></button>
          <button type="button" className="icon-button usage-accounts-visibility" role="switch" aria-checked={!hidden} aria-label={t("Show {name}", { name })}
            onClick={() => update({ usageHidden: hidden ? settings.usageHidden.filter((key) => key !== usage.key) : [...settings.usageHidden, usage.key] })}>
            {hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>
        </span>
      </li>;
    })}
  </ol>;
}

export function UsageSettings({ onLocalLogin }: { readonly onLocalLogin: (paneId: string) => void }) {
  const { settings, update } = useSettings();
  const t = useT();
  // The existing switch still controls whether sign-ins are sent to usage endpoints.
  const usage = useUsage(settings.showUsage);
  const [hub, setHub] = useState<CLIProxyStatus | null>(null);
  const [dialog, setDialog] = useState<"add" | "hub" | "omniroute" | null>(null);
  const [hubError, setHubError] = useState<string | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState<"hub" | "omniroute" | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    void cliProxyRequest<CLIProxyStatus>("", { signal: controller.signal }).then(setHub)
      .catch((cause: unknown) => { if (!controller.signal.aborted) setHubError(cause instanceof Error ? cause.message : t("Hub request failed")); });
    return () => controller.abort();
  }, [t]);
  const [gateway, setGateway] = useState<OmniRouteStatus | null>(null);
  // with plan limits off nothing shows the gateway, and nothing about usage is asked for
  useEffect(() => {
    if (!settings.showUsage) return;
    const controller = new AbortController();
    void fetchOmniRouteStatus(controller.signal).then(setGateway).catch(() => { /* an older server has no gateway */ });
    return () => controller.abort();
  }, [usage.report, settings.showUsage]);
  const reported = usage.report?.providers ?? [];
  // an OmniRoute provider not chosen below stays out of the accounts: the gateway may report dozens
  const providers = reported.filter((usage) => !viaOmniRoute(usage) || settings.usageShown.includes(usage.id));
  const ids: readonly UsageProviderName[] = [...new Set(providers.map((usage) => usage.id))];
  const orderedIds = ["claude", "codex", ...ids.filter((id) => id !== "claude" && id !== "codex")]
    .filter((id) => ids.some((known) => known === id));
  return <>
    <SettingsGroup>
      <SettingsRow label={t("Show plan limits")} description={t("Shows plan usage beside Settings. Sign-ins are sent to each provider's usage API; never refreshed here.")}>
        <Toggle label={t("Show plan limits")} checked={settings.showUsage} onChange={(showUsage) => update({ showUsage })} />
      </SettingsRow>
      {settings.showUsage && <>
        <SettingsRow label={t("Meters show")}>
          <Segmented label={t("Meters show")} value={settings.usageCount} onChange={(usageCount) => update({ usageCount })} options={[{ value: "used", label: t("Used") }, { value: "left", label: t("Remaining") }]} />
        </SettingsRow>
        <SettingsRow label={t("Limit shown")} description={t("Session is the 5-hour limit. Without it, the closest limit is shown.")} wide>
          <Segmented label={t("Limit shown")} value={settings.usageGlance} onChange={(usageGlance) => update({ usageGlance })} options={[{ value: "week", label: t("Weekly") }, { value: "session", label: t("Session") }]} />
        </SettingsRow>
        <SettingsRow label={t("Accounts of one provider")} description={t("Combined averages them by plan size: an Ultra counts 10 times a Pro, a Max 5 times.")} wide>
          <Segmented label={t("Accounts of one provider")} value={settings.usageGroup} onChange={(usageGroup) => update({ usageGroup })} options={[{ value: "provider", label: t("Combined") }, { value: "account", label: t("Each its own") }]} />
        </SettingsRow>
      </>}
    </SettingsGroup>
    <div className="usage-accounts-intro">
      <div className="usage-accounts-header">
        <h3 className="usage-accounts-caption">{t("Accounts")} <span className="usage-account-count">{providers.length}</span></h3>
        <button ref={addButton} className="btn" type="button" onClick={() => setDialog("add")}><Plus size={16} aria-hidden="true" />{t("Add account")}</button>
      </div>
      {!settings.showUsage && <p className="settings-description settings-note">{t("Turn on plan limits to see accounts.")}</p>}
    </div>
    {settings.showUsage && orderedIds.map((id) => <SettingsGroup key={id} className="usage-accounts usage-provider" section={`accounts-${id}`}>
      <div className="settings-item usage-provider-heading">
        <AgentMark agent={providerMark(id)} size={20} /><span>{providerName(id)}</span>
        <span className="usage-account-count">{providers.filter((usage) => usage.id === id).length}</span>
      </div>
      <ProviderAccounts id={id} providers={providers} />
    </SettingsGroup>)}
    {settings.showUsage && providers.length === 0 && <p className="settings-note settings-hint">{usage.loading ? t("Loading…") : t("No accounts yet.")}</p>}
    {hubError && <p className="settings-hint account-error" role="alert">{hubError}</p>}
    {hub?.configured && <SettingsGroup className="usage-connection-card" section="usage-connection">
      <div className="settings-item usage-connection">
        <Network size={20} aria-hidden="true" />
        <div className="usage-connection-info"><span className="settings-label">{t("Hub")}</span><span className="settings-hint" role="status">{hub.url} · {hub.ok ? t("Connected") : hub.problem ?? t("Check the hub connection")}</span></div>
        <div className="usage-connection-actions">
          <button className="btn btn-ghost" type="button" onClick={() => setDialog("hub")}>{t("Edit")}</button>
          <button className="btn btn-ghost" type="button" onClick={() => setConfirmRemoval("hub")}>{t("Remove")}</button>
        </div>
      </div>
    </SettingsGroup>}
    {settings.showUsage && gateway?.configured && <OmniRouteProviders status={gateway} providers={reported}
      onEdit={() => setDialog("omniroute")} onRemove={() => setConfirmRemoval("omniroute")} />}
    {confirmRemoval === "hub" && <ConfirmDialog title={t("Remove hub?")}
      body={t("Its accounts disappear from this list. The hub itself is not changed.")}
      confirmLabel={t("Remove")} onClose={() => setConfirmRemoval(null)} onConfirm={async () => {
        const status = await cliProxyRequest<CLIProxyStatus>("", { method: "DELETE" });
        setHub(status); setConfirmRemoval(null); usage.refresh();
        requestAnimationFrame(() => addButton.current?.focus());
      }} />}
    {confirmRemoval === "omniroute" && <ConfirmDialog title={t("Remove OmniRoute?")}
      body={t("Its accounts disappear from this list. OmniRoute itself is not changed.")}
      confirmLabel={t("Remove")} onClose={() => setConfirmRemoval(null)} onConfirm={async () => {
        const status = await omniRouteRequest({ method: "DELETE" });
        setGateway(status); setConfirmRemoval(null); usage.refresh();
        requestAnimationFrame(() => addButton.current?.focus());
      }} />}
    {dialog && <UsageAccountDialog edit={dialog === "add" ? null : dialog} hub={hub} onHubChanged={setHub} gateway={gateway} onGatewayChanged={(status) => { setGateway(status); usage.refresh(); }} onAccountsChanged={usage.refresh} onLocalLogin={onLocalLogin} onClose={() => setDialog(null)} />}
  </>;
}

/** past this many providers the list gets a search and a Shown/All switch */
const SEARCH_FROM = 8;

/**
 * The providers an OmniRoute gateway reports, each shown in the meters only once chosen here: a
 * gateway can hold dozens, and its list grows. One it starts reporting is marked New until this
 * page is left; it stays out of the meters until switched on.
 */
function OmniRouteProviders({ status, providers, onEdit, onRemove }: {
  readonly status: OmniRouteStatus; readonly providers: readonly ProviderUsage[]; readonly onEdit: () => void; readonly onRemove: () => void;
}) {
  const { settings, update } = useSettings();
  const t = useT();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "shown">("all");
  const groups = useMemo(() => {
    const byId = new Map<string, ProviderUsage[]>();
    for (const usage of providers) if (viaOmniRoute(usage)) byId.set(usage.id, [...byId.get(usage.id) ?? [], usage]);
    return [...byId].map(([id, accounts]) => ({ id, accounts, name: providerName(id) })).sort((a, b) => a.name.localeCompare(b.name));
  }, [providers]);
  const fresh = newOmniRouteProviders(providers, settings.usageKnown);
  // the New marks last while this page is open; leaving it, they are known
  const seen = useRef<string[]>([]);
  seen.current = fresh;
  const known = useRef(settings.usageKnown);
  known.current = settings.usageKnown;
  useEffect(() => () => { if (seen.current.length > 0) update({ usageKnown: [...known.current, ...seen.current] }); }, [update]);
  const shownCount = groups.filter((group) => settings.usageShown.includes(group.id)).length;
  const searchable = groups.length > SEARCH_FROM;
  const needle = query.trim().toLowerCase();
  const listed = groups.filter((group) => (!searchable || filter === "all" || settings.usageShown.includes(group.id))
    && (!searchable || needle === "" || group.name.toLowerCase().includes(needle) || group.id.includes(needle)));
  const toggle = (id: string, on: boolean) => update({ usageShown: on ? [...settings.usageShown, id] : settings.usageShown.filter((known) => known !== id) });
  const state = status.ok ? t("Connected") : status.problem ?? t("Not read yet");
  return <SettingsGroup className="usage-gateway" section="usage-omniroute">
    <div className="settings-item usage-connection">
      {/* the gateway's own mark, as each provider below wears its own */}
      <AgentMark agent="omniroute" size={20} />
      <div className="usage-connection-info">
        <span className="settings-label">OmniRoute</span>
        <span className="settings-hint" role="status">{status.url} · {state}</span>
        {status.source === "env" && <span className="settings-hint">{t("Set by the server")}</span>}
      </div>
      {status.source === "saved" && <div className="usage-connection-actions">
        <button className="btn btn-ghost" type="button" onClick={onEdit}>{t("Edit")}</button>
        <button className="btn btn-ghost" type="button" onClick={onRemove}>{t("Remove")}</button>
      </div>}
    </div>
    <div className="settings-item usage-gateway-head">
      <span className="settings-label">{t("Providers to show")}</span>
      <span className="settings-hint">{t("{shown} of {count} shown", { shown: String(shownCount), count: String(groups.length) })}{fresh.length > 0 ? ` · ${t("{count} new", { count: String(fresh.length) })}` : ""}</span>
    </div>
    {searchable && <div className="settings-item usage-gateway-tools">
      <input className="input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("Search providers")} placeholder={t("Search providers")} />
      <Segmented label={t("Providers listed")} value={filter} onChange={setFilter} options={[{ value: "all", label: t("All") }, { value: "shown", label: t("Shown") }]} />
    </div>}
    {groups.length === 0 && <p className="settings-item settings-hint">{t("OmniRoute reports no plan limits yet.")}</p>}
    {groups.length > 0 && listed.length === 0 && <p className="settings-item settings-hint">{t("No provider matches.")}</p>}
    {listed.length > 0 && <ul className="usage-gateway-list" aria-label={t("Providers to show")}>
      {listed.map((group) => {
        const on = settings.usageShown.includes(group.id);
        const closest = group.accounts.map(tightestWindow).reduce<number | null>((most, window) => window === null ? most : Math.max(most ?? 0, window.used_percent), null);
        const accounts = group.accounts.length === 1 ? t("1 account") : t("{count} accounts", { count: String(group.accounts.length) });
        return <li key={group.id} className={`usage-gateway-row${on ? "" : " is-off"}`}>
          <AgentMark agent={providerMark(group.id)} size={20} />
          <span className="usage-gateway-identity">
            <span className="usage-gateway-name">{group.name}{fresh.includes(group.id) && <span className="usage-gateway-new">{t("New")}</span>}</span>
            <span className="usage-gateway-meta">{accounts}{closest !== null ? ` · ${t("closest {percent} used", { percent: formatPercent(closest) })}` : ""}</span>
          </span>
          <Toggle label={t("Show {name}", { name: group.name })} checked={on} onChange={(next) => toggle(group.id, next)} />
        </li>;
      })}
    </ul>}
  </SettingsGroup>;
}
