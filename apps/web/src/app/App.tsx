import { useEffect, useState } from "react";
import { AlbumApp } from "./AlbumApp";
import { MasteringApp } from "./MasteringApp";
import { P0Page } from "./P0Page";
import "./App.css";

type Tab = "single" | "album";

const LOCK = "akmaster-session";
const TAB_KEY = "akmaster.tab";

function readTab(): string | null {
  try {
    return localStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
}

/**
 * Only one browser tab may work on the saved session at a time (detailed design 13.4); a second
 * tab shows a notice and can take over, which hands the other tab the same notice.
 */
function useSessionLock(): { owned: boolean | null; takeOver: () => void } {
  const [owned, setOwned] = useState<boolean | null>(null);
  const hold = (steal: boolean) =>
    navigator.locks
      .request(LOCK, steal ? { steal: true } : { ifAvailable: true }, (lock) => {
        if (!lock) {
          setOwned(false);
          return;
        }
        setOwned(true);
        return new Promise<void>(() => {}); // keep the lock while this tab is open
      })
      .catch(() => setOwned(false)); // stolen by another tab
  useEffect(() => {
    if (!navigator.locks) {
      setOwned(true);
      return;
    }
    void hold(false);
  }, []);
  return { owned, takeOver: () => void hold(true) };
}

// `#p0` shows the P0 verification page. Both screens stay mounted so switching tabs keeps their state.
export function App() {
  const lock = useSessionLock();
  const [hash, setHash] = useState(location.hash);
  const [tab, setTabState] = useState<Tab>(() => (location.hash === "#album" || readTab() === "album" ? "album" : "single"));
  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t); // per-viewer convenience: reopen on the same tab
    } catch {
      // storage unavailable: fine
    }
  };
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  if (hash === "#p0") return <P0Page />;
  if (lock.owned === null) return null;
  if (!lock.owned) {
    return (
      <section className="empty">
        <p>akanaku mastering は別のタブで開かれています。</p>
        <p className="sub">保存した作業が混ざらないよう、同時に使えるのは 1 つのタブだけです（E-LK-001）。</p>
        <button
          onClick={() => {
            lock.takeOver();
            location.reload();
          }}
        >
          このタブで使う（もう一方のタブは止まります）
        </button>
      </section>
    );
  }
  return (
    <>
      <nav className="tabs" role="tablist">
        {(
          [
            ["single", "シングル"],
            ["album", "アルバム"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      <div hidden={tab !== "single"}>
        <MasteringApp active={tab === "single"} />
      </div>
      <div hidden={tab !== "album"}>
        <AlbumApp active={tab === "album"} />
      </div>
    </>
  );
}
