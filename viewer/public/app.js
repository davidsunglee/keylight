const doc = document.getElementById("doc");
const docPath = document.body.dataset.doc;
const root = document.documentElement;
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

const probe = document.createElement("span");
probe.style.display = "none";
const canvas = document.createElement("canvas");
canvas.width = canvas.height = 1;
const pixel = canvas.getContext("2d", { willReadFrequently: true });

function token(name) {
  return getComputedStyle(root).getPropertyValue(name).trim();
}

/**
 * A page color as #rrggbb. Page colors are derived with color-mix(), which
 * Mermaid's own color code cannot read, so let the browser compute the color
 * and read the result back from a canvas pixel.
 */
function color(name) {
  if (!probe.isConnected) document.body.append(probe);
  probe.style.color = `var(${name})`;
  pixel.clearRect(0, 0, 1, 1);
  pixel.fillStyle = getComputedStyle(probe).color;
  pixel.fillRect(0, 0, 1, 1);
  const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

let mermaidReady = null;
let diagramCount = 0;
const svgCache = new Map(); // diagram source -> rendered SVG
const sources = new WeakMap(); // diagram block -> its source

function loadMermaid() {
  mermaidReady ??= import("/assets/mermaid/mermaid.esm.min.mjs").then(({ default: mermaid }) => {
    configureMermaid(mermaid);
    return mermaid;
  });
  return mermaidReady;
}

function configureMermaid(mermaid) {
  // The "base" theme takes its colors from the page, so diagrams match the
  // document in every theme.
  const fg = color("--fg");
  const strong = color("--border-strong");
  const surface = color("--surface");
  const node = color("--node-bg");
  const nodeBorder = color("--node-border");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    fontFamily: token("--font-sans"),
    themeVariables: {
      darkMode: token("--theme-kind") === "dark",
      background: color("--bg"),
      fontSize: "14px",
      primaryColor: node,
      primaryTextColor: fg,
      primaryBorderColor: nodeBorder,
      secondaryColor: surface,
      secondaryTextColor: fg,
      secondaryBorderColor: strong,
      tertiaryColor: surface,
      tertiaryTextColor: fg,
      tertiaryBorderColor: strong,
      lineColor: color("--muted"),
      textColor: fg,
      mainBkg: node,
      nodeBorder,
      clusterBkg: surface,
      clusterBorder: strong,
      titleColor: fg,
      edgeLabelBackground: color("--bg"),
      actorBkg: node,
      actorBorder: nodeBorder,
      actorTextColor: fg,
      actorLineColor: strong,
      signalColor: fg,
      signalTextColor: fg,
      labelBoxBkgColor: surface,
      labelBoxBorderColor: strong,
      labelTextColor: fg,
      loopTextColor: fg,
      noteBkgColor: color("--note-bg"),
      noteTextColor: fg,
      noteBorderColor: color("--note-border"),
      activationBkgColor: surface,
      activationBorderColor: strong,
    },
  });
}

// Mermaid keeps shared state while it draws, so diagrams render one at a time.
let renderQueue = Promise.resolve();

function drawSvg(source) {
  const run = renderQueue.then(async () => {
    const mermaid = await loadMermaid();
    const id = `diagram-${++diagramCount}`;
    try {
      return (await mermaid.render(id, source)).svg;
    } catch (err) {
      // Mermaid leaves its scratch element behind when a diagram is invalid.
      document.getElementById(`d${id}`)?.remove();
      document.getElementById(id)?.remove();
      throw err;
    }
  });
  renderQueue = run.catch(() => {});
  return run;
}

async function renderDiagram(block) {
  if (!sources.has(block)) sources.set(block, block.querySelector(".mermaid-src")?.textContent ?? "");
  const source = sources.get(block);
  block.dataset.state = "rendering";
  let svg = svgCache.get(source);
  if (!svg) {
    try {
      svg = await drawSvg(source);
      svgCache.set(source, svg);
    } catch (err) {
      // Show the source with the parser's message instead of a broken image.
      block.dataset.state = "error";
      if (!block.querySelector(".mermaid-error")) {
        const note = document.createElement("p");
        note.className = "mermaid-error";
        note.textContent = `Diagram failed to render: ${String(err?.message ?? err).split("\n")[0]}`;
        block.prepend(note);
      }
      return;
    }
  }
  const figure = document.createElement("button");
  figure.type = "button";
  figure.className = "mermaid-figure";
  figure.setAttribute("aria-label", "Enlarge diagram");
  figure.innerHTML = svg;
  figure.addEventListener("click", () => openDiagram(svgCache.get(source) ?? svg));
  block.replaceChildren(figure);
  block.dataset.state = "done";
}

const diagramObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      diagramObserver.unobserve(entry.target);
      renderDiagram(entry.target);
    }
  },
  { rootMargin: "800px 0px" },
);

function scanDiagrams() {
  for (const block of document.querySelectorAll(".mermaid-block:not([data-state])")) {
    const source = block.querySelector(".mermaid-src")?.textContent ?? "";
    // Already rendered once: swap it in immediately so a reload doesn't flicker.
    if (svgCache.has(source)) renderDiagram(block);
    else diagramObserver.observe(block);
  }
}

async function recolorDiagrams() {
  if (!mermaidReady) return;
  configureMermaid(await mermaidReady);
  svgCache.clear();
  for (const block of document.querySelectorAll('.mermaid-block[data-state="done"]')) renderDiagram(block);
}

let dialog = null;

function openDiagram(svg) {
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.className = "diagram-dialog";
    dialog.innerHTML =
      '<div class="dialog-bar"><button data-zoom="0.8" aria-label="Zoom out">&minus;</button>' +
      '<button data-zoom="1.25" aria-label="Zoom in">+</button>' +
      '<button data-zoom="fit">Fit</button><span class="spacer"></span>' +
      '<button data-close aria-label="Close">Close</button></div>' +
      '<div class="dialog-scroll"><div class="dialog-canvas"></div></div>';
    document.body.append(dialog);
    dialog.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      const area = dialog.querySelector(".dialog-canvas");
      const fit = dialog.querySelector(".dialog-scroll").clientWidth - 32;
      if (event.target === dialog || button?.hasAttribute("data-close")) dialog.close();
      else if (button?.dataset.zoom === "fit") area.style.width = `${fit}px`;
      else if (button?.dataset.zoom) {
        const next = area.getBoundingClientRect().width * Number(button.dataset.zoom);
        area.style.width = `${Math.min(fit * 12, Math.max(fit / 4, next))}px`;
      }
    });
  }
  const area = dialog.querySelector(".dialog-canvas");
  area.innerHTML = svg;
  const el = area.querySelector("svg");
  // Let the SVG fill the canvas so the zoom buttons scale it.
  const natural = el?.viewBox?.baseVal?.width ?? 0;
  el?.removeAttribute("height");
  el?.setAttribute("width", "100%");
  if (el) el.style.maxWidth = "none";
  dialog.showModal();
  // Open at the diagram's drawn size, where its text is readable, and scroll
  // if that is wider than the screen (a wide flowchart on a phone).
  const fit = dialog.querySelector(".dialog-scroll").clientWidth - 32;
  area.style.width = `${Math.max(fit, natural)}px`;
}

function addCopyButtons() {
  for (const pre of document.querySelectorAll("pre.code:not([data-copy])")) {
    pre.dataset.copy = "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy";
    button.textContent = "Copy";
    button.addEventListener("click", async () => {
      const lines = pre.querySelectorAll(".line");
      const text = lines.length
        ? [...lines].map((l) => l.textContent).join("\n")
        : (pre.querySelector("code")?.textContent ?? "");
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Failed";
      }
      setTimeout(() => (button.textContent = "Copy"), 1500);
    });
    pre.append(button);
  }
}

let spy = null;

function watchOutline() {
  spy?.disconnect();
  const links = new Map(
    [...document.querySelectorAll("#outline a")].map((a) => [decodeURIComponent(a.hash.slice(1)), a]),
  );
  if (!links.size) return;
  spy = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const a of links.values()) a.classList.remove("current");
        links.get(entry.target.id)?.classList.add("current");
      }
    },
    { rootMargin: "-10% 0px -75% 0px" },
  );
  for (const id of links.keys()) {
    const heading = document.getElementById(id);
    if (heading) spy.observe(heading);
  }
}

/** Keeps a choice on this device; null forgets it. Without storage the choice lasts for this page only. */
function remember(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable.
  }
}

function remembered(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Keeps which of a container's sections are folded, per document, and returns
 * a function that folds them again after the container's content is replaced.
 * `sectionOf` gives the id of the section a <details> folds, if it folds one.
 */
function keepFolds(container, key, sectionOf) {
  if (!container) return () => {};
  const byDoc = JSON.parse(remembered(key) ?? "{}");
  const folded = new Set(byDoc[docPath] ?? []);
  // "toggle" does not bubble, and also fires for sections this script folds,
  // so read the section's state instead of trusting the event.
  container.addEventListener(
    "toggle",
    (event) => {
      const id = sectionOf(event.target);
      if (!id || folded.has(id) === !event.target.open) return;
      if (event.target.open) folded.delete(id);
      else folded.add(id);
      if (folded.size) byDoc[docPath] = [...folded];
      else delete byDoc[docPath];
      remember(key, Object.keys(byDoc).length ? JSON.stringify(byDoc) : null);
    },
    true,
  );
  return () => {
    for (const details of container.querySelectorAll("details")) {
      if (folded.has(sectionOf(details))) details.open = false;
    }
  };
}

// The document and the outline fold separately: tidying the outline should not move the page.
const foldDocument = keepFolds(doc, "fathom-folded", (details) =>
  details.matches("details.section") ? details.querySelector(":scope > summary > [id]")?.id : undefined,
);
const foldOutline = keepFolds(document.getElementById("outline"), "fathom-outline-folded", (details) =>
  details.querySelector(":scope > summary > a")?.getAttribute("href").slice(1),
);

/** Opens the folded section around a link's target, since a browser cannot scroll to hidden content. */
function reveal(hash) {
  let target = null;
  try {
    target = document.getElementById(decodeURIComponent(hash.slice(1)));
  } catch {
    // Not a valid fragment.
  }
  const section = target?.closest("summary") ? null : target?.closest("details.section:not([open])");
  if (!section) return;
  section.open = true;
  target.scrollIntoView();
}

document.addEventListener("click", (event) => {
  const link = event.target.closest('a[href^="#"]');
  if (link) reveal(link.hash);
});
window.addEventListener("hashchange", () => reveal(location.hash));

const sidebar = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebar-toggle");
const resizer = document.getElementById("sidebar-resizer");
// Matches the stylesheet: a column beside the document when wide, a drawer over it when narrow.
const wide = window.matchMedia("(min-width: 901px)");

function markSidebar() {
  const shown = wide.matches ? root.dataset.sidebar !== "collapsed" : document.body.classList.contains("drawer-open");
  sidebarToggle?.setAttribute("aria-expanded", String(shown));
}

function setDrawer(open) {
  document.body.classList.toggle("drawer-open", open);
  markSidebar();
}

function setCollapsed(collapsed) {
  if (collapsed) root.dataset.sidebar = "collapsed";
  else delete root.dataset.sidebar;
  remember("fathom-sidebar", collapsed ? "collapsed" : null);
  markSidebar();
}

function toggleSidebar() {
  if (wide.matches) setCollapsed(root.dataset.sidebar !== "collapsed");
  else setDrawer(!document.body.classList.contains("drawer-open"));
}

sidebarToggle?.addEventListener("click", toggleSidebar);
document.getElementById("scrim")?.addEventListener("click", () => setDrawer(false));
sidebar?.addEventListener("click", (event) => {
  if (event.target.closest("a")) setDrawer(false);
});
wide.addEventListener("change", () => setDrawer(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setDrawer(false);
  const chord = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
  if (sidebar && chord && event.key.toLowerCase() === "b") {
    event.preventDefault();
    toggleSidebar();
  }
});
markSidebar();

const SIDEBAR_WIDTHS = { min: 180, max: 640, step: 16 };

function setSidebarWidth(px) {
  const width = Math.round(Math.min(SIDEBAR_WIDTHS.max, Math.max(SIDEBAR_WIDTHS.min, px)));
  root.style.setProperty("--sidebar-width", `${width}px`);
  remember("fathom-sidebar-width", String(width));
}

resizer?.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  resizer.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing");
});
resizer?.addEventListener("pointermove", (event) => {
  if (resizer.hasPointerCapture(event.pointerId)) setSidebarWidth(event.clientX);
});
resizer?.addEventListener("lostpointercapture", () => document.body.classList.remove("resizing"));
resizer?.addEventListener("dblclick", () => {
  root.style.removeProperty("--sidebar-width");
  remember("fathom-sidebar-width", null);
});
resizer?.addEventListener("keydown", (event) => {
  const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
  if (!direction) return;
  event.preventDefault();
  setSidebarWidth(sidebar.offsetWidth + direction * SIDEBAR_WIDTHS.step);
});

// The pick is kept per device: a phone and a laptop can differ, and "Auto"
// follows whatever the theme tool on the host has set.
const themeMenu = document.getElementById("theme-menu");

function markTheme() {
  const picked = root.dataset.theme ?? "";
  const choices = [...(themeMenu?.querySelectorAll(".theme-choice") ?? [])];
  const known = choices.some((c) => c.dataset.themeChoice === picked);
  for (const choice of choices) {
    choice.setAttribute("aria-checked", String(choice.dataset.themeChoice === (known ? picked : "")));
  }
}

function pickTheme(name) {
  if (name) root.dataset.theme = name;
  else delete root.dataset.theme;
  remember("fathom-theme", name || null);
  markTheme();
  recolorDiagrams();
}

// The menu stays open after a pick so several themes can be tried in a row.
themeMenu?.addEventListener("click", (event) => {
  const choice = event.target.closest(".theme-choice");
  if (choice) pickTheme(choice.dataset.themeChoice);
});
themeMenu?.addEventListener("toggle", (event) => {
  if (event.newState === "open") themeMenu.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: "nearest" });
});
markTheme();

/** The host's theme files changed: load the new stylesheet, then recolor. */
function reloadThemeCss() {
  const current = document.getElementById("theme-css");
  if (!current) return;
  const next = current.cloneNode();
  next.href = `/assets/theme.css?v=${Date.now()}`;
  next.addEventListener("load", () => {
    current.remove();
    recolorDiagrams();
  });
  current.after(next);
}

darkQuery.addEventListener("change", () => recolorDiagrams());

function decorate() {
  foldDocument();
  foldOutline();
  scanDiagrams();
  addCopyButtons();
  watchOutline();
}

async function refresh() {
  const response = await fetch(`/frag/${docPath}`, { cache: "no-store" });
  if (!response.ok) return;
  const view = await response.json();
  document.getElementById("files").innerHTML = view.files;
  if (view.version === doc.dataset.version) return;
  const scroll = window.scrollY;
  doc.dataset.version = view.version;
  doc.innerHTML = view.html;
  document.getElementById("outline").innerHTML = view.outline;
  document.title = view.title;
  decorate();
  window.scrollTo({ top: scroll });
}

const watching = Boolean(doc && docPath);
const events = new EventSource(watching ? `/events?path=${docPath}` : "/events");
events.addEventListener("theme", reloadThemeCss);

if (watching) {
  const live = document.getElementById("live");
  events.addEventListener("open", () => (live.hidden = false));
  events.addEventListener("error", () => (live.hidden = true));
  events.addEventListener("change", () => refresh().catch(console.error));
  // A phone that slept through an update catches up when it wakes.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh().catch(console.error);
  });
}

const filter = document.getElementById("filter");
filter?.addEventListener("input", () => {
  const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
  for (const task of document.querySelectorAll("#tasks .task")) {
    task.hidden = !words.every((w) => task.dataset.search.includes(w));
  }
});

decorate();
if (location.hash) reveal(location.hash);
