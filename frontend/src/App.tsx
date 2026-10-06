import { useEffect, useState } from 'react';
import { api } from './lib/api';
import { Login } from './components/Login';
import { Space } from './components/Space';
import { PrivacyShield } from './components/PrivacyShield';

type State = { status: 'loading' } | { status: 'anonymous' } | { status: 'ready'; userId: number } | { status: 'offline' };

export function App() {
  const [state, setState] = useState<State>({ status: 'loading' });

  const check = async () => {
    try {
      const session = await api.session();
      setState(session ? { status: 'ready', userId: session.user.id } : { status: 'anonymous' });
    } catch {
      setState({ status: 'offline' });
    }
  };

  useEffect(() => {
    void check();
  }, []);

  useEffect(() => {
    if (state.status !== 'offline') return;
    const retry = () => void check();
    window.addEventListener('online', retry);
    const t = window.setInterval(retry, 15_000);
    return () => {
      window.removeEventListener('online', retry);
      window.clearInterval(t);
    };
  }, [state.status]);

  return (
    <>
      {state.status === 'loading' && <Splash />}
      {state.status === 'offline' && <Splash note="Offline — waiting for connection…" />}
      {state.status === 'anonymous' && <Login onLogin={check} />}
      {state.status === 'ready' && <Space onLogout={() => setState({ status: 'anonymous' })} onExpired={check} />}
      <PrivacyShield />
    </>
  );
}

function Splash({ note }: { note?: string }) {
  return (
    <div className="splash">
      <div className="splash-title">Private Space</div>
      <div className="splash-lock" aria-hidden>
        🔒
      </div>
      {note && <div className="muted">{note}</div>}
    </div>
  );
}
