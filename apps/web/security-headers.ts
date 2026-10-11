// Response headers for the local server (detailed design 20.2).
// COOP/COEP make the page cross-origin isolated so SharedArrayBuffer is available.

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const csp = (extra: { script?: string; connect?: string } = {}) =>
  [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${extra.script ?? ""}`,
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${extra.connect ?? ""}`,
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

/** `npm start` (vite preview): no outbound connections allowed (NFR-09). */
export const securityHeaders = { ...isolation, "Content-Security-Policy": csp() };

/** `npm run dev`: Vite's HMR needs an inline preamble script and a websocket. */
export const devSecurityHeaders = {
  ...isolation,
  "Content-Security-Policy": csp({ script: " 'unsafe-inline'", connect: " ws://localhost:5173" }),
};
