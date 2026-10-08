// CloudeIDE marketing site — no framework, no build step.
//
// The app lives at /app on this same domain (cloudeide.com/app), so Sign In
// and Get Started are plain root-relative links in the HTML — no runtime
// rewriting needed.

// Mobile nav toggle.
const navToggle = document.getElementById("navToggle");
const mobileMenu = document.getElementById("mobileMenu");

if (navToggle && mobileMenu) {
  navToggle.addEventListener("click", () => {
    const isOpen = !mobileMenu.hidden;
    mobileMenu.hidden = isOpen;
    navToggle.setAttribute("aria-expanded", String(!isOpen));
  });

  mobileMenu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      mobileMenu.hidden = true;
      navToggle.setAttribute("aria-expanded", "false");
    });
  });
}

// Reveal-on-scroll for elements marked .reveal — a plain opacity/translate
// fade, not a "flashy effect": disabled entirely under reduced-motion via CSS.
const revealTargets = document.querySelectorAll(".reveal");

// The guard in <head> waits for this before leaving anything hidden.
window.__revealReady = true;

if ("IntersectionObserver" in window && revealTargets.length) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12 },
  );
  revealTargets.forEach((el) => observer.observe(el));
} else {
  revealTargets.forEach((el) => el.classList.add("is-visible"));
}

// Footer year.
const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = String(new Date().getFullYear());

// Copy buttons on the CLI commands.
//
// The text comes from data-copy rather than from the element's text content,
// so the `$` prompt shown on screen is never part of what lands on the
// clipboard — a pasted prompt character is a broken command.
//
// navigator.clipboard needs a secure context and can still be refused by the
// browser, so a failure says so instead of showing a success that did not
// happen. The label restores itself either way.
document.querySelectorAll(".cli-copy").forEach((button) => {
  button.addEventListener("click", async () => {
    const text = button.getAttribute("data-copy");
    if (!text) return;

    const restore = (label, copied) => {
      button.textContent = label;
      button.classList.toggle("is-copied", copied);
      window.setTimeout(() => {
        button.textContent = "Copy";
        button.classList.remove("is-copied");
      }, 1600);
    };

    try {
      await navigator.clipboard.writeText(text);
      restore("Copied", true);
    } catch {
      restore("Press \u2318C", false);
    }
  });
});

/*
 * The films play when they reach the screen, and not before.
 *
 * They used to carry `autoplay`, which starts two multi-megabyte downloads the
 * moment the markup is parsed — ahead of this very file, which is loaded at the
 * end of the body. On a phone connection that is enough to hold the script up
 * long enough for the page to sit there with every section still invisible,
 * which is exactly what it did. Now nothing is fetched until a film is in view,
 * and the second one costs nothing to anyone who never scrolls to it.
 */
// The hero film still runs full-bleed in `.filmstrip`; the two product films
// moved into `.window` frames inside the showcases. Both play the same way.
const films = document.querySelectorAll(".filmstrip video, .window video");
const stillFilms = window.matchMedia("(prefers-reduced-motion: reduce)");

if (films.length) {
  /*
   * The wide poster, where the wide film plays.
   *
   * `poster` takes one value, but the two cuts of a film are not the same
   * picture: the wide one is the whole workbench and the narrow one is the
   * panel alone, cropped from the right of it. A poster from the wrong cut is
   * not a smaller version of the film, it is a different shot stretched into
   * a box it was never framed for. Same 760px line the <source> elements use,
   * and kept in step afterwards, because that line is crossed by turning a
   * phone sideways as well as by loading the page.
   */
  const wideFilms = window.matchMedia("(min-width: 760px)");
  const applyPosters = () => {
    films.forEach((film) => {
      const wide = film.dataset.posterWide;
      if (!wide) return;
      film.dataset.posterNarrow = film.dataset.posterNarrow || film.getAttribute("poster");
      film.setAttribute("poster", wideFilms.matches ? wide : film.dataset.posterNarrow);
    });
  };
  applyPosters();
  wideFilms.addEventListener("change", applyPosters);

  /*
   * Starting a film is not one call, because there are three separate reasons
   * a browser refuses one.
   *
   *  - `muted` is set as a property as well as an attribute. Some mobile
   *    browsers read the property when deciding whether a scripted play() is
   *    allowed without a gesture, and an attribute alone does not set it.
   *  - Data Saver, Low Power Mode and similar refuse the first attempt
   *    outright. They stop refusing after the person touches the page, so a
   *    rejection arms a one-shot retry on the next interaction rather than
   *    giving up.
   *  - Nothing here can make a film appear if it never plays, which is why
   *    each one carries a `poster`: a still of the film is what a viewer sees
   *    in every case above, instead of the empty box they saw before.
   */
  let waitingForGesture = false;
  const GESTURES = ["pointerdown", "touchstart", "keydown", "scroll"];

  const retryOnGesture = () => {
    if (waitingForGesture) return;
    waitingForGesture = true;
    const go = () => {
      GESTURES.forEach((g) => window.removeEventListener(g, go));
      waitingForGesture = false;
      films.forEach((film) => {
        if (isOnScreen(film)) start(film);
      });
    };
    GESTURES.forEach((g) => window.addEventListener(g, go, { once: true, passive: true }));
  };

  const isOnScreen = (film) => {
    const r = film.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  };

  const start = (film) => {
    if (stillFilms.matches) return;
    film.muted = true;
    const attempt = film.play();
    if (attempt && typeof attempt.catch === "function") attempt.catch(retryOnGesture);
  };

  const playWhenSeen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) start(entry.target);
        else entry.target.pause();
      }
    },
    { threshold: 0.2 },
  );
  films.forEach((film) => playWhenSeen.observe(film));

  // Someone who turns the preference on mid-visit should get stillness now,
  // not on their next page load.
  stillFilms.addEventListener("change", () => {
    films.forEach((film) => {
      if (stillFilms.matches) film.pause();
      else if (isOnScreen(film)) start(film);
    });
  });
}

/*
 * Phones and tablets. CloudeIDE is a desktop app, so a phone is shown the
 * Mac button (the most common desktop) and, on a tap, told to open the page
 * on a computer instead of silently downloading a file it cannot open.
 *
 * "Desktop site" mode on Android reports a Linux PC with no "Android" in the
 * user agent, and an iPad reports a Mac; the ARM platform string and touch
 * points give both away.
 */
const onPhone = (() => {
  const ua = navigator.userAgent;
  // Both, because in desktop mode one can still say Android and the other ARM.
  const platform = [navigator.userAgentData?.platform, navigator.platform].filter(Boolean).join(" ");
  if (navigator.userAgentData?.mobile) return true;
  if (/android|ios/i.test(platform)) return true;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  if (/linux/i.test(platform) && /arm|aarch/i.test(platform)) return true;
  if (/Linux/i.test(ua) && !/CrOS/i.test(ua) && navigator.maxTouchPoints > 1) return true;
  if (/mac/i.test(platform) && navigator.maxTouchPoints > 1) return true;
  return false;
})();

/* --------------------------------------------------------------- download --
 *
 * The button is whichever platform the visitor is on; the other two become
 * links beside it, and only that platform's note is shown.
 *
 * The markup already holds all three, all working. This only reorders and
 * hides — so a visitor with no JavaScript, or one this guesses wrong about,
 * still has every download a click away. That is why nothing here removes an
 * element from the page.
 *
 * Apple Silicon is not detected, because it cannot be: Safari and Chrome both
 * report "MacIntel" on an M-series Mac. The Mac note says which build it is
 * instead of this pretending to know.
 */
// Every download row, not the first. There are two now — one in the section
// that explains the install and one at the end of the page — and a visitor
// who reached the second is the one most likely to use it.
for (const row of document.querySelectorAll("[data-download]")) {
  const ua = navigator.userAgent;
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? "";
  const here = onPhone || /mac/i.test(platform) || /Mac OS X/i.test(ua)
    ? "mac"
    : /win/i.test(platform) || /Windows/i.test(ua)
      ? "windows"
      : /linux|android|cros/i.test(platform) || /Linux|Android|CrOS/i.test(ua)
        ? "linux"
        : null;

  const buttons = row ? [...row.querySelectorAll("[data-os]")] : [];
  const mine = here ? buttons.find((b) => b.dataset.os === here) : undefined;

  // Only when there is a button for this platform. Without that guard, a
  // platform whose build is not published yet — or has been pulled — promotes
  // nothing and hides every note, leaving a download row with no note under
  // it at all.
  if (mine) {
    buttons.forEach((b) => {
      const isMine = b === mine;
      b.classList.toggle("btn-primary", isMine);
      b.classList.toggle("btn-secondary", !isMine);
      b.classList.toggle("download-other", !isMine);
      // "Windows", not "Download for Windows". Demoted, the verb is carried
      // by the button beside it, and three long labels wrap onto a second
      // line for no reason. The long one stays in the markup so that without
      // this the row still reads as a sentence.
      if (!isMine && b.dataset.osShort) {
        b.textContent = b.dataset.osShort;
      }
    });

    // First in the row, so the button a visitor wants is the one their eye
    // lands on rather than the one that happened to be authored first.
    row.prepend(mine);

    // Notes belong to the row they sit with; the closing row has none.
    const section = row.closest("section") ?? document;
    section.querySelectorAll("[data-note]").forEach((note) => {
      note.hidden = note.dataset.note !== here;
    });
  }
}

/*
 * The hero's one button names the visitor's own platform.
 *
 * It says macOS in the markup, which is what a visitor with no script, or
 * on a platform with no build, gets. Windows and Linux visitors get their
 * own file instead of a Mac download they cannot open.
 */
(function () {
  const links = document.querySelectorAll("[data-hero-download]");
  if (!links.length) return;
  const ua = navigator.userAgent;
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? "";
  const base = "https://github.com/Cloudeide/cloudeide-desktop/releases/latest/download/";
  let file = "";
  let name = "";
  if (!onPhone && !/mac/i.test(platform) && !/Mac OS X/i.test(ua)) {
    if (/win/i.test(platform) || /Windows/i.test(ua)) {
      file = "CloudeIDE-win32-x64-setup.exe";
      name = "Windows";
    } else if ((/linux|cros/i.test(platform) || /Linux|CrOS/i.test(ua)) && !/Android/i.test(ua)) {
      file = "CloudeIDE-linux-x64.deb";
      name = "Linux";
    }
  }
  if (!file) return;
  links.forEach((link) => {
    link.href = base + file;
    // Only the button that names a platform is renamed; "Try it on your
    // project" is right for everyone.
    if (/^Download for /.test(link.textContent)) link.textContent = "Download for " + name;
  });
})();

/* The hero demo: the agent adds dark mode. */

(() => {
  const root = document.getElementById("hx");
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const LOOP = 18;
  const TASK = "Add dark mode to the settings page, and remember the choice.";

  // Each file: its lines, and when each line becomes an addition. A line
  // listed in `adds` appears at that second, typed into place.
  const CSS = [
    [0, '<span class="p">:root</span> {'],
    [0, '  <span class="p">--bg</span>: <span class="nu">#ffffff</span>;'],
    [0, '  <span class="p">--text</span>: <span class="nu">#16181d</span>;'],
    [0, '  <span class="p">--accent</span>: <span class="nu">#3b5bdb</span>;'],
    [0, '}'],
    [4.5, ''],
    [4.6, '<span class="p">[data-theme="dark"]</span> {'],
    [4.8, '  <span class="p">--bg</span>: <span class="nu">#121316</span>;'],
    [5.0, '  <span class="p">--text</span>: <span class="nu">#e8e9ec</span>;'],
    [5.2, '  <span class="p">--accent</span>: <span class="nu">#7b93ff</span>;'],
    [5.3, '}'],
    [0, ''],
    [0, '<span class="p">body</span> {'],
    [0, '  <span class="p">background</span>: <span class="f">var</span>(<span class="p">--bg</span>);'],
    ['d5.6', '  <span class="p">color</span>: <span class="nu">#16181d</span>;'],
    [5.6, '  <span class="p">color</span>: <span class="f">var</span>(<span class="p">--text</span>);'],
    [5.8, '  <span class="p">transition</span>: background <span class="nu">0.2s</span>;'],
    [0, '}'],
    [0, ''],
    [0, '<span class="p">.card</span> {'],
    [0, '  <span class="p">border-radius</span>: <span class="nu">12px</span>;'],
    [0, '  <span class="p">padding</span>: <span class="nu">20px</span>;'],
    [0, '}'],
  ];
  const TSX = [
    [0, '<span class="k">import</span> { Page, Row, Switch } <span class="k">from</span> <span class="s">"../ui"</span>;'],
    [7.2, '<span class="k">import</span> { useTheme } <span class="k">from</span> <span class="s">"../hooks/useTheme"</span>;'],
    [0, ''],
    [0, '<span class="k">export function</span> <span class="f">Settings</span>({ prefs }) {'],
    [7.5, '  <span class="k">const</span> { theme, setTheme } = <span class="f">useTheme</span>();'],
    [0, '  <span class="k">return</span> ('],
    [0, '    &lt;<span class="t">Page</span> title=<span class="s">"Settings"</span>&gt;'],
    [7.8, '      &lt;<span class="t">Row</span> label=<span class="s">"Dark mode"</span>&gt;'],
    [8.0, '        &lt;<span class="t">Switch</span> checked={theme === <span class="s">"dark"</span>}'],
    [8.2, '          onChange={(on) =&gt; <span class="f">setTheme</span>(on ? <span class="s">"dark"</span> : <span class="s">"light"</span>)} /&gt;'],
    [8.4, '      &lt;/<span class="t">Row</span>&gt;'],
    [0, '      &lt;<span class="t">Row</span> label=<span class="s">"Email notifications"</span>&gt;'],
    [0, '        &lt;<span class="t">Switch</span> checked={prefs.email} /&gt;'],
    [0, '      &lt;/<span class="t">Row</span>&gt;'],
    [0, '    &lt;/<span class="t">Page</span>&gt;'],
    [0, '  );'],
    [0, '}'],
  ];
  const TERM = [
    [9.2, '<span class="dim">~/acme-app $</span> <span class="w">npm test</span>'],
    [9.8, ' <span class="ok">PASS</span>  src/hooks/useTheme.test.ts'],
    [10.2, ' <span class="ok">PASS</span>  src/pages/Settings.test.tsx'],
    [10.6, ' <span class="w">Tests:</span>  <span class="ok">24 passed</span>, 24 total'],
    [11.0, '<span class="ok">✓</span> No problems in 3 changed files'],
  ];

  const timed = [...root.querySelectorAll("[data-at]")];
  const spins = [...root.querySelectorAll("[data-spin]")].map((el) => [el, ...el.dataset.spin.split(":").map(Number)]);
  const chat = $("hx-chat"), scroll = $("hx-scroll"), code = $("hx-code");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let t = 0, last = 0, running = false, shownFile = "", shownCount = -1;

  function renderFile(lines, key) {
    // Which lines exist at this moment, and which of them are marked.
    const visible = [];
    let n = 0;
    for (const [at, html] of lines) {
      const removed = typeof at === "string";
      const when = removed ? +at.slice(1) : at;
      if (!removed && at > 0 && t < at) { continue; }
      const kind = removed ? (t >= when ? "del" : "") : (at > 0 ? "add" : "");
      visible.push([kind, html, !removed && at > 0 && t - at < 0.25]);
    }
    const sig = key + visible.map((v) => v[0]).join("");
    if (sig === shownFile + shownCount) { return; }
    shownFile = key; shownCount = visible.map((v) => v[0]).join("");
    code.innerHTML = visible.map(([kind, html, fresh]) => {
      const num = kind === "del" ? "" : ++n;
      return `<div class="hx-ln ${kind}${fresh ? " new" : ""}"><b>${num}</b><span>${html || " "}</span></div>`;
    }).join("");
  }

  function render() {
    const typed = Math.max(0, Math.min(TASK.length, Math.round(((t - 0.2) / 1.1) * TASK.length)));
    $("hx-typed").textContent = TASK.slice(0, typed);
    $("hx-caret").classList.toggle("hx-gone", t > 1.35);

    timed.forEach((el) => {
      const on = t >= +el.dataset.at;
      if (chat.contains(el)) { el.classList.toggle("hx-gone", !on); }
      else { el.classList.toggle("hx-off", !on); }
    });
    spins.forEach(([el, a, b]) => { el.className = "hx-ico " + (t >= b ? "ok" : t >= a ? "spin" : ""); });

    const onTsx = t >= 7.1;
    $("hx-tab-css").classList.toggle("on", !onTsx);
    $("hx-tab-tsx").classList.toggle("on", onTsx);
    $("hx-m-css").classList.toggle("hx-gone", t < 4.5);
    $("hx-m-tsx").classList.toggle("hx-gone", t < 7.2);
    $("hx-crumb").textContent = onTsx ? "src › pages › Settings.tsx" : "src › styles › theme.css";
    renderFile(onTsx ? TSX : CSS, onTsx ? "tsx" : "css");

    $("hx-term").innerHTML = TERM.filter(([s]) => t >= s).map(([, l]) => `<div>${l}</div>`).join("");

    const done = t >= 11.4;
    $("hx-sesico").className = "hx-ico " + (done ? "ok" : "spin");
    $("hx-sessub").innerHTML = done ? '<span class="hx-add">+47</span> <span class="hx-del">−1</span> · Ready for review'
      : t >= 9.0 ? "Running the tests…" : t >= 4.0 ? "Editing 3 files…" : t >= 3.3 ? "Planning…" : "Reading the project…";
    $("hx-seswhen").textContent = done ? "now" : "";

    const over = chat.scrollHeight - scroll.clientHeight;
    chat.style.transform = `translateY(${-Math.max(0, over)}px)`;
  }

  function frame(now) {
    if (!running) { return; }
    t += Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
    if (t > LOOP) { t = 0; }
    render();
    requestAnimationFrame(frame);
  }

  // At rest, and for anyone who asked for less motion: the finished change.
  t = 12.5; render();
  if (still) { return; }
  const go = () => { if (running) { return; } running = true; t = 0; last = performance.now(); requestAnimationFrame(frame); };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { go(); } else { running = false; } }), { threshold: 0.2 }).observe(root);
  } else { go(); }
})();

/* The plan demo: the agent asks, plans, and ticks the plan off. */

(() => {
  const root = document.getElementById("pl");
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const LOOP = 18.5, REST = 13.8;
  const TASK = "Let customers download their invoices as PDFs.";

  // Each file: [when the line appears (0 = already there), html].
  const PDF = [
    [7.1, '<span class="k">import</span> PDFDocument <span class="k">from</span> <span class="s">"pdfkit"</span>;'],
    [7.2, '<span class="k">import</span> { money } <span class="k">from</span> <span class="s">"../lib/format"</span>;'],
    [7.25, ''],
    [7.3, '<span class="k">export function</span> <span class="f">renderInvoicePdf</span>(invoice) {'],
    [7.45, '  <span class="k">const</span> doc = <span class="k">new</span> <span class="f">PDFDocument</span>({ margin: <span class="nu">48</span> });'],
    [7.6, '  doc.<span class="f">fontSize</span>(<span class="nu">20</span>).<span class="f">text</span>(<span class="s">`Invoice ${invoice.number}`</span>);'],
    [7.7, '  doc.<span class="f">fontSize</span>(<span class="nu">11</span>).<span class="f">text</span>(invoice.customer.name);'],
    [7.8, '  <span class="k">for</span> (<span class="k">const</span> line <span class="k">of</span> invoice.lines) {'],
    [7.9, '    doc.<span class="f">text</span>(<span class="s">`${line.name}  ${</span><span class="f">money</span>(line.amount)<span class="s">}`</span>);'],
    [8.0, '  }'],
    [8.05, '  doc.<span class="f">text</span>(<span class="s">`Total  ${</span><span class="f">money</span>(invoice.total)<span class="s">}`</span>);'],
    [8.15, '  doc.<span class="f">end</span>();'],
    [8.2, '  <span class="k">return</span> doc;'],
    [8.25, '}'],
  ];
  const ROUTE = [
    [0, '<span class="k">import</span> { Router } <span class="k">from</span> <span class="s">"express"</span>;'],
    [0, '<span class="k">import</span> { requireUser } <span class="k">from</span> <span class="s">"../auth"</span>;'],
    [8.5, '<span class="k">import</span> { renderInvoicePdf } <span class="k">from</span> <span class="s">"../billing/pdf"</span>;'],
    [0, '<span class="k">import</span> { findInvoice, listInvoices } <span class="k">from</span> <span class="s">"../billing/invoices"</span>;'],
    [0, ''],
    [0, '<span class="k">export const</span> invoices = <span class="f">Router</span>();'],
    [0, ''],
    [0, 'invoices.<span class="f">get</span>(<span class="s">"/invoices"</span>, requireUser, <span class="k">async</span> (req, res) =&gt; {'],
    [0, '  res.<span class="f">json</span>(<span class="k">await</span> <span class="f">listInvoices</span>(req.user.id));'],
    [0, '});'],
    [8.7, ''],
    [8.75, 'invoices.<span class="f">get</span>(<span class="s">"/invoices/:id/pdf"</span>, requireUser, <span class="k">async</span> (req, res) =&gt; {'],
    [8.9, '  <span class="k">const</span> invoice = <span class="k">await</span> <span class="f">findInvoice</span>(req.params.id);'],
    [9.05, '  <span class="c">// Only the customer the invoice belongs to can download it.</span>'],
    [9.15, '  <span class="k">if</span> (!invoice || invoice.customerId !== req.user.id) {'],
    [9.25, '    <span class="k">return</span> res.<span class="f">sendStatus</span>(<span class="nu">404</span>);'],
    [9.3, '  }'],
    [9.4, '  res.<span class="f">type</span>(<span class="s">"application/pdf"</span>);'],
    [9.5, '  <span class="f">renderInvoicePdf</span>(invoice).<span class="f">pipe</span>(res);'],
    [9.55, '});'],
  ];
  const ROW = [
    [0, '<span class="k">export function</span> <span class="f">InvoiceRow</span>({ invoice }) {'],
    [0, '  <span class="k">return</span> ('],
    [0, '    &lt;<span class="t">Row</span>&gt;'],
    [0, '      &lt;<span class="t">Cell</span>&gt;{invoice.number}&lt;/<span class="t">Cell</span>&gt;'],
    [0, '      &lt;<span class="t">Cell</span>&gt;{<span class="f">money</span>(invoice.total)}&lt;/<span class="t">Cell</span>&gt;'],
    [0, '      &lt;<span class="t">Status</span> value={invoice.status} /&gt;'],
    [10.1, '      &lt;<span class="t">a</span> href={<span class="s">`/invoices/${invoice.id}/pdf`</span>} download&gt;'],
    [10.3, '        Download PDF'],
    [10.45, '      &lt;/<span class="t">a</span>&gt;'],
    [0, '    &lt;/<span class="t">Row</span>&gt;'],
    [0, '  );'],
    [0, '}'],
  ];
  const TEST = [
    [11.1, '<span class="f">describe</span>(<span class="s">"GET /invoices/:id/pdf"</span>, () =&gt; {'],
    [11.2, '  <span class="f">it</span>(<span class="s">"sends the PDF to the invoice owner"</span>, <span class="k">async</span> () =&gt; {'],
    [11.3, '    <span class="k">const</span> res = <span class="k">await</span> <span class="f">as</span>(ana).<span class="f">get</span>(<span class="s">"/invoices/inv_104/pdf"</span>);'],
    [11.4, '    <span class="f">expect</span>(res.status).<span class="f">toBe</span>(<span class="nu">200</span>);'],
    [11.5, '    <span class="f">expect</span>(res.type).<span class="f">toBe</span>(<span class="s">"application/pdf"</span>);'],
    [11.55, '  });'],
    [11.6, ''],
    [11.65, '  <span class="f">it</span>(<span class="s">"refuses anyone else"</span>, <span class="k">async</span> () =&gt; {'],
    [11.8, '    <span class="k">const</span> res = <span class="k">await</span> <span class="f">as</span>(ben).<span class="f">get</span>(<span class="s">"/invoices/inv_104/pdf"</span>);'],
    [11.9, '    <span class="f">expect</span>(res.status).<span class="f">toBe</span>(<span class="nu">404</span>);'],
    [11.95, '  });'],
    [12.0, '});'],
  ];
  // Which file is open when, and when each tab first appears.
  const FILES = [
    { key: "route", name: "invoices.ts", icon: "TS", path: "src › routes › invoices.ts", lines: ROUTE, open: 0, tab: 0, badge: 8.5, mark: "M" },
    { key: "pdf", name: "pdf.ts", icon: "TS", path: "src › billing › pdf.ts", lines: PDF, open: 7.0, tab: 7.0, badge: 7.0, mark: "U" },
    { key: "row", name: "InvoiceRow.tsx", icon: "TS", path: "src › pages › InvoiceRow.tsx", lines: ROW, open: 9.8, tab: 9.8, badge: 10.1, mark: "M" },
    { key: "test", name: "pdf.test.ts", icon: "TS", path: "src › routes › pdf.test.ts", lines: TEST, open: 11.0, tab: 11.0, badge: 11.0, mark: "U" },
  ];
  const openAt = (t) => t >= 11.0 ? "test" : t >= 9.8 ? "row" : t >= 8.4 ? "route" : t >= 7.0 ? "pdf" : "route";

  const timed = [...root.querySelectorAll("[data-at]")];
  const items = [...root.querySelectorAll("[data-run]")].map((el) => [el, ...el.dataset.run.split(":").map(Number)]);
  const chat = $("pl-chat"), scroll = $("pl-scroll"), code = $("pl-code"), ptr = $("pl-ptr");
  const o1 = $("pl-o1"), submit = $("pl-submit");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let t = 0, last = 0, running = false, shown = "";

  function renderEditor() {
    const key = openAt(t);
    const file = FILES.find((f) => f.key === key);
    const tabs = FILES.filter((f) => t >= f.tab).map((f) =>
      `<div class="hx-tab${f.key === key ? " on" : ""}"><i>${f.icon}</i>${f.name}${t >= f.badge && f.key !== "route" || (f.key === "route" && t >= f.badge) ? `<span class="${f.mark === "U" ? "u" : "m"}">${f.mark}</span>` : ""}</div>`).join("");
    const visible = file.lines.filter(([at]) => !(at > 0 && t < at));
    const sig = key + visible.length + tabs;
    if (sig === shown) { return; }
    shown = sig;
    $("pl-tabs").innerHTML = tabs;
    $("pl-crumb").textContent = file.path;
    let n = 0;
    code.innerHTML = visible.map(([at, html]) => {
      const kind = at > 0 ? "add" : "";
      const fresh = at > 0 && t - at < 0.25;
      return `<div class="hx-ln ${kind}${fresh ? " new" : ""}"><b>${++n}</b><span>${html || " "}</span></div>`;
    }).join("");
  }

  function place(el, dx, dy) {
    const s = root.getBoundingClientRect(), r = el.getBoundingClientRect();
    ptr.style.left = (r.left - s.left + dx) + "px";
    ptr.style.top = (r.top - s.top + dy) + "px";
  }

  function render() {
    const typed = Math.max(0, Math.min(TASK.length, Math.round(((t - 0.2) / 1.0) * TASK.length)));
    $("pl-typed").textContent = TASK.slice(0, typed);
    $("pl-caret").classList.toggle("hx-gone", t > 1.25);

    timed.forEach((el) => {
      const on = t >= +el.dataset.at && !(el.dataset.until && t >= +el.dataset.until);
      if (chat.contains(el)) { el.classList.toggle("hx-gone", !on); }
      else { el.classList.toggle("hx-off", !on); }
    });

    // The person answers the question.
    o1.classList.toggle("hover", t >= 4.35 && t < 5.5);
    o1.classList.toggle("pick", t >= 4.6);
    submit.classList.toggle("dim", t < 4.6);
    submit.classList.toggle("press", t >= 5.15 && t < 5.3);

    let done = 0;
    items.forEach(([el, a, b]) => {
      el.classList.toggle("doing", t >= a && t < b);
      el.classList.toggle("done", t >= b);
      if (t >= b) { done++; }
    });
    $("pl-count").textContent = `${done} of 4 done`;

    renderEditor();

    const over = chat.scrollHeight - scroll.clientHeight;
    chat.style.transform = `translateY(${-Math.max(0, over)}px)`;

    // Pointer: in from the side, onto the first answer, then Submit.
    const vis = t >= 3.8 && t < 5.6;
    ptr.style.opacity = vis ? "1" : "0";
    if (t >= 3.8 && t < 4.8) { place(o1, 14, 13); }
    else if (t >= 4.8 && t < 5.6) { place(submit, 26, 8); }
  }

  function frame(now) {
    if (!running) { return; }
    t += Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
    if (t > LOOP) { t = 0; }
    render();
    requestAnimationFrame(frame);
  }

  // At rest, and for anyone who asked for less motion: the finished plan.
  t = REST; render();
  if (still) { return; }
  const go = () => { if (running) { return; } running = true; t = 0; last = performance.now(); requestAnimationFrame(frame); };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { go(); } else { running = false; } }), { threshold: 0.2 }).observe(root);
  } else { go(); }
})();

/* The Edit Here demo: select a function, press Cmd+I, say what to change. */

(() => {
  const root = document.getElementById("ie");
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const LOOP = 13, REST = 8.4;
  const ASK = "Make this async and add a 5 second timeout";

  const BEFORE = [
    'import { api } from "./client";',
    '',
    'export function loadOrders(userId) {',
    '  return fetch(`/api/users/${userId}/orders`)',
    '    .then((res) => res.json())',
    '    .then((data) => data.orders)',
    '    .catch(() => []);',
    '}',
  ];
  const AFTER = [
    'export async function loadOrders(userId: string) {',
    '  try {',
    '    const res = await fetch(`/api/users/${userId}/orders`, {',
    '      signal: AbortSignal.timeout(5000),',
    '    });',
    '    const data = await res.json();',
    '    return data.orders;',
    '  } catch {',
    '    return [];',
    '  }',
    '}',
  ];
  const TAIL = [
    '',
    'export function cancelOrder(id: string) {',
    '  return api.post(`/orders/${id}/cancel`);',
    '}',
  ];

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  function hl(src) {
    let h = esc(src);
    h = h.replace(/(`[^`]*`|"[^"]*")/g, '<i class="s">$1</i>');
    h = h.replace(/\b(import|from|export|async|function|return|await|const|try|catch)\b(?![^<]*<\/i>)/g, '<i class="k">$1</i>');
    h = h.replace(/\b([A-Za-z_]+)(?=\()(?![^<]*<\/i>)/g, '<i class="f">$1</i>');
    h = h.replace(/\b(\d+)\b(?![^<]*<\/i>)/g, '<i class="nu">$1</i>');
    return h.replace(/<i class/g, '<em class').replace(/<\/i>/g, "</em>");
  }
  const line = (no, src, cls = "") => `<div class="hx-ln ${cls}"><b>${no}</b><span>${hl(src) || " "}</span></div>`;

  const code = $("ie-code"), ptr = $("ie-ptr"), key = $("ie-key");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let t = 0, last = 0, running = false, drawn = "";

  function at(el, fx, fy) {
    const s = root.getBoundingClientRect(), r = el.getBoundingClientRect();
    return [r.left - s.left + r.width * fx, r.top - s.top + r.height * fy];
  }

  function render() {
    const typed = Math.max(0, Math.min(ASK.length, Math.round(((t - 2.9) / 1.3) * ASK.length)));
    const box = t >= 2.6 && t < 9.2;
    const sent = t >= 4.4;
    const working = t >= 4.4 && t < 7.2;
    const decide = t >= 7.2 && t < 9.2;
    const kept = t >= 9.15;
    const sel = t >= 1.0 && t < 5.6 ? Math.min(6, Math.floor((t - 1.0) / 0.1) + 1) : 0;
    const shown = t >= 5.6 ? Math.min(AFTER.length, Math.floor((t - 5.6) / 0.13) + 1) : 0;

    const key8 = [typed, box, sent, working, decide, kept, sel, shown].join("|");
    if (key8 !== drawn) {
      drawn = key8;
      let html = line(1, BEFORE[0]) + line(2, BEFORE[1]);
      if (box) {
        const q = typed ? esc(ASK.slice(0, typed)) + (sent ? "" : '<span class="hx-caret"></span>') : '<span class="ph">Edit selected code…</span><span class="hx-caret"></span>';
        const st = working ? '<span class="st"><span class="hx-ico spin"></span>Editing 6 lines…</span>' : decide ? '<span class="st"><span class="hx-add">+11</span> <span class="hx-del">−6</span></span>' : '<span>Sonnet 5 ⌄</span>';
        const r = decide ? '<span class="r"><span class="hx-btn pri" id="ie-keep">Keep</span><span class="hx-btn">Discard</span></span>' : '<span class="r">Esc to close</span>';
        html += `<div class="ie-box"><div class="q">${q}</div><div class="m">${st}${r}</div></div>`;
      }
      let no = 3;
      if (kept) {
        AFTER.forEach((l) => { html += line(no++, l, "kept"); });
      } else {
        BEFORE.slice(2).forEach((l, i) => { html += line(shown ? "" : no++, l, shown ? "del" : i < sel ? "sel" : ""); });
        AFTER.slice(0, shown).forEach((l) => { html += line(no++, l, "add new"); });
      }
      TAIL.forEach((l) => { html += line(no++, l); });
      code.innerHTML = html;
    }

    // The key, pressed.
    const keyOn = t >= 1.9 && t < 2.9;
    key.classList.toggle("on", keyOn);
    key.classList.toggle("down", t >= 2.25 && t < 2.42);
    const first = code.children[2];
    if (keyOn && first) {
      const [x, y] = at(first, 0, 0);
      key.style.left = (x + 150) + "px"; key.style.top = (y - 64) + "px";
    }

    // The pointer: drags across the function, then presses Keep.
    const drag = t >= 0.5 && t < 1.9, press = t >= 7.9 && t < 9.4;
    ptr.style.opacity = drag || press ? "1" : "0";
    const rows = code.querySelectorAll(".hx-ln");
    if (drag && rows[2] && rows[7]) {
      const [x, y] = t < 1.0 ? at(rows[2], 0, 0.6) : at(rows[7], 0, 0.6);
      ptr.style.left = (x + (t < 1.0 ? 54 : 70)) + "px"; ptr.style.top = y + "px";
    }
    const keep = $("ie-keep");
    if (press && keep) {
      const [x, y] = at(keep, 0.5, 0.6);
      ptr.style.left = x + "px"; ptr.style.top = y + "px";
      keep.classList.toggle("press", t >= 8.9 && t < 9.05);
    }
  }

  function frame(now) {
    if (!running) { return; }
    t += Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
    if (t > LOOP) { t = 0; }
    render();
    requestAnimationFrame(frame);
  }

  // At rest, and for anyone who asked for less motion: the new code, waiting for Keep.
  t = REST; render();
  const pin = new URLSearchParams(location.search).get("t");
  if (pin) { t = +pin; render(); return; }
  if (still) { return; }
  const go = () => { if (running) { return; } running = true; t = 0; last = performance.now(); requestAnimationFrame(frame); };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { go(); } else { running = false; } }), { threshold: 0.2 }).observe(root);
  } else { go(); }
})();

/* The review demo: you keep two changes and undo the one nobody asked for. */

(() => {
  const root = document.getElementById("rv");
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const LOOP = 11.5, REST = 6.5;

  // Each file: its lines as [" " | "+" | "-", html, the change it belongs to].
  const LOGIN = [
    [" ", '<span class="k">import</span> { useState } <span class="k">from</span> <span class="s">"react"</span>;'],
    [" ", '<span class="k">import</span> { signIn } <span class="k">from</span> <span class="s">"../auth/login"</span>;'],
    [" ", ''],
    [" ", '<span class="k">export function</span> <span class="f">Login</span>() {'],
    [" ", '  <span class="k">const</span> [email, setEmail] = <span class="f">useState</span>(<span class="s">""</span>);'],
    ["+", '  <span class="k">const</span> [remember, setRemember] = <span class="f">useState</span>(<span class="k">false</span>);', "a1"],
    [" ", '  <span class="k">return</span> ('],
    [" ", '    &lt;<span class="t">Form</span>&gt;'],
    [" ", '      &lt;<span class="t">Field</span> label=<span class="s">"Email"</span> value={email} /&gt;'],
    ["+", '      &lt;<span class="t">Checkbox</span> checked={remember}', "a2"],
    ["+", '        onChange={setRemember}&gt;', "a2"],
    ["+", '        Remember me', "a2"],
    ["+", '      &lt;/<span class="t">Checkbox</span>&gt;', "a2"],
    ["-", '      &lt;<span class="t">Button</span> onClick={() =&gt; <span class="f">signIn</span>(email)}&gt;', "a2"],
    ["+", '      &lt;<span class="t">Button</span> onClick={() =&gt; <span class="f">signIn</span>(email, remember)}&gt;', "a2"],
    [" ", '        Sign in'],
    [" ", '      &lt;/<span class="t">Button</span>&gt;'],
    [" ", '    &lt;/<span class="t">Form</span>&gt;'],
    [" ", '  );'],
    [" ", '}'],
  ];
  const AUTH = [
    [" ", '<span class="k">import</span> { setCookie } <span class="k">from</span> <span class="s">"../lib/cookies"</span>;'],
    [" ", '<span class="k">import</span> { days } <span class="k">from</span> <span class="s">"../lib/time"</span>;'],
    [" ", ''],
    ["-", '<span class="k">export async function</span> <span class="f">signIn</span>(email) {', "b1"],
    ["+", '<span class="k">export async function</span> <span class="f">signIn</span>(email, remember) {', "b1"],
    [" ", '  <span class="k">const</span> user = <span class="k">await</span> <span class="f">verifyLink</span>(email);'],
    ["-", '  <span class="f">setCookie</span>(<span class="s">"sid"</span>, user.session);', "b2"],
    ["+", '  <span class="f">setCookie</span>(<span class="s">"sid"</span>, user.session, {', "b2"],
    ["+", '    <span class="c">// Ticked: 30 days. Not ticked: until the browser closes.</span>', "b2"],
    ["+", '    maxAge: remember ? <span class="f">days</span>(<span class="nu">30</span>) : <span class="k">undefined</span>,', "b2"],
    ["+", '  });', "b2"],
    [" ", '}'],
  ];
  const CONFIG = [
    [" ", '<span class="k">export const</span> config = {'],
    [" ", '  apiUrl: process.env.API_URL,'],
    ["-", '  sessionDays: <span class="nu">7</span>,', "c1"],
    ["+", '  sessionDays: <span class="nu">30</span>,', "c1"],
    [" ", '  uploadLimitMb: <span class="nu">20</span>,'],
    [" ", '  emailFrom: <span class="s">"hello@acme.com"</span>,'],
    [" ", '};'],
  ];
  const FILES = [
    { key: "login", name: "Login.tsx", icon: "TS", path: "src › pages › Login.tsx", lines: LOGIN, from: 0, to: 3.2 },
    { key: "auth", name: "login.ts", icon: "TS", path: "src › auth › login.ts", lines: AUTH, from: 3.2, to: 5.3 },
    { key: "config", name: "config.ts", icon: "TS", path: "src › config.ts", lines: CONFIG, from: 5.3, to: 99 },
  ];
  // When each change is decided, and how.
  const DECIDE = { a1: [2.0, "keep"], a2: [2.8, "keep"], b1: [4.1, "keep"], b2: [4.9, "keep"], c1: [6.9, "undo"] };
  // The pointer: [from, to, button id], and when it presses.
  const PATH = [
    [1.2, 2.3, "rv-k-a1"], [2.3, 3.1, "rv-k-a2"], [3.5, 4.4, "rv-k-b1"], [4.4, 5.3, "rv-k-b2"],
    [5.7, 6.2, "rv-k-c1"], [6.2, 7.3, "rv-u-c1"],
  ];
  const PRESS = [[1.85, 2.0, "rv-k-a1"], [2.65, 2.8, "rv-k-a2"], [3.95, 4.1, "rv-k-b1"], [4.75, 4.9, "rv-k-b2"], [6.75, 6.9, "rv-u-c1"]];
  const ALL = 6.9;

  const count = (lines) => [lines.filter(([k]) => k === "+").length, lines.filter(([k]) => k === "-").length];
  const state = (h, t) => (DECIDE[h] && t >= DECIDE[h][0]) ? DECIDE[h][1] : "open";
  const fileState = (f, t) => {
    const hs = [...new Set(f.lines.map((l) => l[2]).filter(Boolean))].map((h) => state(h, t));
    return hs.includes("open") ? "open" : hs.every((s) => s === "undo") ? "undo" : "keep";
  };

  const code = $("rv-code"), ptr = $("rv-ptr");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let t = 0, last = 0, running = false, shown = "", shownRows = "";

  function place(el) {
    const s = root.getBoundingClientRect(), r = el.getBoundingClientRect();
    ptr.style.left = (r.left - s.left + r.width * 0.55) + "px";
    ptr.style.top = (r.top - s.top + r.height * 0.5) + "px";
  }

  function render() {
    const file = FILES.find((f) => t >= f.from && t < f.to) || FILES[0];

    // The editor: open changes coloured with Keep and Undo under them;
    // decided ones settle into plain code, or back to what was there.
    const tabs = FILES.map((f) => {
      const undone = fileState(f, t) === "undo";
      return `<div class="hx-tab${f === file ? " on" : ""}"><i>${f.icon}</i>${f.name}${undone ? "" : '<span class="m">M</span>'}</div>`;
    }).join("");
    let html = "", n = 0;
    file.lines.forEach(([k, line, h], i) => {
      const s = h ? state(h, t) : "open";
      const gone = (k === "+" && s === "undo") || (k === "-" && s === "keep");
      const kind = gone ? "gone" : (k === "+" && s === "open") ? "add" : (k === "-" && s === "open") ? "del" : "";
      if (!gone) { html += `<div class="hx-ln ${kind}"><b>${kind === "del" ? "" : ++n}</b><span>${line || " "}</span></div>`; }
      const next = file.lines[i + 1];
      if (h && s === "open" && (!next || next[2] !== h)) {
        html += `<div class="rv-bar"><span class="hx-btn pri" id="rv-k-${h}">Keep</span><span class="hx-btn" id="rv-u-${h}">Undo</span></div>`;
      }
    });
    const sig = file.key + tabs + html.length + Object.keys(DECIDE).map((h) => state(h, t)).join();
    if (sig !== shown) {
      shown = sig;
      $("rv-tabs").innerHTML = `<div class="rv-tabs-in">${tabs}</div>`;
      $("rv-crumb").textContent = file.path;
      code.innerHTML = html;
      const on = $("rv-tabs").querySelector(".on");
      const shift = Math.max(0, on.getBoundingClientRect().right - root.getBoundingClientRect().right + 12);
      $("rv-tabs").firstChild.style.transform = `translateX(${-shift}px)`;
    }

    // The files in the chat, and where the review has got to.
    const rows = FILES.map((f) => {
      const [a, d] = count(f.lines), s = fileState(f, t);
      const st = s === "keep" ? "✓ Kept" : s === "undo" ? "↺ Undone" : f === file ? "Reviewing" : "";
      return `<div class="rv-file ${f === file && s === "open" ? "now" : ""} ${s === "keep" ? "kept" : s === "undo" ? "undone" : ""}"><span class="nm">${f.name}</span><span class="n"><span class="hx-add">+${a}</span> <span class="hx-del">−${d}</span></span><span class="st">${st}</span></div>`;
    }).join("");
    if (rows !== shownRows) {
      shownRows = rows;
      $("rv-rows").innerHTML = rows;
      const [a, d] = FILES.reduce(([x, y], f) => { const [p, q] = count(f.lines); return [x + p, y + q]; }, [0, 0]);
      $("rv-keep").innerHTML = t >= ALL
        ? '<span class="f">Reviewed · 2 kept, 1 undone</span>'
        : `<span class="f">3 files changed <span class="hx-add">+${a}</span> <span class="hx-del">−${d}</span></span><span class="hx-btn pri">Keep all</span><span class="hx-btn">Undo all</span>`;
    }
    $("rv-nav").innerHTML = t >= ALL ? "<b>Reviewed</b><i>2 kept, 1 undone</i>" : `${file.name}<i>·</i><b>${FILES.indexOf(file) + 1} of 3</b><i>files</i>`;

    // The pointer, and the buttons it touches.
    const leg = PATH.find(([a, b]) => t >= a && t < b);
    ptr.style.opacity = leg ? "1" : "0";
    code.querySelectorAll(".hx-btn").forEach((b) => b.classList.remove("hover", "press"));
    if (leg && $(leg[2])) {
      place($(leg[2]));
      if (t - leg[0] > 0.45) { $(leg[2]).classList.add("hover"); }
    }
    const press = PRESS.find(([a, b]) => t >= a && t < b);
    if (press && $(press[2])) { $(press[2]).classList.add("press"); }
  }

  function frame(now) {
    if (!running) { return; }
    t += Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
    if (t > LOOP) { t = 0; }
    render();
    requestAnimationFrame(frame);
  }

  // At rest, and for anyone who asked for less motion: the last choice,
  // about to undo the part nobody asked for.
  t = REST; render();
  if (still) { return; }
  const go = () => { if (running) { return; } running = true; t = 0; last = performance.now(); requestAnimationFrame(frame); };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { go(); } else { running = false; } }), { threshold: 0.2 }).observe(root);
  } else { go(); }
})();

/* The tests demo: a test fails, the agent reads why, fixes it and runs them again. */

(() => {
  const root = document.getElementById("ts");
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const LOOP = 13.5, REST = 10.2;
  const TASK = "Add discount codes to checkout.";

  // The file: [when the line appears (0 = already there; "dX" = removed at X), html, when it is taken out again].
  const TOTAL = [
    [0, '<span class="k">import</span> { sum, withTax } <span class="k">from</span> <span class="s">"./money"</span>;'],
    [2.6, '<span class="k">import</span> { CODES } <span class="k">from</span> <span class="s">"./codes"</span>;'],
    [0, ''],
    ["d2.8", '<span class="k">export function</span> <span class="f">total</span>(cart) {'],
    [2.8, '<span class="k">export function</span> <span class="f">total</span>(cart, code) {'],
    [0, '  <span class="k">const</span> subtotal = <span class="f">sum</span>(cart.items);'],
    ["d3.0", '  <span class="k">return</span> <span class="f">withTax</span>(subtotal);'],
    [3.0, '  <span class="k">const</span> off = <span class="f">discount</span>(code, subtotal);'],
    [3.15, '  <span class="k">return</span> <span class="f">withTax</span>(subtotal) - off;', 6.9],
    [6.9, '  <span class="k">return</span> <span class="f">withTax</span>(subtotal - off);'],
    [0, '}'],
    [3.3, ''],
    [3.35, '<span class="k">function</span> <span class="f">discount</span>(code, amount) {'],
    [3.5, '  <span class="k">const</span> pct = CODES[code] ?? <span class="nu">0</span>;'],
    [3.6, '  <span class="k">return</span> (amount * pct) / <span class="nu">100</span>;'],
    [3.7, '}'],
  ];
  const TERM = [
    [4.0, '<span class="dim">~/acme-shop $</span> <span class="w">npm test</span>'],
    [4.4, ' <span class="tag ok">PASS</span> src/cart/cart.test.ts'],
    [4.7, ' <span class="tag bad">FAIL</span> src/checkout/total.test.ts'],
    [4.8, ''],
    [4.9, '  <span class="bad">● total › takes the code off before tax</span>'],
    [5.1, '    expect(total(cart, "SAVE10")).toBe(99)'],
    [5.25, '    Expected: <span class="ok">99</span>'],
    [5.3, '    Received: <span class="bad">100</span>'],
    [5.4, ''],
    [5.5, '<span class="w">Tests:</span> <span class="bad">1 failed</span>, 41 passed, 42 total'],
    [7.6, ''],
    [7.65, '<span class="dim">~/acme-shop $</span> <span class="w">npm test</span>'],
    [8.1, ' <span class="tag ok">PASS</span> src/cart/cart.test.ts'],
    [8.5, ' <span class="tag ok">PASS</span> src/checkout/total.test.ts'],
    [8.6, ''],
    [8.9, '<span class="w">Tests:</span> <span class="ok">42 passed</span>, 42 total'],
  ];

  const timed = [...root.querySelectorAll("[data-at]")];
  const spins = [...root.querySelectorAll("[data-spin]")].map((el) => [el, ...el.dataset.spin.split(":").map(Number)]);
  const chat = $("ts-chat"), scroll = $("ts-scroll"), code = $("ts-code"), out = $("ts-out"), lines = $("ts-lines");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let t = 0, last = 0, running = false, shownCode = "", shownTerm = -1;

  function renderCode() {
    const vis = [];
    for (const [at, html, outAt] of TOTAL) {
      const removed = typeof at === "string";
      if (!removed && at > 0 && t < at) { continue; }
      const gone = removed ? t >= +at.slice(1) : outAt !== undefined && t >= outAt;
      vis.push([gone ? "del" : (!removed && at > 0) ? "add" : "", html, !removed && at > 0 && t - at < 0.25]);
    }
    const sig = vis.map((v) => v[0] + (v[2] ? "n" : "")).join();
    if (sig === shownCode) { return; }
    shownCode = sig;
    let n = 0;
    code.innerHTML = vis.map(([kind, html, fresh]) =>
      `<div class="hx-ln ${kind}${fresh ? " new" : ""}"><b>${kind === "del" ? "" : ++n}</b><span>${html || " "}</span></div>`).join("");
  }

  function render() {
    const typed = Math.max(0, Math.min(TASK.length, Math.round(((t - 0.2) / 0.8) * TASK.length)));
    $("ts-typed").textContent = TASK.slice(0, typed);
    $("ts-caret").classList.toggle("hx-gone", t > 1.1);

    timed.forEach((el) => {
      const on = t >= +el.dataset.at && !(el.dataset.until && t >= +el.dataset.until);
      if (chat.contains(el)) { el.classList.toggle("hx-gone", !on); }
      else { el.classList.toggle("hx-off", !on); }
    });
    spins.forEach(([el, a, b]) => { el.className = "hx-ico " + (t >= b ? "ok" : t >= a ? "spin" : ""); });
    $("ts-m").classList.toggle("hx-gone", t < 2.6);
    renderCode();

    const shown = TERM.filter(([at]) => t >= at).length;
    if (shown !== shownTerm) {
      shownTerm = shown;
      lines.innerHTML = TERM.slice(0, shown).map(([, l]) => `<div>${l || " "}</div>`).join("");
      lines.style.transform = `translateY(${-Math.max(0, lines.scrollHeight - out.clientHeight)}px)`;
    }

    const over = chat.scrollHeight - scroll.clientHeight;
    chat.style.transform = `translateY(${-Math.max(0, over)}px)`;
  }

  function frame(now) {
    if (!running) { return; }
    t += Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
    if (t > LOOP) { t = 0; }
    render();
    requestAnimationFrame(frame);
  }

  // At rest, and for anyone who asked for less motion: the tests passing.
  t = REST; render();
  if (still) { return; }
  const go = () => { if (running) { return; } running = true; t = 0; last = performance.now(); requestAnimationFrame(frame); };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { go(); } else { running = false; } }), { threshold: 0.2 }).observe(root);
  } else { go(); }
})();

/* Enterprise: an admin adds an Agent Rule, and a member's agent follows it. */

(() => {
  const root = document.getElementById("er");
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const LOOP = 12, REST = 8.6;
  const TITLE = "Use our design system";
  const BODY = "Build UI with components from @acme/ui. Never write raw hex colours; use the theme tokens.";
  const TASK = "Add a Pay now button to the invoice page.";
  const CODE = [
    [0, '<span class="k">import</span> { formatMoney } <span class="k">from</span> <span class="s">"../lib/money"</span>;'],
    [6.2, '<span class="k">import</span> { Button } <span class="k">from</span> <span class="s">"@acme/ui"</span>;'],
    [0, ''],
    [0, '<span class="k">export function</span> <span class="f">Invoice</span>({ invoice, pay }) {'],
    [0, '  <span class="k">return</span> ('],
    [0, '    &lt;<span class="t">Page</span> title={<span class="s">`Invoice ${invoice.number}`</span>}&gt;'],
    [0, '      &lt;<span class="t">Total</span>&gt;{<span class="f">formatMoney</span>(invoice.total)}&lt;/<span class="t">Total</span>&gt;'],
    [6.4, '      &lt;<span class="t">Button</span> variant=<span class="s">"primary"</span> onClick={pay}&gt;'],
    [6.55, '        Pay now'],
    [6.7, '      &lt;/<span class="t">Button</span>&gt;'],
    [0, '    &lt;/<span class="t">Page</span>&gt;'],
    [0, '  );'],
    [0, '}'],
  ];
  const type = (text, from, to, t) => text.slice(0, Math.max(0, Math.min(text.length, Math.round(((t - from) / (to - from)) * text.length))));
  const timed = [...root.querySelectorAll("[data-at]")];
  const spins = [...root.querySelectorAll("[data-spin]")].map((el) => [el, ...el.dataset.spin.split(":").map(Number)]);
  const chat = $("er-chat"), scroll = $("er-scroll"), code = $("er-code");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let t = 0, last = 0, running = false, shown = "";

  function render() {
    // The admin writes the rule and saves it.
    $("er-t1").textContent = type(TITLE, 0.3, 1.0, t);
    $("er-t2").textContent = type(BODY, 1.1, 2.2, t);
    $("er-c1").classList.toggle("hx-gone", t >= 1.05);
    $("er-c2").classList.toggle("hx-gone", t < 1.05 || t >= 2.3);
    $("er-save").classList.toggle("press", t >= 2.35 && t < 2.5);
    $("er-new").classList.toggle("hx-gone", t < 2.5);
    $("er-new").classList.toggle("fresh", t < 3.6);
    $("er-toast").classList.toggle("hx-off", !(t >= 2.6 && t < 4.4));

    // A member asks their agent for something, and it follows the rule.
    $("er-win").classList.toggle("en-hide", t < 3.4);
    $("er-typed").textContent = type(TASK, 3.9, 4.7, t);
    $("er-caret").classList.toggle("hx-gone", t > 4.8);
    timed.forEach((el) => {
      const on = t >= +el.dataset.at;
      if (chat.contains(el)) { el.classList.toggle("hx-gone", !on); }
      else { el.classList.toggle("hx-off", !on); }
    });
    spins.forEach(([el, a, b]) => { el.className = "hx-ico " + (t >= b ? "ok" : t >= a ? "spin" : ""); });
    $("er-m").classList.toggle("hx-gone", t < 6.2);
    const vis = CODE.filter(([at]) => !(at > 0 && t < at));
    const sig = vis.map(([at]) => at > 0 && t - at < 0.25 ? "n" : at > 0 ? "a" : "").join();
    if (sig !== shown) {
      shown = sig;
      let n = 0;
      code.innerHTML = vis.map(([at, html]) => `<div class="hx-ln ${at > 0 ? "add" : ""}${at > 0 && t - at < 0.25 ? " new" : ""}"><b>${++n}</b><span>${html || " "}</span></div>`).join("");
    }
    const over = chat.scrollHeight - scroll.clientHeight;
    chat.style.transform = `translateY(${-Math.max(0, over)}px)`;
  }

  function frame(now) {
    if (!running) { return; }
    t += Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
    if (t > LOOP) { t = 0; }
    render();
    requestAnimationFrame(frame);
  }

  t = REST; render();
  if (still) { return; }
  const go = () => { if (running) { return; } running = true; t = 0; last = performance.now(); requestAnimationFrame(frame); };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { go(); } else { running = false; } }), { threshold: 0.2 }).observe(root);
  } else { go(); }
})();

/* Enterprise: the audit log fills in as people act, and the admin exports it. */

(() => {
  const root = document.getElementById("ea");
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const LOOP = 11, REST = 8.2;
  // People are shown by their work address, as the console does; no names.
  const PEOPLE = { A: ["admin@acme.com", "#7fb77e"], D: ["dev4@acme.com", "#82aaff"], O: ["owner@acme.com", "#e0b07a"], L: ["lead@acme.com", "#c792ea"] };
  // [second it happens (0 = already there), who, what, action, when it shows as having happened]
  const EVENTS = [
    [7.0, "A", "Exported the audit log", "audit_log.exported"],
    [5.0, "A", "Created the API key “CI pipeline”", "api_key.created"],
    [4.0, "A", "Updated the Agent Rule “Use our design system”", "rule.updated"],
    [3.0, "O", "Changed dev4@acme.com’s role to admin", "member.role_changed"],
    [2.0, "D", "Accepted the invite", "member.joined"],
    [1.0, "A", "Invited dev4@acme.com as developer", "member.invited"],
    [0, "L", "Created the team “Payments”", "team.created", "Yesterday"],
    [0, "A", "Made the workspace “billing” private", "workspace.visibility_changed", "Yesterday"],
    [0, "O", "Verified the domain acme.com", "domain.verified", "2 days ago"],
    [0, "L", "Created the Agent Rule “No secrets in code”", "rule.created", "3 days ago"],
  ];
  const log = $("ea-log"), ptr = $("ea-ptr"), btn = $("ea-export");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let t = 0, last = 0, running = false, shown = -1;

  function place(el) {
    const s = root.getBoundingClientRect(), r = el.getBoundingClientRect();
    ptr.style.left = (r.left - s.left + r.width * 0.55) + "px";
    ptr.style.top = (r.top - s.top + r.height * 0.5) + "px";
  }

  function render() {
    const vis = EVENTS.filter(([at]) => t >= at);
    if (vis.length !== shown) {
      const fresh = vis.length > shown && shown >= 0;
      shown = vis.length;
      log.innerHTML = vis.map(([at, who, what, action, when], i) => {
        const [name, colour] = PEOPLE[who];
        const ago = when || (t - at < 60 ? "Just now" : "");
        return `<div class="en-ev${fresh && i === 0 ? " fresh" : ""}"><i style="background:${colour}">${name[0].toUpperCase()}</i><b>${name}<em>${ago}</em></b><small>${what}<code>${action}</code></small></div>`;
      }).join("");
    }
    // The admin exports what they see.
    const leg = t >= 5.8 && t < 7.6;
    ptr.style.opacity = leg ? "1" : "0";
    if (leg) { place(btn); }
    btn.classList.toggle("hover", t >= 6.3 && t < 7.2);
    btn.classList.toggle("press", t >= 6.85 && t < 7.0);
    $("ea-toast").classList.toggle("hx-off", !(t >= 7.0 && t < 9.4));
  }

  function frame(now) {
    if (!running) { return; }
    t += Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
    if (t > LOOP) { t = 0; shown = -1; }
    render();
    requestAnimationFrame(frame);
  }

  t = REST; render();
  if (still) { return; }
  const go = () => { if (running) { return; } running = true; t = 0; shown = -1; last = performance.now(); requestAnimationFrame(frame); };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { go(); } else { running = false; } }), { threshold: 0.2 }).observe(root);
  } else { go(); }
})();


/* Enterprise: usage across the organisation, and by member. */

(() => {
  const root = document.getElementById("eu");
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const LOOP = 9, REST = 4.6;
  const STATS = [["eu-s1", 18420, ""], ["eu-s2", 9310, ""], ["eu-s3", 42, " of 50"], ["eu-s4", 61.2, "M"]];
  const ROWS = [
    ["dev1@acme.com", "developer", 1284, 642, "Just now"],
    ["lead@acme.com", "admin", 1106, 571, "2 min ago"],
    ["mobile@acme.com", "developer", 987, 498, "10 min ago"],
    ["data@acme.com", "developer", 912, 455, "1 hour ago"],
    ["dev4@acme.com", "admin", 846, 412, "Today"],
    ["web@acme.com", "developer", 803, 391, "Yesterday"],
  ];
  const fmt = (n) => n.toLocaleString("en-US");
  const line = $("eu-line"), area = $("eu-area"), rows = $("eu-rows");
  const reveal = $("eu-reveal");
  rows.innerHTML = ROWS.map(([who, role, req, cr, when], i) =>
    `<div class="en-row" data-i="${i}"><span>${i + 1}</span><b>${who}</b><em>${role}</em><span>${fmt(req)}</span><span>${fmt(cr)}</span><small>${when}</small></div>`).join("");
  const rowEls = [...rows.children];
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let t = 0, last = 0, running = false;

  function render() {
    const k = Math.min(1, Math.max(0, (t - 0.2) / 1.3));
    const ease = 1 - Math.pow(1 - k, 3);
    STATS.forEach(([id, n, unit]) => {
      const v = n * ease;
      $(id).textContent = (unit === "M" ? v.toFixed(1) : fmt(Math.round(v))) + unit;
    });
    const d = Math.min(1, Math.max(0, (t - 0.6) / 2.0));
    // The chart draws itself left to right.
    reveal.setAttribute("width", String(600 * d));
    area.style.opacity = String(Math.min(1, Math.max(0, (t - 1.2) / 1.2)));
    rowEls.forEach((el, i) => el.classList.toggle("hx-off", t < 2.4 + i * 0.18));
  }

  function frame(now) {
    if (!running) { return; }
    t += Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
    if (t > LOOP) { t = 0; }
    render();
    requestAnimationFrame(frame);
  }

  t = REST; render();
  if (still) { return; }
  const go = () => { if (running) { return; } running = true; t = 0; last = performance.now(); requestAnimationFrame(frame); };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { go(); } else { running = false; } }), { threshold: 0.2 }).observe(root);
  } else { go(); }
})();

/* The ship demo: a preview link, checked, then production once you allow it. */

(() => {
  const root = document.getElementById("dp");
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const LOOP = 15, REST = 12.6;
  const TASK = "Put this on a link I can share.";
  const LOG = [
    [2.8, '<span class="w">▸ Installing dependencies</span>'],
    [3.5, '<span class="dim">  added 214 packages in 6s</span>'],
    [3.9, '<span class="w">▸ Building</span> <span class="dim">· npm run build</span>'],
    [4.3, '<span class="dim">  vite v6 building for production…</span>'],
    [4.9, '<span class="dim">  ✓ 38 modules transformed</span>'],
    [5.3, '<span class="dim">  dist/  12 files · 214 kB</span>'],
    [5.8, '<span class="w">▸ Publishing</span>'],
    [6.6, '<span class="ok">✓ Live</span>  https://acme-app-preview.cloudeide.app'],
  ];
  const LOG2 = [
    [10.3, ''],
    [10.3, '<span class="w">▸ Production</span> <span class="dim">· the same build</span>'],
    [11.5, '<span class="ok">✓ Live</span>  https://acme.com'],
  ];

  const timed = [...root.querySelectorAll("[data-at]")];
  const spins = [...root.querySelectorAll("[data-spin]")].map((el) => [el, ...el.dataset.spin.split(":").map(Number)]);
  const chat = $("dp-chat"), scroll = $("dp-scroll"), log = $("dp-log"), ptr = $("dp-ptr"), allow = $("dp-allow");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let t = 0, last = 0, running = false, shown = -1;

  function place(el) {
    const s = root.getBoundingClientRect(), r = el.getBoundingClientRect();
    ptr.style.left = (r.left - s.left + r.width * 0.55) + "px";
    ptr.style.top = (r.top - s.top + r.height * 0.5) + "px";
  }

  function render() {
    const typed = Math.max(0, Math.min(TASK.length, Math.round(((t - 0.2) / 0.9) * TASK.length)));
    $("dp-typed").textContent = TASK.slice(0, typed);
    $("dp-caret").classList.toggle("hx-gone", t > 1.2);

    timed.forEach((el) => {
      const on = t >= +el.dataset.at && !(el.dataset.until && t >= +el.dataset.until);
      el.classList.toggle("hx-gone", !on);
    });
    spins.forEach(([el, a, b]) => { el.className = "hx-ico " + (t >= b ? "ok" : t >= a ? "spin" : ""); });

    // The build log, then the site; back to the log for production, then the site again.
    const lines = [...LOG, ...LOG2].filter(([at]) => t >= at);
    if (lines.length !== shown) {
      shown = lines.length;
      log.innerHTML = lines.map(([, l]) => `<div>${l || " "}</div>`).join("");
    }
    const onSite = (t >= 7.0 && t < 10.2) || t >= 11.9;
    $("dp-logpane").classList.toggle("dp-hide", onSite);
    $("dp-sitepane").classList.toggle("dp-hide", !onSite);
    $("dp-env").textContent = t >= 10.1 ? "production" : "preview";
    $("dp-addr").textContent = t >= 11.9 ? "acme.com" : "acme-app-preview.cloudeide.app";

    // The person allows production.
    const leg = t >= 8.6 && t < 10.0;
    ptr.style.opacity = leg ? "1" : "0";
    if (leg && allow.offsetParent) { place(allow); }
    allow.classList.toggle("press", t >= 9.55 && t < 9.7);

    const over = chat.scrollHeight - scroll.clientHeight;
    chat.style.transform = `translateY(${-Math.max(0, over)}px)`;
  }

  function frame(now) {
    if (!running) { return; }
    t += Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
    if (t > LOOP) { t = 0; shown = -1; }
    render();
    requestAnimationFrame(frame);
  }

  // At rest, and for anyone who asked for less motion: the site, live.
  t = REST; render();
  if (still) { return; }
  const go = () => { if (running) { return; } running = true; t = 0; shown = -1; last = performance.now(); requestAnimationFrame(frame); };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { go(); } else { running = false; } }), { threshold: 0.2 }).observe(root);
  } else { go(); }
})();

/* On a phone, a download button explains itself instead of doing nothing visible. */

(() => {
  if (!onPhone) return;
  let sheet = null;
  const open = (href) => {
    if (!sheet) {
      sheet = document.createElement("div");
      sheet.className = "phone-sheet";
      sheet.setAttribute("role", "dialog");
      sheet.setAttribute("aria-modal", "true");
      sheet.setAttribute("aria-labelledby", "phone-sheet-title");
      sheet.innerHTML =
        '<div class="phone-sheet-card">' +
        '<h2 id="phone-sheet-title">CloudeIDE is a desktop app</h2>' +
        "<p>Open <b>cloudeide.com</b> on your Mac, Windows or Linux computer to download it.</p>" +
        '<div class="phone-sheet-actions">' +
        '<button type="button" class="btn btn-primary" data-copy-link>Copy link</button>' +
        '<button type="button" class="btn btn-secondary" data-close>Close</button>' +
        "</div>" +
        '<a class="phone-sheet-anyway" data-anyway href="#">Download the file anyway</a>' +
        "</div>";
      document.body.appendChild(sheet);
      sheet.addEventListener("click", (e) => {
        const t = e.target;
        if (t === sheet || t.closest("[data-close]")) sheet.hidden = true;
        if (t.closest("[data-copy-link]")) {
          const btn = t.closest("[data-copy-link]");
          navigator.clipboard?.writeText("https://cloudeide.com/").then(
            () => { btn.textContent = "Copied"; },
            () => { btn.textContent = "cloudeide.com"; },
          );
        }
      });
    }
    sheet.querySelector("[data-anyway]").href = href;
    sheet.querySelector("[data-copy-link]").textContent = "Copy link";
    sheet.hidden = false;
  };
  document.addEventListener("click", (e) => {
    const link = e.target.closest('a[href*="/releases/latest/download/"]');
    if (!link || link.hasAttribute("data-anyway")) return;
    e.preventDefault();
    open(link.href);
  });
})();

/* The brand film: fetched when it nears the screen, played while it is on it. */
(() => {
  const v = document.getElementById("filmVideo");
  if (!v) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let loaded = false;
  const load = () => { if (loaded) return; loaded = true; v.querySelectorAll("source").forEach((s) => { s.src = s.dataset.src; }); v.load(); };
  if (!("IntersectionObserver" in window)) { load(); v.play().catch(() => {}); return; }
  new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { load(); } }), { rootMargin: "600px 0px" }).observe(v);
  let visible = false;
  const play = () => { if (visible) v.play().catch(() => {}); };
  v.addEventListener("canplay", play);
  new IntersectionObserver((es) => es.forEach((e) => { visible = e.isIntersecting; if (visible) { load(); play(); } else { v.pause(); } }), { threshold: 0.35 }).observe(v);
})();

/* The iOS page: an iPhone connects to the Mac you already use, then drives it. */
(() => {
  const root = document.getElementById("cn");
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const fit = $("cnFit"), panel = fit.parentElement;
  // Wide: the whole desk. Narrow: zoom in on the phone and the Mac's agent
  // panel beside it, so the phone stays readable.
  const scale = () => {
    const W = panel.clientWidth, Hh = panel.clientHeight;
    if (W >= 700) { const s = Math.min(1, (W - 24) / 980, (Hh - 20) / 580); fit.style.transform = `translate(-50%, -50%) scale(${s})`; return; }
    const s = Math.min(W / 520, (Hh - 10) / 580), shift = (980 * s - W) / 2 + 6;
    fit.style.transform = `translate(calc(-50% - ${shift}px), -50%) scale(${s})`;
  };
  scale(); addEventListener("resize", scale);

  const LOOP = 15.5, REST = 13.4;
  const EMAIL = "you@acme.com", ASK = "Add an FAQ to the pricing page.";
  const views = [...root.querySelectorAll(".cn-v")];
  const BASE = [
    ['<span class="k">export function</span> <span class="f">PricingPage</span>() {', 0],
    ['  <span class="k">return</span> (', 0],
    ['    &lt;<span class="t">section</span> className=<span class="s">"pricing"</span>&gt;', 0],
    ['      &lt;<span class="t">PlanCards</span> /&gt;', 0],
    ['      &lt;<span class="t">FAQ</span> items={questions} /&gt;', 10.6],
    ['    &lt;/<span class="t">section</span>&gt;', 0],
    ['  );', 0],
    ['}', 0],
    ['', 0],
    ['<span class="k">const</span> questions = [', 9.8],
    ['  { q: <span class="s">"Can I change plans?"</span>, a: <span class="s">"Yes, any time."</span> },', 10.0],
    ['  { q: <span class="s">"Do credits expire?"</span>, a: <span class="s">"Bought ones never do."</span> },', 10.2],
    ['];', 10.3],
  ];
  const STEPS = [[9.3, "Read 4 files"], [10.1, 'Created <code>FAQ.tsx</code> <em class="p">+34</em>'], [10.7, 'Edited <code>PricingPage.tsx</code> <em class="p">+2</em>'], [11.6, "Ran tests · 8 passed"]];
  const ptr = $("cn-ptr"), tap = $("cn-tap"), link = $("cn-link"), path = $("cn-path");
  const dots = [$("cn-p1"), $("cn-p2"), $("cn-p3")];
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let t = 0, last = 0, running = false, drawn = "", tapped = -1;

  function tapAt(el, id) {
    if (tapped === id) return; tapped = id;
    const s = root.getBoundingClientRect(), r = el.getBoundingClientRect(), k = s.width / 980;
    const host = tap.parentElement.getBoundingClientRect();
    tap.style.left = ((r.left + r.width / 2 - host.left) / k) + "px"; tap.style.top = ((r.top + r.height / 2 - host.top) / k) + "px";
    tap.classList.remove("on"); void tap.offsetWidth; tap.classList.add("on");
  }

  function render() {
    const view = t < 2.6 ? "signin" : t < 4.4 ? "devices" : t < 6.4 ? "code" : "chat";
    views.forEach((v) => v.classList.toggle("on", v.dataset.v === view));
    const em = Math.max(0, Math.min(EMAIL.length, Math.round((t - 0.4) / 1.2 * EMAIL.length)));
    $("cn-email").textContent = EMAIL.slice(0, em);
    $("cn-cont").classList.toggle("press", t >= 2.1 && t < 2.3);
    $("cn-dev").classList.toggle("press", t >= 3.8 && t < 4.0);
    if (t >= 2.1 && t < 2.3) tapAt($("cn-cont"), 1);
    if (t >= 3.8 && t < 4.0) tapAt($("cn-dev"), 2);
    if (t >= 8.0 && t < 8.2) tapAt($("cn-typed"), 3);
    if (t < 1) tapped = -1;

    // The Mac: approve, then work.
    $("cn-modal").classList.toggle("on", t >= 4.6 && t < 6.25);
    const allow = $("cn-allow");
    allow.classList.toggle("press", t >= 5.85 && t < 6.0);
    const showPtr = t >= 4.9 && t < 6.3;
    ptr.style.opacity = showPtr ? "1" : "0";
    if (showPtr) {
      const s = root.getBoundingClientRect(), r = allow.getBoundingClientRect(), k = s.width / 980;
      const p = Math.min(1, Math.max(0, (t - 4.9) / 0.8)), e = 1 - Math.pow(1 - p, 3);
      const tx = (r.left - s.left + r.width * 0.5) / k, ty = (r.top - s.top + r.height * 0.6) / k;
      ptr.style.left = (tx + 160 * (1 - e)) + "px"; ptr.style.top = (ty + 110 * (1 - e)) + "px";
    }
    $("cn-toast").classList.toggle("on", t >= 6.25 && t < 7.8);
    link.classList.toggle("on", t >= 6.25);
    $("cn-from").classList.toggle("cn-hide", t < 8.8);
    $("cn-faqf").classList.toggle("cn-hide", t < 10.1);

    // Packets: phone to Mac when the task is sent, Mac to phone as steps come back.
    const L = path.getTotalLength();
    dots.forEach((d, i) => {
      let f = -1;
      if (t >= 8.2 && t < 9.0) f = 1 - Math.min(1, (t - 8.2 - i * 0.12) / 0.6);
      else if (t >= 9.3 && t < 12.2) f = ((t - 9.3) * 0.9 + i * 0.33) % 1;
      if (f < 0 || f > 1) { d.style.opacity = 0; return; }
      const pt = path.getPointAtLength(L * f); d.setAttribute("cx", pt.x); d.setAttribute("cy", pt.y); d.style.opacity = 1;
    });

    const typed = Math.max(0, Math.min(ASK.length, Math.round((t - 6.8) / 1.0 * ASK.length)));
    const sent = t >= 8.1;
    const shownSteps = STEPS.filter(([a]) => t >= a).length;
    const lines = BASE.filter(([, a]) => t >= a);
    const key = [view, typed, sent, shownSteps, lines.length, t >= 12.0].join("|");
    if (key !== drawn) {
      drawn = key;
      $("cn-typed").innerHTML = view === "chat" && !sent && typed > 0 ? ASK.slice(0, typed) + '<i class="cn-car"></i>' : "Ask for a change…";
      $("cn-you").classList.toggle("cn-gone", !sent);
      $("cn-steps").classList.toggle("cn-gone", shownSteps === 0);
      $("cn-steps").innerHTML = STEPS.slice(0, shownSteps).map(([, s]) => `<div><span class="io-ok"></span>${s}</div>`).join("");
      $("cn-ms").innerHTML = STEPS.slice(0, shownSteps).map(([, s]) => `<div><span class="io-ok"></span>${s}</div>`).join("");
      $("cn-done").classList.toggle("cn-gone", t < 12.0);
      $("cn-code").innerHTML = lines.map(([l, a], i) => `<div class="${a > 0 ? "add" : ""}"><b>${i + 1}</b><span>${l}</span></div>`).join("");
    }
  }

  function frame(now) {
    if (!running) return;
    t += Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
    if (t > LOOP) { t = 0; drawn = ""; }
    render(); requestAnimationFrame(frame);
  }
  t = REST; render();
  const pin = new URLSearchParams(location.search).get("t");
  if (pin) { t = +pin; render(); return; }
  if (still) return;
  const go = () => { if (running) return; running = true; t = 0; drawn = ""; last = performance.now(); requestAnimationFrame(frame); };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) go(); else running = false; }), { threshold: 0.25 }).observe(root);
  } else { go(); }
})();
