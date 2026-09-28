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
  const here = /mac/i.test(platform) || /Mac OS X/i.test(ua)
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
  const base = "https://github.com/laxmansubedi7/cloudevs/releases/latest/download/";
  let file = "";
  let name = "";
  if (!/mac/i.test(platform) && !/Mac OS X/i.test(ua)) {
    if (/win/i.test(platform) || /Windows/i.test(ua)) {
      file = "CloudeIDE-win32-x64.zip";
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
    t += Math.min(0.1, (now - last) / 1000); last = now;
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
    t += Math.min(0.1, (now - last) / 1000); last = now;
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
