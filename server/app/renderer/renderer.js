"use strict";

const $ = (id) => document.getElementById(id);

// Text always goes in as text, never as HTML: folder and game names come from the disk.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  return node;
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

let state = null;

function render(s) {
  state = s;
  $("version").textContent = `Version ${s.version}`;

  const pill = $("pill");
  pill.className = `pill ${s.running ? "ok" : "bad"}`;
  pill.textContent = s.running ? `Running · port ${s.port}` : "Not running";

  // ---- address(es) to give players
  const box = $("addresses");
  box.replaceChildren();
  if (!s.running) {
    box.append(el("p", { class: "muted", text: "The server isn't running, so there's no address yet." }));
  } else if (!s.addresses.length) {
    box.append(el("p", { class: "muted", text: "No network connection found. Connect this PC to your network and the address will appear here." }));
  } else {
    s.addresses.forEach((a, i) => {
      const copy = el("button", { type: "button", class: "btn", text: "Copy" });
      copy.addEventListener("click", async () => {
        const res = await window.serverApi.copyAddress(a.url);
        copy.textContent = res && res.ok ? "Copied" : "Couldn't copy";
        setTimeout(() => (copy.textContent = "Copy"), 1500);
      });
      box.append(
        el(
          "div",
          { class: `address${i === 0 ? " first" : ""}` },
          el("code", { text: a.url }),
          el("span", { class: "iface", text: a.name }),
          copy
        )
      );
    });
  }
  $("addressHint").classList.toggle("hidden", !s.running || !s.addresses.length);

  // ---- a failure to start, in words, with the way out
  const err = $("errorBox");
  err.classList.toggle("hidden", !s.error);
  err.replaceChildren();
  if (s.error) {
    const retry = el("button", { type: "button", class: "btn small", text: "Try again" });
    retry.addEventListener("click", async () => render(await window.serverApi.restart()));
    err.append(el("strong", { text: "The server couldn't start." }), el("p", { text: s.error }), retry);
  }

  // ---- folder
  $("libraryPath").textContent = s.libraryRoot;
  $("libraryMissing").classList.toggle("hidden", s.libraryExists);

  // ---- settings (don't overwrite what's being typed)
  if (document.activeElement !== $("portInput")) $("portInput").value = s.port;
  $("autoStart").checked = !!s.autoStart;

  // ---- games
  $("gamesTitle").textContent = s.games.length ? `Games (${s.games.length})` : "Games";
  const list = $("games");
  list.replaceChildren();
  if (!s.games.length) {
    list.append(
      el(
        "li",
        { class: "empty" },
        el("strong", { text: "No games yet." }),
        el("span", { text: " Put each game in its own folder inside your games folder, with its installer (and any .bin files) in that folder, then press Rescan." })
      )
    );
  } else {
    s.games.forEach((g) =>
      list.append(
        el("li", {}, el("span", { class: "game-name", text: g.name }), el("span", { class: "game-meta", text: `${plural(g.files, "file")} · ${formatBytes(g.size)}` }))
      )
    );
  }

  // ---- activity
  const st = s.stats;
  const now = st.activeDownloads ? `${plural(st.activeDownloads, "download")} in progress.` : "No downloads right now.";
  const total = st.filesServed || st.bytesServed ? ` Sent ${formatBytes(st.bytesServed)} since the server started.` : "";
  $("activity").textContent = now + total;
}

async function refresh() {
  try {
    render(await window.serverApi.getState());
  } catch {
    /* the app is closing */
  }
}

function init() {
  $("chooseBtn").onclick = async () => render(await window.serverApi.chooseLibrary());
  $("openBtn").onclick = () => window.serverApi.openLibrary();
  $("rescanBtn").onclick = async () => render(await window.serverApi.rescan());
  $("autoStart").onchange = async (e) => render(await window.serverApi.setAutoStart(e.target.checked));

  async function applyPort() {
    const msg = $("portMsg");
    const res = await window.serverApi.setPort($("portInput").value);
    msg.classList.remove("hidden");
    msg.className = `hint ${res.ok ? "good" : "bad-text"}`;
    msg.textContent = res.ok ? `Now listening on port ${res.state.port}. Players need the new address.` : res.error;
    render(res.state);
    if (res.ok) setTimeout(() => msg.classList.add("hidden"), 4000);
  }
  $("portBtn").onclick = applyPort;
  $("portInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyPort();
  });

  refresh();
  setInterval(refresh, 1500);
}

init();
