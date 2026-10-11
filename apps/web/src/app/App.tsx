import { useEffect, useState } from "react";
import { MasteringApp } from "./MasteringApp";
import { P0Page } from "./P0Page";

// `#p0` shows the P0 verification page; everything else is the app.
export function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash === "#p0" ? <P0Page /> : <MasteringApp />;
}
