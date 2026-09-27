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

/* The agent demo on the home page. */

(() => {
  const stage = document.querySelector(".ad-stage");
  if (!stage) return;
  const END = 10.4, LOOP = 12.4;
  const TASK = "Add a pricing page with yearly billing at 20% off, and tests";
  const TERM = [
    [4.9, '<span class="ad-p0">~/acme-app $</span> npm test'],
    [5.3, ' PASS  lib/pricing.test.ts'],
    [5.6, '<span class="ad-okl">✓ 12 passed</span> in 1.8s'],
    [5.7, '<span class="ad-p0">~/acme-app $</span> npm run build'],
    [6.1, '<span class="ad-okl">✓ Build passed</span> · 14 routes'],
    [9.0, '<span class="ad-p0">~/acme-app $</span> cloudeide deploy --env production'],
    [9.6, '<span class="ad-okl">✓ Live</span> at https://acme.com/pricing'],
  ];

  const $ = (id) => document.getElementById(id);
  const chat = $("ad-chat"), scroll = $("ad-chatScroll");
  const timed = [...stage.querySelectorAll("[data-at]")];
  const items = [...document.querySelectorAll(".ad-item")];
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let t = 0, last = 0, playing = false;
  const at = (s) => t >= s;

  function render() {
    const n = Math.max(0, Math.min(TASK.length, Math.round((t / 0.6) * TASK.length)));
    $("ad-typed").textContent = TASK.slice(0, n);

    timed.forEach((el) => {
      const on = at(+el.dataset.at);
      if (chat.contains(el)) { el.classList.remove("ad-off"); el.classList.toggle("ad-gone", !on); }
      else el.classList.toggle("ad-off", !on);
    });
    items.forEach((el) => {
      const d = at(+el.dataset.done);
      el.classList.toggle("ad-done", d);
      el.querySelector(".ad-ico").className = "ad-ico " + (d ? "ad-tick" : "ad-box");
    });

    $("ad-term").innerHTML = TERM.filter(([s]) => at(s)).slice(-5).map(([, l]) => `<div>${l}</div>`).join("");

    const yearly = at(6.3);
    $("ad-tgM").classList.toggle("ad-on", !yearly);
    $("ad-tgY").classList.toggle("ad-on", yearly);
    $("ad-pro").textContent = yearly ? "$16" : "$20";
    $("ad-team").textContent = yearly ? "$32" : "$40";
    $("ad-proPer").textContent = $("ad-teamPer").textContent = yearly ? "per month, billed yearly" : "per month";

    $("ad-keepBtn").classList.toggle("ad-press", at(7.2) && !at(7.5));
    $("ad-keepText").innerHTML = at(7.5) ? '<span class="ad-add">✓</span> Kept 4 files' : '4 files changed <span class="ad-add">+200</span> <span class="ad-del">−4</span>';
    $("ad-allow").classList.toggle("ad-press", at(9.0) && !at(9.3));
    $("ad-confirm").classList.toggle("ad-gone", !at(8.6) || at(9.4));
    $("ad-urlText").textContent = at(9.6) ? "acme.com/pricing" : "localhost:3000/pricing";

    $("ad-sesIco").className = "ad-ico " + (at(9.6) ? "ad-ok" : "ad-spin");
    $("ad-sesSub").innerHTML = at(9.6) ? '<span class="ad-add">+200</span> <span class="ad-del">−4</span> · Live' : at(6.5) ? "Ready for review" : at(2.6) ? "Building…" : at(1.5) ? "Planning…" : "Reading…";
    $("ad-sesWhen").textContent = at(9.6) ? "now" : "";

    const over = chat.scrollHeight - scroll.clientHeight;
    chat.style.transform = `translateY(${-Math.max(0, over)}px)`;

  }

  // Runs only while it is on screen, and starts from the beginning each
  // time it comes into view, so the visitor sees the whole job.
  function frame(now) {
    if (playing) {
      t += Math.min(0.1, (now - last) / 1000);
      if (t > LOOP) t = 0;
      render();
    }
    last = now;
    if (playing) requestAnimationFrame(frame);
  }

  function start() {
    if (playing || still) return;
    playing = true; t = 0; render();
    last = performance.now();
    requestAnimationFrame(frame);
  }

  if (still) { t = END; render(); return; }
  t = END; render();
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) start(); else playing = false; });
    }, { threshold: 0.3 }).observe(stage);
  } else {
    start();
  }
})();

/* The hero demo. */

(() => {
  const stage = document.querySelector(".hd-stage");
  if (!stage) return;
  const LOOP = 11;
  const TERM = [
    [4.6, '<span class="hd-p0">~/acme-app $</span> cloudeide deploy --env preview'],
    [5.1, ' 38 files · 412 KB'],
    [5.9, '<span class="hd-okl">✓ Preview ready</span> acme-app-checkout.cloudeide.app'],
  ];
  const $ = (id) => document.getElementById(id);
  const timed = [...stage.querySelectorAll("[data-at]")];
  const chat = $("hd-chat"), scroll = $("hd-chatScroll");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let t = 0, last = performance.now();
  const at = (s) => t >= s;

  function render() {
    timed.forEach((el) => el.classList.toggle("hd-gone", !at(+el.dataset.at)));
    $("hd-keep").classList.toggle("hd-off", !at(6.6));
    $("hd-term").innerHTML = TERM.filter(([s]) => at(s)).map(([, l]) => `<div>${l}</div>`).join("");
    $("hd-term").classList.toggle("hd-off", !at(4.6));
    const ready = at(5.9);
    $("hd-newDot").className = "hd-dot " + (ready ? "hd-ok" : at(4.6) ? "hd-run" : "");
    $("hd-newWhen").textContent = ready ? "just now" : at(4.6) ? "building…" : "queued";
    $("hd-rowNew").classList.toggle("hd-off", !at(4.6));
    $("hd-s1s").textContent = at(6.4) ? "Ready for review · preview up" : at(4.6) ? "Deploying a preview…" : at(3.9) ? "Running tests…" : at(2.0) ? "Editing 3 files…" : at(1.3) ? "Planning…" : "Reading the project…";
    $("hd-s1i").className = "hd-ico " + (at(6.4) ? "hd-ok" : "hd-spin");
    $("hd-s2s").textContent = at(7.5) ? "Editing 5 files…" : at(3) ? "Writing a plan…" : "Reading the project…";
    $("hd-vis").textContent = (1284 + Math.floor(t * 1.4)).toLocaleString("en-US");
    const over = chat.scrollHeight - scroll.clientHeight;
    chat.style.transform = `translateY(${-Math.max(0, over)}px)`;
  }
  // Loops only while it is on screen; it opens already full.
  let running = false;
  function frame(now) {
    if (!running) return;
    t += Math.min(0.1, (now - last) / 1000);
    last = now;
    if (t > LOOP) t = 0;
    render();
    requestAnimationFrame(frame);
  }
  t = 7; render();
  if (still) return;
  const go = () => { if (running) return; running = true; t = 0; last = performance.now(); requestAnimationFrame(frame); };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) go(); else running = false; }), { threshold: 0.2 }).observe(stage);
  } else { go(); }
})();
