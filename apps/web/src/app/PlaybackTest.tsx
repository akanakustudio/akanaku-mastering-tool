import { useEffect, useMemo, useRef, useState } from "react";
import { Mode, SAMPLE_RATE, type ModeValue } from "../audio/layout";
import { Player } from "../audio/player";
import { afterSample, beforeSample, renderTestSignal } from "../audio/testSignals";
import { measureSwitching, swapStress, type SwapResult, type SwitchResult } from "../p0/playbackBench";

const SECONDS = 60;
const LOOP: [number, number] = [5 * SAMPLE_RATE, 15 * SAMPLE_RATE];
const MODE_LABEL: Record<ModeValue, string> = { [Mode.BEFORE]: "Before", [Mode.AFTER]: "After", [Mode.DELTA]: "Delta" };

function rms(x: Float32Array) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

// P0-2: A/B playback check (detailed design 12, 22).
export function PlaybackTest() {
  const signals = useMemo(() => {
    const frames = SECONDS * SAMPLE_RATE;
    return { before: renderTestSignal(frames, SAMPLE_RATE, beforeSample), after: renderTestSignal(frames, SAMPLE_RATE, afterSample) };
  }, []);
  const matchGain = useMemo(() => rms(signals.after.left) / rms(signals.before.left), [signals]);
  const player = useMemo(() => new Player(signals.before, signals.after), [signals]);

  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<ModeValue>(Mode.AFTER);
  const [loop, setLoop] = useState(false);
  const [mono, setMono] = useState(false);
  const [match, setMatch] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [switchResult, setSwitchResult] = useState<SwitchResult | null>(null);
  const [swapResult, setSwapResult] = useState<SwapResult | null>(null);
  const posRef = useRef<HTMLSpanElement>(null);

  useEffect(() => () => void player.close(), [player]);

  useEffect(() => {
    player.setGains(match ? matchGain : 1, match ? matchGain : 1);
  }, [player, match, matchGain]);

  // Playhead readout straight from shared memory, outside React state (detailed design 14.1).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (posRef.current) posRef.current.textContent = (player.position / SAMPLE_RATE).toFixed(2);
      if (player.playing !== playing) setPlaying(player.playing);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [player, playing]);

  const ensureStarted = async () => {
    if (!started) {
      await player.start();
      setStarted(true);
    }
  };
  const togglePlay = async () => {
    await ensureStarted();
    if (player.playing) player.pause();
    else player.play();
    setPlaying(player.playing);
  };
  const chooseMode = (m: ModeValue) => {
    player.setMode(m);
    setMode(m);
  };
  const toggleLoop = () => {
    player.setLoop(loop ? null : LOOP);
    if (!loop) player.seek(LOOP[0]);
    setLoop(!loop);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || (e.target as HTMLElement).tagName === "INPUT") return;
      if (e.code === "Space") {
        e.preventDefault();
        void togglePlay();
      } else if (e.key === "1") chooseMode(Mode.BEFORE);
      else if (e.key === "2") chooseMode(Mode.AFTER);
      else if (e.key === "3") chooseMode(Mode.DELTA);
      else if (e.key === "t" || e.key === "`") chooseMode(player.mode === Mode.AFTER ? Mode.BEFORE : Mode.AFTER);
      else if (e.key === "l") toggleLoop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const runSwitch = async () => {
    await ensureStarted();
    player.play();
    setBusy("切り替え計測 0/50");
    const r = await measureSwitching(player, 50, (i) => setBusy(`切り替え計測 ${i}/50`));
    setMode(Mode.AFTER);
    setSwitchResult(r);
    setBusy(null);
  };
  const runSwap = async () => {
    await ensureStarted();
    player.play();
    setBusy("差し替えテスト 0/1000");
    const r = await swapStress(player, signals.after, 1000, 5, (i) => i % 50 === 0 && setBusy(`差し替えテスト ${i}/1000`));
    setMode(Mode.AFTER);
    setSwapResult(r);
    setBusy(null);
  };

  const sw = switchResult;
  const clickRatio = sw && sw.maxStepSteady > 0 ? sw.maxStepSwitch / sw.maxStepSteady : null;

  return (
    <section className="playback">
      <h2>P0-2 再生テスト（A/B 同期再生）</h2>
      <p className="sub">テスト信号 {SECONDS} 秒：Before＝2音のトーン、After＝音量を上げて歪ませたもの。ショートカット：Space 再生／1・2・3 モード／T 切り替え／L ループ</p>
      <div className="controls">
        <button onClick={togglePlay} disabled={!!busy}>
          {playing ? "停止" : "再生"}
        </button>
        <span className="segmented" role="radiogroup" aria-label="再生モード">
          {([Mode.BEFORE, Mode.AFTER, Mode.DELTA] as ModeValue[]).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => chooseMode(m)} disabled={!!busy}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </span>
        <label>
          <input type="checkbox" checked={loop} onChange={toggleLoop} disabled={!!busy} /> ループ（5〜15 秒）
        </label>
        <label>
          <input type="checkbox" checked={match} onChange={() => setMatch(!match)} /> 音量合わせ
        </label>
        <label>
          <input
            type="checkbox"
            checked={mono}
            onChange={() => {
              player.setMono(!mono);
              setMono(!mono);
            }}
          />{" "}
          モノラル
        </label>
        <span className="pos">
          <span ref={posRef}>0.00</span> / {SECONDS}.00 秒
        </span>
      </div>
      <div className="controls">
        <button onClick={runSwitch} disabled={!!busy}>
          ① 切り替え計測（50 回）
        </button>
        <button onClick={runSwap} disabled={!!busy}>
          ② 差し替えテスト（1000 回）
        </button>
        {busy && <span className="busy">{busy}…</span>}
      </div>

      {sw && (
        <table>
          <caption>① 切り替え計測</caption>
          <tbody>
            <Row label="Worklet が切り替えを始めるまで" value={`中央値 ${sw.applyP50.toFixed(1)} ms ／ 95% ${sw.applyP95.toFixed(1)} ms ／ 最大 ${sw.applyMax.toFixed(1)} ms`} />
            <Row label="ブラウザの出力遅延" value={`base ${fmt(sw.baseLatencyMs)} ／ output ${fmt(sw.outputLatencyMs)}`} />
            <Row
              label="聞こえ方が変わるまで（最悪値）"
              value={sw.worstAudibleMs === null ? "算出できません" : `${sw.worstAudibleMs.toFixed(1)} ms（目標 60 ms 以内）`}
              status={sw.worstAudibleMs === null ? "warn" : sw.worstAudibleMs <= 60 ? "ok" : "error"}
            />
            <Row
              label="切り替え時の段差（クリック）"
              value={`切り替え中 ${sw.maxStepSwitch.toFixed(4)} ／ 通常時 ${sw.maxStepSteady.toFixed(4)}（比 ${clickRatio?.toFixed(2) ?? "-"}、基準 1.1 以下）`}
              status={clickRatio !== null && clickRatio <= 1.1 ? "ok" : "error"}
            />
          </tbody>
        </table>
      )}
      {swapResult && (
        <table>
          <caption>② 差し替えテスト</caption>
          <tbody>
            <Row label="差し替え回数" value={`${swapResult.swapped} 回（${swapResult.seconds.toFixed(1)} 秒間、予備スロット待ち ${swapResult.waitedForSpare} 回）`} />
            <Row
              label="照合したサンプル"
              value={`${swapResult.verifiedFrames.toLocaleString()} フレーム中、不一致 ${swapResult.verifyErrors}`}
              status={swapResult.verifyErrors === 0 && swapResult.verifiedFrames > 0 ? "ok" : "error"}
            />
            <Row label="スロット参照エラー" value={String(swapResult.slotErrors)} status={swapResult.slotErrors === 0 ? "ok" : "error"} />
          </tbody>
        </table>
      )}
    </section>
  );
}

const fmt = (ms: number | null) => (ms === null ? "取得不可" : `${ms.toFixed(1)} ms`);

function Row({ label, value, status }: { label: string; value: string; status?: "ok" | "warn" | "error" }) {
  return (
    <tr className={status ?? ""}>
      <td className="icon">{status ? { ok: "✓", warn: "!", error: "✗" }[status] : ""}</td>
      <th scope="row">{label}</th>
      <td>{value}</td>
    </tr>
  );
}
