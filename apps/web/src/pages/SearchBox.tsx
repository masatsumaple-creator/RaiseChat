import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

/** ワークスペースの上部の、検索のボックス(FR-110)。送信すると、結果の画面へ移る(検索語は URL の q) */
export function SearchBox({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const urlQuery = params.get('q') ?? '';
  const [value, setValue] = useState(urlQuery);

  // 結果の画面で、検索語が変わったとき(戻る・進む)に、入力欄を合わせる
  useEffect(() => setValue(urlQuery), [urlQuery]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const q = value.trim();
    // 空は、移らない。1 文字は、結果の画面で、案内を出す
    if (q === '') return;
    void navigate(`/w/${workspaceId}/search?q=${encodeURIComponent(q)}`);
  }

  return (
    <form role="search" onSubmit={onSubmit} className="search-box">
      <label>
        メッセージを検索
        <input
          type="search"
          name="q"
          maxLength={100}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <button type="submit">検索</button>
    </form>
  );
}
