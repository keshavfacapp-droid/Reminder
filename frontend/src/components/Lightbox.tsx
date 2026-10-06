import { useEffect } from 'react';
import { fileUrl } from '../lib/api';
import type { Message } from '../lib/types';

export function Lightbox({ message, onClose }: { message: Message; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const file = message.file!;
  return (
    <div className="lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <img src={fileUrl(message.id, file.display ? 'display' : 'original')} alt="Photo" onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <a href={fileUrl(message.id, 'original', true)} download={file.name}>
          Download original
        </a>
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
