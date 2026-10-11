// Project save/load and storage usage (detailed design 13.5, 16.6).
import { useEffect, useRef, useState } from "react";
import { formatBytes } from "../../app/envCheck";

export function ProjectPanel({ busy, hasWork, onExport, onImport }: { busy: boolean; hasWork: boolean; onExport: (includeRenders: boolean) => void; onImport: (file: File) => void }) {
  const [includeRenders, setIncludeRenders] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <section className="panel project">
      <h2>プロジェクト</h2>
      <div className="export-row">
        <button onClick={() => onExport(includeRenders)} disabled={busy || !hasWork}>
          プロジェクトファイルに保存（.akmaster）
        </button>
        <label>
          <input type="checkbox" checked={includeRenders} onChange={() => setIncludeRenders(!includeRenders)} /> 処理結果も含める（ファイルが大きくなるが、読み込み後すぐに使える）
        </label>
        <button onClick={() => input.current?.click()} disabled={busy}>
          プロジェクトファイルを読み込む
        </button>
        <input
          ref={input}
          type="file"
          hidden
          accept=".akmaster"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImport(f);
            e.target.value = "";
          }}
        />
      </div>
      <p className="sub">作業はこのブラウザに自動で保存されています。別の PC やブラウザに移すとき、バックアップを取るときにプロジェクトファイルを使ってください。</p>
      <StorageInfo />
    </section>
  );
}

/** Storage used by the app in this browser and whether it is protected from eviction. */
export function StorageInfo() {
  const [info, setInfo] = useState<{ usage: number; quota: number; persisted: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    const update = async () => {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      const persisted = (await navigator.storage.persisted?.()) ?? false;
      if (alive) setInfo({ usage, quota, persisted });
    };
    void update();
    const t = setInterval(update, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!info) return null;
  return (
    <p className="sub storage">
      ブラウザ内の保存容量：使用 {formatBytes(info.usage)} ／ 上限 {formatBytes(info.quota)}・自動削除からの保護：{info.persisted ? "有効" : "未許可（容量が足りなくなるとブラウザに削除されることがあります）"}
    </p>
  );
}
