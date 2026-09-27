import logo from "./assets/glLogo-mark.png";
import { CallHistory } from "./components/CallHistory";
import { Icon, type IconName } from "./components/Icon";
import { LiveCall } from "./components/LiveCall";
import { useAlertNotifications, type AlertPermission } from "./notifications";
import { Link, useRoute } from "./router";
import { useTheme, type ThemePreference } from "./theme";
import { useDashboard, type ConnectionStatus, type Subscription } from "./ws-client";

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "Connecting",
  open: "Connected",
  reconnecting: "Reconnecting",
};

export function App() {
  const route = useRoute();
  // App-level, not per page, so the guardian is notified on every route.
  const alerts = useAlertNotifications();
  const theme = useTheme();

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <img src={logo} alt="" width={40} height={40} className="brand-mark" />
          <span className="brand-name">Guardian Loop</span>
        </Link>
        <div className="topbar-tools">
          <AlertToggle permission={alerts.permission} onEnable={alerts.request} />
          <ThemeToggle pref={theme.pref} onCycle={theme.cycle} />
        </div>
        <nav className="tabs" aria-label="Views">
          <Link to="/" className={route.name === "live" ? "tab active" : "tab"}>
            Live call
          </Link>
          <Link to="/history" className={route.name === "history" ? "tab active" : "tab"}>
            History
          </Link>
        </nav>
      </header>
      <main>
        {route.name === "live" ? <LivePage subscription={route.callId} /> : <CallHistory selected={route.callId} />}
      </main>
    </div>
  );
}

const THEME_META: Record<ThemePreference, { icon: IconName; label: string; next: string }> = {
  system: { icon: "monitor", label: "Theme follows your device", next: "light" },
  light: { icon: "sun", label: "Light theme", next: "dark" },
  dark: { icon: "moon", label: "Dark theme", next: "your device" },
};

function ThemeToggle({ pref, onCycle }: { pref: ThemePreference; onCycle: () => void }) {
  const meta = THEME_META[pref];
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={onCycle}
      aria-label={`${meta.label}. Switch to ${meta.next}.`}
      title={`${meta.label} — click for ${meta.next}`}
    >
      <Icon name={meta.icon} />
    </button>
  );
}

/**
 * Browser notifications need a one-time permission, which browsers only let a click
 * ask for. A denied permission can't be re-prompted from the page, so that state says
 * where to fix it instead of showing a button that does nothing.
 */
function AlertToggle({ permission, onEnable }: { permission: AlertPermission; onEnable: () => void }) {
  if (permission === "unsupported") return null;
  if (permission === "granted") {
    return (
      <span className="alert-state alert-state-on" title="You'll get a notification if a call looks like a scam">
        <Icon name="bell" size={18} />
        <span className="label-long">Alerts on</span>
        <span className="label-short">On</span>
      </span>
    );
  }
  if (permission === "denied") {
    return (
      <span className="alert-state alert-state-off" title="Allow notifications for this site in your browser's site settings">
        <Icon name="bellOff" size={18} />
        <span className="label-long">Alerts blocked</span>
        <span className="label-short">Blocked</span>
      </span>
    );
  }
  return (
    <button type="button" className="btn btn-primary btn-sm" onClick={onEnable}>
      <Icon name="bell" size={18} />
      <span className="label-long">Turn on alerts</span>
      <span className="label-short" aria-hidden="true">Alerts</span>
    </button>
  );
}

function LivePage({ subscription }: { subscription: Subscription }) {
  const { state, status, ackAlert } = useDashboard(subscription);
  return (
    <>
      <p className={`conn conn-${status}`} role="status">
        <span className="conn-dot" aria-hidden="true" />
        {STATUS_TEXT[status]}
        {subscription === "latest" ? " · showing the latest call" : ""}
      </p>
      {/* Keyed by call so per-call UI state (acks, scroll) resets when "latest" moves on. */}
      <LiveCall key={state.call?.callId ?? "none"} call={state.call} following={subscription === "latest"} onAck={ackAlert} />
    </>
  );
}
