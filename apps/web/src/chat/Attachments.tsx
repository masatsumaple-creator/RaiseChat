import type { AttachmentResponse } from '@raisechat/shared';
import { useState } from 'react';
import { formatSize } from './attachment-rules';

/** 添付の URL(同じオリジン。認可は、サーバーが、Cookie で行う) */
export const attachmentUrl = (id: string) => `/api/attachments/${id}`;

/**
 * メッセージの添付(FR-107)。画像は、プレビューで表示し、押すと拡大する。動画は、その場で再生できる(controls)。
 */
export function Attachments({ attachments }: { attachments: AttachmentResponse[] }) {
  const [zoomed, setZoomed] = useState<AttachmentResponse | null>(null);
  if (attachments.length === 0) return null;
  return (
    <>
      <ul className="attachments" aria-label="添付">
        {attachments.map((a) => (
          <li key={a.id}>
            {a.kind === 'image' ? (
              <button
                type="button"
                className="attachment-image"
                aria-label={`${a.name} を拡大`}
                onClick={() => setZoomed(a)}
              >
                <img src={attachmentUrl(a.id)} alt={a.name} loading="lazy" />
              </button>
            ) : (
              <video src={attachmentUrl(a.id)} controls preload="metadata" aria-label={a.name} />
            )}
            <span className="attachment-meta">
              {a.name}({formatSize(a.sizeBytes)})
            </span>
          </li>
        ))}
      </ul>
      {zoomed && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${zoomed.name} の拡大`}
          className="lightbox"
          onClick={() => setZoomed(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setZoomed(null);
          }}
        >
          <img src={attachmentUrl(zoomed.id)} alt={zoomed.name} />
          <button type="button" autoFocus onClick={() => setZoomed(null)}>
            閉じる
          </button>
        </div>
      )}
    </>
  );
}
