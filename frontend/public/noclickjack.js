// Anti-clickjacking guard. Loaded synchronously from <head> in index.html.
//
// Why a file (not inline): the page CSP omits 'unsafe-inline' from script-src
// (the deliberate inline-script ban), so an inline block would be refused. A
// same-origin classic script satisfies script-src 'self'. It lives in public/
// so Vite copies it verbatim — no bundling/minify — and a plain <script src>
// (not type=module) runs render-blocking, before the body is parsed/painted.
//
// index.html hides <html> by default via  <style>html{display:none}</style>.
// This script reveals it only when we are the top-level window; if we are
// framed it tries to bust out, and if that is neutralized (sandboxed iframe)
// the page simply stays hidden — fail closed, so the clickjack target is never
// visible. The legit chardata → profiletool handoff is a window.open popup
// (self === top), so this never interferes with it.
(function () {
  try {
    if (self === top) {
      var s = document.getElementById('_noclickjack');
      if (s && s.parentNode) s.parentNode.removeChild(s);
    } else {
      top.location = self.location;
    }
  } catch (e) {
    /* Cross-origin top access threw → framed by a hostile parent; leave the
       page hidden (the default <style> stays in place). Fail closed. */
  }
})();
