import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { disablePush, enablePush, isStandalone, pushState, type PushState } from '../lib/push';

const PUSH_TEXT: Record<PushState, string> = {
  unsupported: 'This browser does not support notifications.',
  'needs-install': 'On iPhone, add this app to your Home Screen first (Share → Add to Home Screen), then open it from there.',
  disabled: 'Notifications are not configured on the server.',
  denied: 'Notifications are blocked. Allow them in your browser or system settings.',
  default: 'Notifications are off.',
  enabled: 'Notifications are on.',
};

export function Settings({ onLogout }: { onLogout: () => void }) {
  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void pushState().then(setPush);
  }, []);

  const toggle = async () => {
    setBusy(true);
    try {
      if (push === 'enabled') {
        await disablePush();
        setPush('default');
      } else {
        setPush(await enablePush());
      }
    } catch {
      setPush(await pushState());
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await disablePush().catch(() => undefined);
    await api.logout().catch(() => undefined);
    onLogout();
  };

  return (
    <div className="settings">
      <section>
        <h2>Notifications</h2>
        <p className="muted">{push ? PUSH_TEXT[push] : 'Checking…'}</p>
        <p className="muted small">Every notification only ever says “Reminder”. No sender, message, file name or preview is shown.</p>
        {(push === 'default' || push === 'enabled') && (
          <button className={push === 'enabled' ? 'secondary' : 'primary'} onClick={() => void toggle()} disabled={busy}>
            {push === 'enabled' ? 'Turn off on this device' : 'Turn on for this device'}
          </button>
        )}
      </section>

      {!isStandalone() && (
        <section>
          <h2>Install</h2>
          <p className="muted small">
            <strong>Android:</strong> browser menu → <em>Add to Home screen</em> / <em>Install app</em>.
          </p>
          <p className="muted small">
            <strong>iPhone:</strong> Safari → Share → <em>Add to Home Screen</em>.
          </p>
          <p className="muted small">
            <strong>Desktop:</strong> use the install icon in the address bar.
          </p>
        </section>
      )}

      <section>
        <h2>Session</h2>
        <button className="danger" onClick={() => void logout()}>
          Sign out
        </button>
      </section>
    </div>
  );
}
