// Google Analytics (GA4) bootstrap.
//
// profiletool reports to the shared CharData GA4 property (G-WJN2XTVMG8) — it
// lives on the same hostname (chardata.colourbill.com/profiletool/), so it
// rides the same web data stream; profiletool views show up under the
// /profiletool/ page path.
//
// The gtag/js loader is the external <script async> in index.html (allow-listed
// in the CSP script-src). The init below lives in bundled app JS — NOT an inline
// <script> — specifically so we don't have to add 'unsafe-inline' to the CSP
// script-src and weaken XSS protection. See the CSP note in index.html.
//
// NOTE: never pass file names or profile content into gtag events. This is the
// one outbound channel profiletool has; keep it carrying nothing but anonymous
// usage.
//
// page_location is pinned to origin+pathname only — the query string and URL
// fragment are deliberately stripped. Since v1.1.5 a profile can be launched via
// `#url=<profile URL>` (App.jsx); gtag's default page_view sends
// document.location.href verbatim, which would ship that fragment — including
// any private path or signed-URL token in it — to Google. Stripping it here is
// the fix. Keep this override if you ever re-enable automatic page_view.
const MEASUREMENT_ID = 'G-WJN2XTVMG8'

export function initAnalytics() {
  window.dataLayer = window.dataLayer || []
  function gtag() { window.dataLayer.push(arguments) }
  window.gtag = gtag
  gtag('js', new Date())
  gtag('config', MEASUREMENT_ID, {
    // Strip ?query and #fragment so the `#url=` launch target never reaches GA.
    page_location: window.location.origin + window.location.pathname,
  })
}
