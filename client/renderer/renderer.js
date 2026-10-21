"use strict";

// ====================================================================== state

const ui = {
  library: [],
  filter: "all", // all | installed | available
  search: "",
  selectedId: null, // game whose page is open
  dlcId: null, // when set, the page open is this DLC of that game
  dlcMeta: {}, // dlc key -> description/facts for a DLC page
  meta: {}, // game id -> description/art/etc. from the main process
  space: {}, // game id -> disk-space check
  manuals: {}, // game id -> PDFs found for it
  live: {}, // game id -> { text, mode, pct } while a download/install is running
};

// ====================================================================== helpers

const $ = (id) => document.getElementById(id);

// Tiny DOM builder. Text always goes in as text, never as HTML, because much of
// what's shown (descriptions, names) comes from outside.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const ICONS = {
  download: '<path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14"/>',
  disk: '<rect x="3" y="6" width="18" height="12" rx="3"/><path d="M7 12h.01M11 12h6"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  dots: '<circle cx="12" cy="5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="19" r="1.4" fill="currentColor"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  warn: '<path d="M12 4l9.5 16h-19z"/><path d="M12 10v4.5M12 17.5h.01"/>',
};

function icon(name, size = 14) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "icon");
  svg.innerHTML = ICONS[name]; // fixed strings above, never user data
  return svg;
}

// Local file path -> a file:// URL that survives spaces and odd characters.
function toFileUrl(p) {
  const parts = String(p)
    .replace(/\\/g, "/")
    .split("/")
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)));
  return `file:///${parts.join("/").replace(/^\/+/, "")}`;
}

// A stable colour per game name, for games with no cover art.
function hueFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const findGame = (id) => ui.library.find((g) => g.id === id);

// ====================================================================== formatting

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const formatSize = (bytes) => (bytes > 0 ? formatBytes(bytes) : "—");

function formatSpeed(bytesPerSec) {
  const mb = bytesPerSec / 1024 ** 2;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB/s`;
}

function formatEta(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// Download progress line: how much, how fast, how long left.
function formatDownloadStatus({ receivedBytes = 0, totalBytes = 0, speedBps = 0, etaSec = null }) {
  let text = `Downloading… ${formatBytes(receivedBytes)}`;
  if (totalBytes > 0) text += ` / ${formatBytes(totalBytes)}`;
  text += speedBps > 0 ? ` · ${formatSpeed(speedBps)}` : " · starting…";
  if (etaSec != null && etaSec >= 0 && etaSec < 24 * 3600) text += ` · ${formatEta(etaSec)} left`;
  return text;
}

// Status line for an install in progress. There's no percentage because a
// silent installer doesn't report one; time and data written show it's alive.
function formatInstallStatus({ elapsedSec = 0, writtenBytes = 0, stalledSec = 0, mayNeedAdmin = false }) {
  const mm = Math.floor(elapsedSec / 60);
  const ss = String(elapsedSec % 60).padStart(2, "0");
  let text = `Installing… ${mm}:${ss}`;
  if (writtenBytes > 0) text += ` · ${formatBytes(writtenBytes)} written`;
  else if (mayNeedAdmin && elapsedSec < 45) text += " · approve the Windows admin prompt if one appears";
  if (stalledSec > 600) {
    text += " · no activity — check for a setup window";
  }
  return text;
}

function statusText(game) {
  const cs = game.clientState || {};
  if (cs.installed) return "Ready to play";
  if (cs.installMissing) return "Game files not found — install again to restore it";
  if (cs.downloaded) return "Downloaded — ready to install";
  return "Not installed";
}

// "≈ 3.0 GB" while it's only an estimate, exact once it's known.
function installSizeLabel(sizes) {
  if (!sizes || !(sizes.install > 0)) return "—";
  return `${sizes.installKind === "estimate" ? "≈ " : ""}${formatBytes(sizes.install)}`;
}

function installSizeNote(sizes) {
  if (!sizes) return "";
  if (sizes.installKind === "measured") return "Measured from an earlier install on this PC.";
  if (sizes.installKind === "set") return "Size given by whoever runs the library.";
  if (sizes.installKind === "portable") return "Same as the download: this game needs no installing.";
  return "Estimated from the download size. Becomes exact after the first install.";
}

// ====================================================================== live status
// While a download or install runs, its status line and progress bar must show
// up everywhere that game appears (its card and its page), and survive the page
// being rebuilt. So the state lives here and is pushed into every matching element.

const sel = (attr, id) => `[${attr}="${CSS.escape(id)}"]`;
const isBusy = (id) => !!ui.live[id];

function setLive(id, patch) {
  ui.live[id] = { mode: null, pct: 0, text: "", ...(ui.live[id] || {}), ...patch };
  applyLive(id);
}

function clearLive(id) {
  delete ui.live[id];
}

function applyLive(id) {
  const live = ui.live[id];
  document.querySelectorAll(sel("data-status", id)).forEach((node) => {
    if (live && live.text) {
      node.textContent = live.text;
      node.title = live.text; // the card clamps long lines; the full text is one hover away
    }
  });
  document.querySelectorAll(sel("data-progress", id)).forEach((fill) => {
    const wrap = fill.parentElement;
    wrap.classList.toggle("active", !!(live && live.mode));
    fill.classList.toggle("indeterminate", !!(live && live.mode === "indeterminate"));
    fill.style.width = live && live.mode === "determinate" ? `${Math.max(0, Math.min(100, live.pct))}%` : "";
  });
  document.querySelectorAll(sel("data-action-for", id)).forEach((btn) => {
    btn.disabled = !!live;
  });
}

function buildStatus(game) {
  const live = ui.live[game.id];
  const text = live && live.text ? live.text : statusText(game);
  return el("div", { class: "status", dataset: { status: game.id }, title: text, text });
}

function buildBar(game) {
  const fill = el("div", { class: "progress-fill", dataset: { progress: game.id } });
  const bar = el("div", { class: "progress-bar" }, fill);
  if (ui.live[game.id]) setTimeout(() => applyLive(game.id), 0); // once the node is in the document
  return bar;
}

// ====================================================================== actions

function buildActionButton(game, { large = false } = {}) {
  const installed = !!(game.clientState || {}).installed;
  const btn = el(
    "button",
    {
      type: "button",
      class: `btn ${installed ? "btn-play" : "btn-primary"}${large ? " btn-lg" : ""}`,
      dataset: { actionFor: game.id },
    },
    installed ? icon("play", large ? 16 : 13) : null,
    installed ? "Play" : "Install"
  );
  btn.disabled = isBusy(game.id);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (installed) playGame(game);
    else startInstall(game);
  });
  return btn;
}

async function playGame(game) {
  try {
    await window.api.playGame(game.id);
  } catch (err) {
    showError(err.message);
  }
}

// One button does the whole job: check there's room, download (files already
// fully downloaded are skipped and partial ones resume), then install, with no
// second click.
async function startInstall(game) {
  if (isBusy(game.id)) return;

  try {
    const space = await window.api.checkSpace(game.id);
    ui.space[game.id] = space;
    if (space && !space.ok) {
      const go = confirm(`${space.message}\n\nThe install may fail partway through. Install anyway?`);
      if (!go) {
        if (ui.selectedId === game.id) renderDetails();
        return;
      }
    }
  } catch {
    /* a failed space check shouldn't stop the install */
  }

  setLive(game.id, { text: "Starting…", mode: "determinate", pct: 0 });
  try {
    if (!game.files || game.files.length === 0) throw new Error("No files listed for this game.");

    // Nothing to install: download the game's folder and it's ready to play.
    if (game.portable) {
      setLive(game.id, { text: "Downloading\u2026", mode: "determinate", pct: 0 });
      await window.api.installPortable(game.id);
      clearLive(game.id);
      await loadLibrary({ quiet: true });
      return;
    }

    const installerFilename = (game.installers[0] || {}).filename;
    if (!installerFilename) throw new Error("No installer file listed for this game.");

    setLive(game.id, { text: "Downloading…", mode: "determinate", pct: 0 });
    await window.api.downloadGame(game.id, game.files);

    setLive(game.id, { text: "Installing… this can take a few minutes", mode: "indeterminate" });
    await window.api.installGame(game.id, installerFilename, game.name, {
      installArgs: game.installArgs,
      silent: game.silent,
    });
  } catch (err) {
    showError(err.message);
  }
  clearLive(game.id);
  await loadLibrary({ quiet: true }); // pick up whatever state the attempt left behind
}


// Installs one DLC on top of the installed game: downloads its files, then
// unpacks them into the game's folder.
async function startDlcInstall(game, dlc) {
  if (isBusy(game.id)) return;
  setLive(game.id, { text: `Downloading ${dlc.name}…`, mode: "determinate", pct: 0 });
  try {
    await window.api.installDlc(game.id, dlc.id);
  } catch (err) {
    showError(err.message);
  }
  clearLive(game.id);
  await loadLibrary({ quiet: true });
}

// A small picture for a DLC row: Steam's banner when known, else a tile with its first letter.
function dlcThumb(dlc) {
  const tile = el("div", { class: "dlc-thumb dlc-thumb-empty", text: (dlc.name || "?").trim().charAt(0).toUpperCase() });
  if (!dlc.thumb) return tile;
  const img = el("img", { class: "dlc-thumb", src: dlc.thumb, alt: "", loading: "lazy" });
  img.addEventListener("error", () => img.replaceWith(tile));
  return img;
}

// "Manuals": PDFs that came with the game. Clicking one opens it in a viewer window.
function buildManualsSection(game) {
  const list = ui.manuals[game.id] || [];
  if (!list.length) return null;
  const rows = list.map((m) => {
    const meta = el("div", {
      class: "dlc-meta",
      text: [m.size > 0 ? formatBytes(m.size) : null, m.source === "installed" ? "On this PC" : "On the server, downloads when opened"].filter(Boolean).join(" \u00b7 "),
    });
    const row = el(
      "button",
      {
        type: "button",
        class: "manual-row",
        title: `Open ${m.label}`,
        onClick: async () => {
          row.disabled = true;
          const old = meta.textContent;
          meta.textContent = "Opening\u2026";
          try {
            await window.api.openManual(game.id, m.source, m.key);
          } catch (err) {
            showError(err.message);
          } finally {
            row.disabled = false;
            meta.textContent = old;
          }
        },
      },
      el("div", { class: "manual-badge", text: "PDF" }),
      el("div", { class: "dlc-text" }, el("div", { class: "dlc-name", text: m.label }), meta)
    );
    return el("li", { class: "dlc-row manual-item" }, row);
  });
  return el("section", { class: "sizes-card manuals-card" }, el("h3", { text: "Manuals" }), el("ul", { class: "dlc-list manual-list" }, rows));
}

// The game page's DLC list. Only shown when the server has DLC for the game.
function buildDlcSection(game) {
  const list = game.dlc || [];
  if (!list.length) return null;
  const cs = game.clientState || {};
  const done = cs.dlcInstalled || {};
  const canInstall = !!cs.installed;

  const rows = list.map((dlc) => {
    const size = (dlc.files || []).reduce((sum, f) => sum + (f.size || 0), 0);
    const isDone = !!done[dlc.id];
    const button = isDone
      ? el("span", { class: "dlc-done" }, icon("check", 14), "Installed")
      : el("button", {
          type: "button",
          class: "btn btn-sm",
          text: "Install",
          title: canInstall ? `Download and install ${dlc.name}` : "Install the game first",
          disabled: !canInstall || isBusy(game.id),
          dataset: { actionFor: game.id },
          onClick: () => startDlcInstall(game, dlc),
        });
    return el(
      "li",
      { class: "dlc-row" },
      el(
        "button",
        { type: "button", class: "dlc-info dlc-link", title: `About ${dlc.name}`, onClick: () => openDlc(game, dlc) },
        dlcThumb(dlc),
        el(
          "div",
          { class: "dlc-text" },
          el("div", { class: "dlc-name", text: dlc.name }),
          el("div", { class: "dlc-meta", text: [dlc.version, size > 0 ? formatBytes(size) : null].filter(Boolean).join(" · ") })
        )
      ),
      button
    );
  });

  return el(
    "section",
    { class: "block dlc" },
    el("h3", { text: "Downloadable content" }),
    el("ul", { class: "dlc-list" }, rows),
    canInstall ? null : el("p", { class: "hint", text: "Install the game first, then add its DLC here." })
  );
}

function buildGameMenu(game) {
  const wrap = el("div", { class: "game-menu" });

  const menuBtn = el("button", { type: "button", class: "menu-btn", title: "More options", "aria-label": "More options" }, icon("dots", 18));
  const dropdown = el("div", { class: "menu-dropdown hidden" });

  const addItem = (label, onClick, danger = false) => {
    dropdown.append(
      el("button", {
        type: "button",
        class: danger ? "danger" : "",
        text: label,
        onClick: async (e) => {
          e.stopPropagation();
          closeAllMenus();
          await onClick();
        },
      })
    );
  };

  addItem("Open install folder", () => window.api.openInstallFolder(game.id));

  const asAdmin = !!(game.clientState || {}).runAsAdmin;
  addItem(asAdmin ? "Stop running as administrator" : "Always run as administrator", async () => {
    try {
      await window.api.setRunAsAdmin(game.id, !asAdmin);
      await loadLibrary({ quiet: true });
    } catch (err) {
      showError(err.message);
    }
  });

  addItem("Create desktop shortcut", async () => {
    try {
      await window.api.createShortcut(game.id, game.name);
    } catch (err) {
      showError(err.message);
    }
  });

  addItem(
    "Uninstall",
    async () => {
      if (!confirm(`Uninstall "${game.name}"? This deletes its installed files and desktop shortcut. You'll need to download it again to reinstall.`)) {
        return;
      }
      try {
        const res = await window.api.uninstallGame(game.id);
        if (res && res.leftOnDisk) {
          showError(
            `"${game.name}" was removed from your library, but its files are at ${res.leftOnDisk}, which is ` +
              "outside your current install folder, so I didn't delete them. If it came with its own " +
              "uninstaller, use Windows Settings \u2192 Apps to remove it.",
            "Removed from library"
          );
        }
        await loadLibrary({ quiet: true });
      } catch (err) {
        showError(err.message);
      }
    },
    true
  );

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = !dropdown.classList.contains("hidden");
    closeAllMenus();
    if (!wasOpen) dropdown.classList.remove("hidden");
  });

  wrap.append(menuBtn, dropdown);
  return wrap;
}

function closeAllMenus() {
  document.querySelectorAll(".menu-dropdown").forEach((node) => node.classList.add("hidden"));
}

// ====================================================================== library view

async function loadLibrary({ quiet = false } = {}) {
  const container = $("library");
  if (!quiet) {
    container.replaceChildren(el("p", { class: "message", text: "Loading library from server…" }));
    $("libraryMeta").textContent = "";
  }
  try {
    const result = await window.api.getLibrary();
    ui.library = result.games;
    renderLibrary();
    if (ui.selectedId) {
      if (findGame(ui.selectedId)) renderDetails();
      else closeDetails();
    }
  } catch (err) {
    ui.library = [];
    $("libraryMeta").textContent = "";
    container.replaceChildren(
      el(
        "div",
        { class: "message message-error" },
        el("strong", { text: "Couldn't reach the server." }),
        el("p", { text: "Check the server URL in Settings, and that the server is running." }),
        el("p", { class: "muted", text: err.message })
      )
    );
  }
}

function matchesFilter(game) {
  const installed = !!(game.clientState || {}).installed;
  if (ui.filter === "installed" && !installed) return false;
  if (ui.filter === "available" && installed) return false;
  const q = ui.search.trim().toLowerCase();
  return !q || game.name.toLowerCase().includes(q);
}

function renderLibrary() {
  const container = $("library");
  container.replaceChildren();

  const shown = ui.library.filter(matchesFilter);
  const installedCount = ui.library.filter((g) => (g.clientState || {}).installed).length;
  $("libraryMeta").textContent = ui.library.length
    ? `${shown.length === ui.library.length ? ui.library.length : `${shown.length} of ${ui.library.length}`} ${ui.library.length === 1 ? "game" : "games"} · ${installedCount} installed`
    : "";

  if (!ui.library.length) {
    container.append(
      el(
        "div",
        { class: "message" },
        el("strong", { text: "No games found on the server yet." }),
        el("p", { class: "muted", text: "Add a folder containing an installer to the server's library folder, then refresh." })
      )
    );
    return;
  }
  if (!shown.length) {
    container.append(el("div", { class: "message" }, el("strong", { text: "No games match." })));
    return;
  }
  shown.forEach((game) => container.append(buildCard(game)));
}

// What you download, and what it takes on disk, as two labelled rows.
function buildSizeList(game) {
  const sizes = game.sizes;
  if (!sizes || !(sizes.download > 0 || sizes.install > 0)) return null;
  const installed = !!(game.clientState || {}).installed;
  const item = (iconName, label, value, title) =>
    el("div", { class: "size-item", title }, el("span", { class: "k" }, icon(iconName, 13), label), el("span", { class: "v", text: value }));

  const items = [];
  if (!installed && sizes.download > 0) items.push(item("download", "Download", formatBytes(sizes.download), "Download size"));
  items.push(
    item(
      "disk",
      installed ? "On disk" : "Installed",
      installSizeLabel(sizes),
      `${installed ? "Size on disk" : "Space on disk once installed"}. ${installSizeNote(sizes)}`
    )
  );
  return el("div", { class: "size-list" }, items);
}

function buildCard(game) {
  const cs = game.clientState || {};
  const open = () => openDetails(game.id);

  const cover = el("div", { class: "cover" });
  if (game.cover) {
    cover.style.backgroundImage = `url("${toFileUrl(game.cover)}")`;
  } else {
    cover.classList.add("no-art");
    cover.style.setProperty("--hue", hueFor(game.name));
    const fallback = el("span", { class: "fallback-title", text: game.name });
    fallback.style.fontSize = game.name.length > 45 ? "14px" : game.name.length > 26 ? "17px" : "20px"; // long names must still fit
    cover.append(fallback);
  }
  if (cs.installed) cover.append(el("span", { class: "state-badge" }, icon("check", 12), "Installed"));

  const titleRow = el("div", { class: "title-row" }, el("div", { class: "title", text: game.name }));
  if (cs.installed) titleRow.append(buildGameMenu(game));

  return el(
    "article",
    {
      class: `card${cs.installed ? " is-installed" : ""}`,
      tabindex: "0",
      role: "button",
      "aria-label": `${game.name}: open details`,
      dataset: { gameId: game.id },
      onClick: open,
      onKeydown: (e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          open();
        }
      },
    },
    cover,
    el("div", { class: "info" }, titleRow, buildStatus(game), buildSizeList(game), buildBar(game), buildActionButton(game))
  );
}

// ====================================================================== game page

async function openDetails(id) {
  const game = findGame(id);
  if (!game) return;
  ui.selectedId = id;
  ui.dlcId = null;
  $("detailsOverlay").classList.remove("hidden");
  document.body.classList.add("no-scroll");
  renderDetails();
  $("details").scrollTop = 0;

  if (!ui.meta[id]) loadDetails(id);
  loadManuals(id);
  window.api
    .checkSpace(id)
    .then((space) => {
      ui.space[id] = space;
    })
    .catch(() => {})
    .finally(() => {
      if (ui.selectedId === id) renderDetails();
    });
}

// The game's manuals (PDFs in its folder or on the server); the page shows them when they arrive.
function loadManuals(id) {
  window.api
    .listManuals(id)
    .then((list) => {
      ui.manuals[id] = list || [];
    })
    .catch(() => {
      ui.manuals[id] = [];
    })
    .finally(() => {
      if (ui.selectedId === id && !ui.dlcId) renderDetails();
    });
}

// Fetches a game's description/art (cached by the app) and redraws its page when it arrives.
function loadDetails(id) {
  window.api
    .getDetails(id)
    .then((meta) => {
      ui.meta[id] = meta;
    })
    .catch(() => {
      ui.meta[id] = { failed: true, sources: [], genres: [], developers: [], publishers: [], screenshots: [], choice: {} };
    })
    .finally(() => {
      if (ui.selectedId === id) renderDetails();
    });
}

function closeDetails() {
  ui.selectedId = null;
  ui.dlcId = null;
  $("detailsOverlay").classList.add("hidden");
  document.body.classList.remove("no-scroll");
  $("details").replaceChildren();
}

function renderDetails() {
  const game = findGame(ui.selectedId);
  if (!game) return;
  const panel = $("details");
  const scrollTop = panel.scrollTop;
  const dlc = ui.dlcId ? (game.dlc || []).find((d) => d.id === ui.dlcId) : null;
  if (ui.dlcId && !dlc) ui.dlcId = null; // it's gone from the server: back to the game's page
  panel.replaceChildren(
    dlc
      ? buildDlcPage(game, dlc, ui.dlcMeta[dlcKey(game.id, dlc.id)] || null)
      : buildDetails(game, ui.meta[game.id] || null, ui.space[game.id] || null)
  );
  panel.scrollTop = scrollTop;
}

function buildHero(game, meta) {
  const bg = el("div", { class: "hero-bg" });
  if (meta && meta.hero) {
    bg.style.backgroundImage = `url("${toFileUrl(meta.hero)}")`;
  } else if (game.cover) {
    bg.classList.add("from-cover"); // no banner art: a blurred, enlarged cover instead
    bg.style.backgroundImage = `url("${toFileUrl(game.cover)}")`;
  } else {
    bg.classList.add("plain");
    bg.style.setProperty("--hue", hueFor(game.name));
  }

  const cs = game.clientState || {};
  const title =
    meta && meta.logo
      ? el("img", { class: "hero-logo", src: toFileUrl(meta.logo), alt: game.name })
      : el("h2", { class: "hero-title", text: game.name });

  const subParts = [];
  if (meta && meta.developers && meta.developers.length) subParts.push(meta.developers.join(", "));
  const year = meta && meta.releaseDate ? (/\b(19|20)\d{2}\b/.exec(meta.releaseDate) || [])[0] : null;
  if (year) subParts.push(year);
  if (meta && meta.genres && meta.genres.length) subParts.push(meta.genres.slice(0, 3).join(" / "));

  const actions = el("div", { class: "hero-actions" }, buildActionButton(game, { large: true }));
  if (cs.installed) actions.append(buildGameMenu(game));

  return el(
    "section",
    { class: "hero" },
    el("div", { class: "hero-bgwrap" }, bg, el("div", { class: "hero-fade" })), // clips the blurred art, not the menu
    el(
      "div",
      { class: "hero-content" },
      title,
      subParts.length ? el("div", { class: "hero-sub", text: subParts.join("  ·  ") }) : null,
      actions,
      el("div", { class: "hero-progress" }, buildStatus(game), buildBar(game))
    )
  );
}

function buildAbout(game, meta, { onFix } = {}) {
  const loading = !meta;
  if (loading) {
    return el(
      "div",
      { class: "skeleton", "aria-label": "Loading game info" },
      el("div", { class: "sk-line w90" }),
      el("div", { class: "sk-line w80" }),
      el("div", { class: "sk-line w60" })
    );
  }

  const block = el("div", { class: "about" });
  if (meta.summary) block.append(el("p", { class: "lead", text: meta.summary }));
  if (meta.description) {
    const text = el("p", { class: "long clamped", text: meta.description });
    block.append(text);
    if (meta.description.length > 360 || meta.description.split("\n").length > 4) {
      const toggle = el("button", { type: "button", class: "link-btn", text: "Show more" });
      toggle.addEventListener("click", () => {
        const open = text.classList.toggle("clamped");
        toggle.textContent = open ? "Show more" : "Show less";
      });
      block.append(toggle);
    }
  }
  if (!meta.summary && !meta.description) {
    block.append(
      el("p", { class: "muted", text: "No description is available for this game." }),
      el("button", { type: "button", class: "link-btn", text: "Find the right game…", onClick: onFix || (() => openMatch(game.id)) })
    );
  }
  return block;
}

function buildScreenshots(meta) {
  if (!meta || !meta.screenshots || !meta.screenshots.length) return null;
  return el(
    "section",
    { class: "block" },
    el("h3", { text: "Screenshots" }),
    el(
      "div",
      { class: "screens" },
      meta.screenshots.map((s) =>
        el(
          "button",
          { type: "button", class: "shot", "aria-label": "View screenshot", onClick: () => openLightbox(s.full) },
          el("img", { src: s.thumb, alt: "", loading: "lazy" })
        )
      )
    )
  );
}

function buildFacts(game, meta) {
  const rows = [];
  const add = (label, value) => {
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) return;
    rows.push(el("div", { class: "fact" }, el("dt", { text: label }), el("dd", {}, value)));
  };
  if (meta) {
    add("Developer", meta.developers && meta.developers.join(", "));
    add("Publisher", meta.publishers && meta.publishers.join(", "));
    add("Released", meta.releaseDate);
    add(
      "Genres",
      meta.genres && meta.genres.length
        ? el("span", { class: "tags" }, meta.genres.map((g) => el("span", { class: "tag", text: g })))
        : null
    );
    if (meta.score != null) {
      const tier = meta.score >= 75 ? "good" : meta.score >= 50 ? "mixed" : "bad";
      add("Metacritic", el("span", { class: `score score-${tier}`, text: String(meta.score) }));
    }
  }
  add("Version", game.version);
  return rows.length ? el("dl", { class: "facts" }, rows) : null;
}

function buildSizesCard(game, space) {
  const sizes = game.sizes || {};
  const installed = !!(game.clientState || {}).installed;
  const rows = [];
  const row = (label, value, note) =>
    rows.push(
      el("div", { class: "size-row" }, el("span", { class: "size-label", text: label }), el("span", { class: "size-value", title: note || "" }, value))
    );

  if (!installed) row("Download", formatSize(sizes.download), "Exact: the total size of the game's files on the server.");
  row(installed ? "Size on disk" : "Installed size", installSizeLabel(sizes), installSizeNote(sizes));
  if (!installed && sizes.needed > 0) {
    row("Space needed", `${sizes.installKind === "estimate" ? "≈ " : ""}${formatBytes(sizes.needed)}`, "Download plus installed game: both exist while it installs. The installer files are deleted afterwards.");
  }

  const card = el("section", { class: "sizes-card" }, el("h3", { text: "Storage" }), rows);
  if (!installed && sizes.installKind === "estimate") {
    card.append(el("p", { class: "hint", text: "Installed size is an estimate until the game has been installed once." }));
  }
  if (!installed && space) {
    // Which drive each free-space figure is about matters: games and downloads can be on different ones.
    const shared = space.downloadsDrive === space.installDrive;
    const free = [];
    if (space.installFree != null) {
      free.push(`${space.installDrive} ${formatBytes(space.installFree)} free${shared ? "" : " for the game"}`);
    }
    if (!shared && space.downloadsFree != null) {
      free.push(`${space.downloadsDrive} ${formatBytes(space.downloadsFree)} free for downloads`);
    }
    if (free.length) card.append(el("div", { class: "free" }, free.map((line) => el("div", { text: line }))));
    if (!space.ok && space.message) {
      card.append(el("div", { class: "warning" }, icon("warn", 16), el("span", { text: space.message })));
    }
  }
  return card;
}

// Where the info came from, plus the two ways to correct it: pick a different match, or look it up again.
function buildInfoFooter(game, meta) {
  if (!meta) return null;
  const wrap = el("div", { class: "info-footer" });

  const parts = [];
  if (meta.sources.includes("steam")) parts.push("Info from Steam");
  if (meta.sources.includes("steamgriddb")) parts.push("art from SteamGridDB");
  if (meta.sources.includes("game.json")) parts.push("details added by the library owner");
  if (parts.length) {
    const line = parts.join(" · ");
    wrap.append(el("p", { class: "credits", text: line.charAt(0).toUpperCase() + line.slice(1) }));
  }

  const norm = (str) => String(str || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (meta.steamName && norm(meta.steamName) !== norm(game.name)) {
    wrap.append(
      el(
        "p",
        { class: "credits credits-match" },
        `Matched on Steam as “${meta.steamName}”. `,
        el("button", { type: "button", class: "link-btn inline", text: "Not right?", onClick: () => openMatch(game.id) })
      )
    );
  }

  wrap.append(
    el(
      "div",
      { class: "info-actions" },
      el("button", { type: "button", class: "link-btn", text: "Wrong info? Fix match…", onClick: () => openMatch(game.id) }),
      el("span", { class: "dot", "aria-hidden": "true", text: "·" }),
      el("button", { type: "button", class: "link-btn", text: "Refresh info", onClick: (e) => refreshInfo(game, e.currentTarget) }),
      el("span", { class: "dot", "aria-hidden": "true", text: "·" }),
      el("button", { type: "button", class: "link-btn", text: "Change cover…", onClick: () => openArtPicker(game) }),
      game.hasCustomCover
        ? el("button", {
            type: "button",
            class: "link-btn",
            text: "Use default cover",
            onClick: async () => {
              try {
                await window.api.resetCover(game.id);
                await loadLibrary({ quiet: true });
              } catch (err) {
                showError(err.message);
              }
            },
          })
        : null
    )
  );
  return wrap;
}

function buildDetails(game, meta, space) {
  return el(
    "div",
    { class: "details-inner" },
    el("button", { type: "button", class: "details-close", "aria-label": "Close", title: "Close (Esc)", onClick: closeDetails }, icon("close", 18)),
    buildHero(game, meta),
    el(
      "div",
      { class: "details-body" },
      el("div", { class: "details-main" }, buildAbout(game, meta), buildDlcSection(game), buildScreenshots(meta)),
      el("aside", { class: "details-side" }, buildSizesCard(game, space), buildManualsSection(game), buildFacts(game, meta), buildInfoFooter(game, meta))
    )
  );
}


// ====================================================================== DLC pages

const dlcKey = (gameId, dlcId) => `${gameId}--dlc--${dlcId}`;

function openDlc(game, dlc) {
  ui.dlcId = dlc.id;
  renderDetails();
  $("details").scrollTop = 0;
  if (!ui.dlcMeta[dlcKey(game.id, dlc.id)]) loadDlcDetails(game.id, dlc.id);
}

function closeDlc() {
  ui.dlcId = null;
  renderDetails();
  $("details").scrollTop = 0;
}

function loadDlcDetails(gameId, dlcId, force = false) {
  const key = dlcKey(gameId, dlcId);
  return window.api
    .getDlcDetails(gameId, dlcId, force)
    .then((meta) => {
      ui.dlcMeta[key] = meta;
    })
    .catch(() => {
      ui.dlcMeta[key] = { failed: true, sources: [], genres: [], developers: [], publishers: [], screenshots: [] };
    })
    .finally(() => {
      if (ui.selectedId === gameId && ui.dlcId === dlcId) renderDetails();
    });
}

// Shows progress text while the game is downloading/installing something; nothing
// otherwise (the game's own status line, "Ready to play", would be misleading here).
function buildDlcStatus(game) {
  const live = ui.live[game.id];
  const text = live && live.text ? live.text : "";
  return el("div", { class: "status", dataset: { status: game.id }, title: text, text });
}

// A DLC's page: the same layout as the game's, with the base game's banner
// behind it and the DLC's own description, screenshots and facts.
function buildDlcPage(game, dlc, meta) {
  const parentMeta = ui.meta[game.id] || null;
  const cs = game.clientState || {};
  const isDone = !!(cs.dlcInstalled || {})[dlc.id];
  const canInstall = !!cs.installed;
  const size = (dlc.files || []).reduce((sum, f) => sum + (f.size || 0), 0);

  const bg = el("div", { class: "hero-bg" });
  if (parentMeta && parentMeta.hero) {
    bg.style.backgroundImage = `url("${toFileUrl(parentMeta.hero)}")`;
  } else if (game.cover) {
    bg.classList.add("from-cover");
    bg.style.backgroundImage = `url("${toFileUrl(game.cover)}")`;
  } else {
    bg.classList.add("plain");
    bg.style.setProperty("--hue", hueFor(game.name));
  }

  const subParts = [];
  if (meta && meta.developers && meta.developers.length) subParts.push(meta.developers.join(", "));
  const year = meta && meta.releaseDate ? (/\b(19|20)\d{2}\b/.exec(meta.releaseDate) || [])[0] : null;
  if (year) subParts.push(year);
  subParts.push("DLC for " + game.name);

  const installBtn = isDone
    ? el("span", { class: "dlc-done dlc-done-lg" }, icon("check", 16), "Installed")
    : el("button", {
        type: "button",
        class: "btn btn-primary btn-lg",
        text: "Install",
        title: canInstall ? `Download and install ${dlc.name}` : "Install the game first",
        disabled: !canInstall || isBusy(game.id),
        dataset: { actionFor: game.id },
        onClick: () => startDlcInstall(game, dlc),
      });

  const hero = el(
    "section",
    { class: "hero" },
    el("div", { class: "hero-bgwrap" }, bg, el("div", { class: "hero-fade" })),
    el(
      "div",
      { class: "hero-content" },
      el("button", { type: "button", class: "link-btn dlc-back", text: `\u2190 ${game.name}`, onClick: closeDlc }),
      el("h2", { class: "hero-title", text: dlc.name }),
      el("div", { class: "hero-sub", text: subParts.join("  \u00b7  ") }),
      el("div", { class: "hero-actions" }, installBtn),
      el("div", { class: "hero-progress" }, buildDlcStatus(game), buildBar(game))
    )
  );

  const facts = buildFacts({ version: dlc.version }, meta) || el("dl", { class: "facts" });
  if (size > 0) facts.append(el("div", { class: "fact" }, el("dt", { text: "Download" }), el("dd", { text: formatBytes(size) })));

  const footer = el("div", { class: "info-footer" });
  if (meta && meta.sources && meta.sources.includes("steam")) {
    footer.append(el("p", { class: "credits", text: "Info from Steam" }));
  }
  const norm = (str) => String(str || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (meta && meta.steamName && norm(meta.steamName) !== norm(`${game.name} ${dlc.name}`)) {
    footer.append(
      el(
        "p",
        { class: "credits credits-match" },
        `Matched on Steam as \u201c${meta.steamName}\u201d. `,
        el("button", { type: "button", class: "link-btn inline", text: "Not right?", onClick: () => openDlcMatch(game, dlc) })
      )
    );
  }
  footer.append(
    el(
      "div",
      { class: "info-actions" },
      el("button", { type: "button", class: "link-btn", text: "Wrong info? Fix match\u2026", onClick: () => openDlcMatch(game, dlc) }),
      el("span", { class: "dot", "aria-hidden": "true", text: "\u00b7" }),
      el("button", {
        type: "button",
        class: "link-btn",
        text: "Refresh info",
        onClick: (e) => {
          e.currentTarget.disabled = true;
          e.currentTarget.textContent = "Refreshing\u2026";
          loadDlcDetails(game.id, dlc.id, true);
        },
      })
    )
  );

  return el(
    "div",
    { class: "details-inner" },
    el("button", { type: "button", class: "details-close", "aria-label": "Close", title: "Close (Esc)", onClick: closeDetails }, icon("close", 18)),
    hero,
    el(
      "div",
      { class: "details-body" },
      el("div", { class: "details-main" }, buildAbout(game, meta, { onFix: () => openDlcMatch(game, dlc) }), buildScreenshots(meta)),
      el("aside", { class: "details-side" }, facts, footer)
    )
  );
}

function openLightbox(url) {
  if (!/^https:\/\//i.test(url)) return;
  const box = $("lightbox");
  box.querySelector("img").src = url;
  box.classList.remove("hidden");
}

function closeLightbox() {
  const box = $("lightbox");
  box.classList.add("hidden");
  box.querySelector("img").removeAttribute("src");
}

// ====================================================================== dialogs

// The main process puts technical text behind this marker (see lib/errors.js).
const DETAILS_MARKER = "\n\n[[details]]\n";

// Electron prefixes errors from the main process with "Error invoking remote method ...";
// that means nothing to a player. Splits what's left into a summary and technical details.
function cleanError(message) {
  let text = String(message || "Something went wrong.").replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, "");
  let summary = text;
  let details = "";
  const i = text.indexOf(DETAILS_MARKER);
  if (i !== -1) {
    summary = text.slice(0, i);
    details = text.slice(i + DETAILS_MARKER.length);
  }
  summary = summary.trim();
  details = details.trim();
  // An unexpected error that arrives as one long blob: don't make the player read it.
  if (!details && summary.length > 300) {
    details = summary;
    summary = "The launcher ran into an unexpected problem. The technical details below may help.";
  }
  return { summary, details };
}

function showError(message, title) {
  const { summary, details } = cleanError(message);
  $("errorTitle").textContent = title || "Something went wrong";
  $("errorSummary").textContent = summary;
  $("errorText").textContent = details;
  $("errorDetails").classList.toggle("hidden", !details);
  $("errorDetails").open = false;
  $("copyError").textContent = "Copy";
  $("errorModal").classList.remove("hidden");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el("textarea", { class: "offscreen", "aria-hidden": "true" });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      /* nothing more to try */
    }
    area.remove();
    return ok;
  }
}


// ====================================================================== choosing a cover
// Covers from SteamGridDB, or a picture from this PC. Whatever is chosen is kept
// as this game's cover until "Use default cover" is clicked.

const artUi = { gameId: null, seq: 0 };

async function pickCoverFromFile(gameId) {
  try {
    const res = await window.api.chooseCover(gameId);
    if (res && res.ok) {
      closeArtPicker();
      await loadLibrary({ quiet: true });
    }
  } catch (err) {
    showError(err.message);
  }
}

function closeArtPicker() {
  artUi.seq++;
  $("artModal").classList.add("hidden");
}

async function openArtPicker(game) {
  const seq = ++artUi.seq;
  artUi.gameId = game.id;
  $("artTitle").textContent = `Choose a cover for \u201c${game.name}\u201d`;
  $("artStatus").textContent = "Loading covers\u2026";
  $("artGrid").replaceChildren();
  $("artFile").onclick = () => pickCoverFromFile(game.id);
  $("artModal").classList.remove("hidden");

  let res;
  try {
    res = await window.api.listCovers(game.id);
  } catch {
    if (seq === artUi.seq) $("artStatus").textContent = "Couldn't reach SteamGridDB. Check your internet connection, or use a picture from this PC.";
    return;
  }
  if (seq !== artUi.seq) return;

  if (res.needsKey) {
    $("artStatus").textContent = "Add a SteamGridDB API key in Settings to browse covers, or use a picture from this PC.";
    return;
  }
  if (res.disabled) {
    $("artStatus").textContent = "SteamGridDB art is turned off for this game (see Fix match \u2192 Cover & banner art).";
    return;
  }
  if (!res.grids.length) {
    $("artStatus").textContent = "SteamGridDB has no covers for this game. If it matched the wrong game, use Fix match \u2192 Cover & banner art.";
    return;
  }
  $("artStatus").textContent = `${res.grids.length} cover${res.grids.length === 1 ? "" : "s"} \u2014 click one to use it:`;
  $("artGrid").replaceChildren(
    ...res.grids.map((g) =>
      el(
        "button",
        {
          type: "button",
          class: "art-item",
          title: [g.style, g.width && g.height ? `${g.width}\u00d7${g.height}` : null, g.author ? `by ${g.author}` : null].filter(Boolean).join(" \u00b7 "),
          onClick: (e) => chooseOnlineCover(game.id, g.url, e.currentTarget),
        },
        el("img", { src: g.thumb, alt: "", loading: "lazy" }),
        g.author ? el("span", { class: "art-meta", text: `by ${g.author}` }) : null
      )
    )
  );
}

async function chooseOnlineCover(gameId, url, button) {
  const buttons = document.querySelectorAll("#artGrid .art-item");
  buttons.forEach((b) => (b.disabled = true));
  $("artStatus").textContent = "Downloading\u2026";
  try {
    await window.api.chooseOnlineCover(gameId, url);
  } catch (err) {
    buttons.forEach((b) => (b.disabled = false));
    $("artStatus").textContent = "Couldn't download that cover. Try another one.";
    return;
  }
  closeArtPicker();
  await loadLibrary({ quiet: true });
}

// ====================================================================== fixing a wrong match
// Picking the right Steam game (description, screenshots) or the right SteamGridDB
// game (cover, banner, logo) from a search list. The choice is remembered by the app.

const matchUi = { gameId: null, dlcId: null, source: "steam", results: [], loading: false, error: null, needsKey: false, seq: 0 };

function openMatch(gameId, source = "steam") {
  const game = findGame(gameId);
  if (!game) return;
  matchUi.gameId = gameId;
  matchUi.dlcId = null;
  matchUi.source = source;
  $("matchTabs").classList.remove("hidden");
  $("matchTitle").textContent = `Fix info for “${game.name}”`;
  $("matchTerm").value = game.name;
  $("matchModal").classList.remove("hidden");
  runMatchSearch();
  $("matchTerm").focus();
  $("matchTerm").select();
}


// The same screen, for a DLC's description and screenshots (Steam only: a DLC has no art of its own).
function openDlcMatch(game, dlc) {
  matchUi.gameId = game.id;
  matchUi.dlcId = dlc.id;
  matchUi.source = "steam";
  $("matchTabs").classList.add("hidden");
  $("matchTitle").textContent = `Fix info for \u201c${dlc.name}\u201d`;
  $("matchTerm").value = dlc.name; // Steam finds DLC best by their own name; edit it to refine
  $("matchModal").classList.remove("hidden");
  runMatchSearch();
  $("matchTerm").focus();
  $("matchTerm").select();
}

function closeMatch() {
  matchUi.seq++; // a search still on its way must not redraw a closed dialog
  $("matchModal").classList.add("hidden");
}

async function runMatchSearch() {
  const seq = ++matchUi.seq;
  Object.assign(matchUi, { results: [], loading: true, error: null, needsKey: false });
  renderMatch();
  try {
    const res = await window.api.searchMatches(matchUi.gameId, matchUi.source, $("matchTerm").value.trim(), matchUi.dlcId);
    if (seq !== matchUi.seq) return;
    matchUi.results = res.results || [];
    matchUi.needsKey = !!res.needsKey;
  } catch {
    if (seq !== matchUi.seq) return;
    matchUi.error = "Couldn't search. Check your internet connection and try again.";
  }
  matchUi.loading = false;
  renderMatch();
}

function renderMatch() {
  const isSteam = matchUi.source === "steam";
  const isDlc = !!matchUi.dlcId;
  const meta = isDlc ? ui.dlcMeta[dlcKey(matchUi.gameId, matchUi.dlcId)] : ui.meta[matchUi.gameId];
  document.querySelectorAll("#matchTabs button").forEach((b) => {
    const on = b.dataset.source === matchUi.source;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });

  let text = "Pick the right game:";
  if (matchUi.loading) text = "Searching…";
  else if (matchUi.needsKey) text = "Add a SteamGridDB API key in Settings to choose artwork.";
  else if (matchUi.error) text = matchUi.error;
  else if (!matchUi.results.length) text = "No results. Try a different name.";
  $("matchStatus").textContent = text;

  const currentId = meta ? (isSteam ? meta.steamAppId : meta.sgdbId) : null;
  const list = $("matchResults");
  list.replaceChildren(
    ...matchUi.results.map((r) => {
      const current = r.id === currentId;
      return el(
        "li",
        {},
        el(
          "button",
          { type: "button", class: `match-row${current ? " current" : ""}`, onClick: () => applyMatch(r.id) },
          r.image ? el("img", { src: r.image, alt: "", loading: "lazy" }) : el("span", { class: "match-thumb-empty" }),
          el("span", { class: "match-name" }, r.name, r.detail ? el("span", { class: "match-detail", text: r.detail }) : null),
          current ? el("span", { class: "pill", text: "Current" }) : null
        )
      );
    })
  );

  const choice = meta && meta.choice ? meta.choice[isSteam ? "steam" : "sgdb"] : "auto";
  $("matchNone").textContent = isDlc
    ? "This DLC isn't on Steam: show no Steam info"
    : isSteam
      ? "This game isn't on Steam: show no Steam info"
      : "Use no artwork for this game";
  $("matchNone").classList.toggle("hidden", choice === "none");
  $("matchAuto").classList.toggle("hidden", choice === "auto" || choice === undefined);
}

// choice: a game id from the list, "none", or "auto".
async function applyMatch(choice) {
  const { gameId, dlcId, source } = matchUi;
  try {
    if (dlcId) await window.api.chooseDlcMatch(gameId, dlcId, choice);
    else await window.api.chooseMatch(gameId, source, choice);
  } catch (err) {
    showError(err.message);
    return;
  }
  closeMatch();
  if (dlcId) {
    delete ui.dlcMeta[dlcKey(gameId, dlcId)];
    if (ui.selectedId === gameId && ui.dlcId === dlcId) renderDetails(); // shows the loading state
    loadDlcDetails(gameId, dlcId);
    return;
  }
  delete ui.meta[gameId];
  await loadLibrary({ quiet: true }); // the cover on the card may have changed too
  if (ui.selectedId === gameId) loadDetails(gameId);
}

async function refreshInfo(game, button) {
  if (button) {
    button.disabled = true;
    button.textContent = "Refreshing…";
  }
  try {
    await window.api.refreshInfo(game.id);
  } catch (err) {
    showError(err.message);
  }
  delete ui.meta[game.id];
  await loadLibrary({ quiet: true });
  if (ui.selectedId === game.id) loadDetails(game.id);
}

function wireSettingsModal() {
  const modal = $("settingsModal");
  const openBtn = $("settingsBtn");
  const closeBtn = $("closeSettings");
  const saveBtn = $("saveSettings");
  const chooseBtn = $("chooseInstallRoot");

  openBtn.onclick = async () => {
    const config = await window.api.getConfig();
    $("serverUrl").value = config.serverUrl || "";
    $("steamGridDbApiKey").value = config.steamGridDbApiKey || "";
    $("innoExtractPath").value = config.innoExtractPath || "";
    $("installRoot").value = config.installRoot || "";
    modal.classList.remove("hidden");

    const status = await window.api.innoExtractStatus();
    $("innoExtractStatus").textContent = status.bundled
      ? "Using the one that came with the launcher."
      : "The launcher's own copy wasn't found. Enter a path to one, or reinstall the launcher.";
  };

  closeBtn.onclick = () => modal.classList.add("hidden");

  chooseBtn.onclick = async () => {
    const dir = await window.api.chooseInstallRoot();
    $("installRoot").value = dir;
  };

  $("openDownloads").onclick = () => window.api.openDownloadsFolder();

  $("clearMetadata").onclick = async () => {
    if (!confirm("Forget all game info looked up from Steam and SteamGridDB (descriptions, banners, logos, DLC names and automatic covers) and look it up again? Matches you fixed and covers you picked yourself are kept.")) {
      return;
    }
    await window.api.clearMetadata();
    ui.meta = {};
    ui.dlcMeta = {};
    modal.classList.add("hidden");
    await loadLibrary();
  };

  $("clearDownloads").onclick = async () => {
    if (!confirm("Delete all downloaded installer files? Installers are normally removed automatically after a successful install, so this only clears leftovers from interrupted or failed installs. Installed games are not affected.")) {
      return;
    }
    await window.api.clearDownloads();
    modal.classList.add("hidden");
    await loadLibrary();
  };

  saveBtn.onclick = async () => {
    await window.api.setConfig({
      serverUrl: $("serverUrl").value.trim(),
      steamGridDbApiKey: $("steamGridDbApiKey").value.trim(),
      innoExtractPath: $("innoExtractPath").value.trim(),
      installRoot: $("installRoot").value.trim(),
    });
    modal.classList.add("hidden");
    ui.meta = {}; // the SteamGridDB key may have changed what art is available
    await loadLibrary();
  };
}

// ====================================================================== start-up

function init() {
  wireSettingsModal();

  $("refreshBtn").onclick = () => {
    ui.meta = {};
    ui.space = {};
    loadLibrary();
  };
  let libraryChangeTimer = null;
  window.api.onLibraryChanged(() => {
    clearTimeout(libraryChangeTimer);
    libraryChangeTimer = setTimeout(() => loadLibrary({ quiet: true }), 800); // DLC names arrive in bursts
  });
  $("closeError").onclick = () => $("errorModal").classList.add("hidden");
  $("copyError").onclick = async () => {
    const ok = await copyText($("errorText").textContent);
    $("copyError").textContent = ok ? "Copied" : "Couldn't copy";
  };

  $("matchTabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-source]");
    if (!btn || btn.dataset.source === matchUi.source) return;
    matchUi.source = btn.dataset.source;
    runMatchSearch();
  });
  $("matchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    runMatchSearch();
  });
  $("matchNone").onclick = () => applyMatch("none");
  $("matchAuto").onclick = () => applyMatch("auto");
  $("matchClose").onclick = closeMatch;
  $("artClose").onclick = closeArtPicker;
  $("artModal").addEventListener("click", (e) => {
    if (e.target === $("artModal")) closeArtPicker();
  });
  $("matchModal").addEventListener("click", (e) => {
    if (e.target === $("matchModal")) closeMatch();
  });

  $("search").addEventListener("input", (e) => {
    ui.search = e.target.value;
    renderLibrary();
  });
  $("filters").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-filter]");
    if (!btn) return;
    ui.filter = btn.dataset.filter;
    document.querySelectorAll("#filters button").forEach((b) => b.classList.toggle("active", b === btn));
    renderLibrary();
  });

  // Clicking the dimmed area around the game page, or the screenshot, closes it.
  $("detailsOverlay").addEventListener("click", (e) => {
    if (e.target === $("detailsOverlay")) closeDetails();
  });
  $("lightbox").addEventListener("click", closeLightbox);

  document.addEventListener("click", closeAllMenus);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("lightbox").classList.contains("hidden")) closeLightbox();
    else if (!$("artModal").classList.contains("hidden")) closeArtPicker();
    else if (!$("matchModal").classList.contains("hidden")) closeMatch();
    else if (!$("errorModal").classList.contains("hidden")) $("errorModal").classList.add("hidden");
    else if (!$("settingsModal").classList.contains("hidden")) $("settingsModal").classList.add("hidden");
    else if (ui.selectedId && ui.dlcId) closeDlc();
    else if (ui.selectedId) closeDetails();
  });

  // Progress for a download or install this window started.
  window.api.onDownloadProgress((p) => {
    if (!isBusy(p.gameId)) return;
    const pct = p.totalBytes ? (p.receivedBytes / p.totalBytes) * 100 : 0;
    setLive(p.gameId, { text: formatDownloadStatus(p), mode: "determinate", pct });
  });
  window.api.onInstallProgress((p) => {
    if (!isBusy(p.gameId)) return;
    setLive(p.gameId, { text: formatInstallStatus(p), mode: "indeterminate" });
  });
  window.api.onInstallLog(({ gameId, line }) => {
    if (!isBusy(gameId)) return;
    const lastLine = line.trim().split("\n").filter(Boolean).pop();
    if (lastLine) setLive(gameId, { text: lastLine });
  });

  loadLibrary();
}

init();
