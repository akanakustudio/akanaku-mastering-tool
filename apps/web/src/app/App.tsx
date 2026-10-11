import { useEffect, useState } from "react";
import { AlbumApp } from "./AlbumApp";
import { MasteringApp } from "./MasteringApp";
import { P0Page } from "./P0Page";
import "./App.css";

type Tab = "single" | "album";

// `#p0` shows the P0 verification page. Both screens stay mounted so switching tabs keeps their state.
export function App() {
  const [hash, setHash] = useState(location.hash);
  const [tab, setTab] = useState<Tab>(location.hash === "#album" ? "album" : "single");
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  if (hash === "#p0") return <P0Page />;
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
