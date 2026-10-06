import { useEffect, useState } from 'react';

/**
 * Covers the conversation whenever the app leaves the foreground, so app
 * switchers and task-view snapshots show a neutral lock screen instead of
 * the last messages.
 */
export function PrivacyShield() {
  const [hidden, setHidden] = useState(document.visibilityState === 'hidden');

  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === 'hidden');
    const onHide = () => setHidden(true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onVisibility);
    };
  }, []);

  if (!hidden) return null;
  return (
    <div className="shield" role="presentation">
      <div className="splash-title">Private Space</div>
      <div className="splash-lock" aria-hidden>
        🔒
      </div>
    </div>
  );
}
