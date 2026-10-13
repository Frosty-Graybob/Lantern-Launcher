# Game Launcher — self-hosted Steam replacement

- **`server/`** — serves your game library over your network. Runs as a **Windows app**
  (no setup, lives in the system tray), as a **Docker container** (TrueNAS, Unraid,
  Synology, any Docker host), or straight from Node. One shared code base underneath.
- **`client/`** — Windows desktop app (Electron). Downloads installers, silently
  runs GOG offline installers, detects where the game landed, and gives you
  a Play button.

## Server

Pick whichever fits where your games live. They all serve the same way, and the
launcher can't tell them apart.

### Adding games (the same everywhere)

Put each game in **its own folder** inside the games folder, with its installer in
it. That's all: no config file, no registering anything.

```
Game Library/
  Cyberpunk 2077/
    setup_cyberpunk_2077_2.13_(64bit)_(12345).exe
    setup_cyberpunk_2077_2.13_(64bit)_(12345)-1.bin
  Stardew Valley/
    setup_stardew_valley_1.5.6.exe
```

- The name comes from the folder name; the version is read from the installer's file name.
- The installer that gets run is the `setup_*.exe` with the shortest name (so the base
  game wins over DLC installers). `patch_*.exe` files are never chosen.
- **Every** file in a game's folder is downloaded by the launcher (that's how
  multi-part `.bin` installers work), then the chosen installer is run.
- A game you add shows up the next time a player presses **Refresh** in the launcher.
- The server only ever *reads* this folder.

### A. Windows app (the easy way)

For a Windows PC that has your games. **Game Launcher Server** is an installer like
any other program. Run it and it's working: it makes a `Documents\Game Library`
folder, starts serving it, and shows the address to give players.

- **The window** shows the address(es) to paste into the launcher's Server URL (one
  per network connection, each labelled, with a Copy button), your games folder
  (Change… / Open folder), the port, the games it found, and what's being downloaded.
- **Closing the window keeps it running** in the system tray, so players can keep
  downloading. Right-click the tray icon to quit.
- **Start with Windows** (a checkbox) starts it silently in the tray when you log in.
- The first time it runs, **Windows Firewall** asks whether to let it through: allow it
  on **private networks**, or other PCs can't reach it. (There's a "Players can't
  connect?" section in the window with the other usual causes.)

To build the installer (on Windows):

```
cd server
npm install
npm run dist          # -> server/dist/Game Launcher Server Setup 1.1.0.exe
```

(`npm run app` runs it without building, for testing.)

### Branding and icons

The logo's master files are vector (`branding/icon.svg`, plus `icon-small.svg`, a bolder cut
used at 32 px and below so it stays legible in the tray and title bar, and `icon-square.svg`
for avatars). `branding/game-launcher-icon-2048.png` and `game-launcher-icon-square-2048.png`
are ready-made high-resolution versions. Every icon in the apps (`client/assets/icon.ico`,
`server/app/assets/icon.ico`, and the logos in both windows) is generated from those files, so
they can't drift apart. To change the artwork, edit the SVGs and run
`npm i --no-save sharp && node branding/make-icons.js`.

### B. Docker (TrueNAS and other servers)

The image is built from `server/Dockerfile` and runs as a normal user (it never
writes anything). Mount your games folder at **`/games`**, read-only, and publish
port 5155:

```
docker run -d --name game-launcher-server --restart unless-stopped \
  -p 5155:5155 -v /path/to/your/games:/games:ro \
  ghcr.io/YOUR-NAME/game-launcher-server:latest
```

or with Compose (`server/docker-compose.yml` is ready to edit):

```
docker compose up -d
```

Players then use `http://<the server's address>:5155`. Open that address in a browser
to check: it shows a status page with exactly what to give players and the games found.

**Getting the image.** Either build it yourself (`docker build -t game-launcher-server server/`),
or publish it once so any server can pull it: push this project to GitHub, then
`git tag server-v1.1.0 && git push --tags` runs `.github/workflows/docker-publish.yml`, which
builds for normal servers (amd64) and ARM ones like a Raspberry Pi (arm64) and puts the
image in GitHub's registry. In the repository's *Packages* settings, make it **Public** so
other people's servers can pull it. Replace `YOUR-NAME` above with your GitHub user name
(lowercase).

**TrueNAS SCALE** (24.10 or newer, where apps are Docker containers): *Apps → Discover Apps →
Custom App → Install via YAML* (the wording varies a little between versions) and paste the
contents of `docker-compose.yml`, with your dataset's path on the left of the volume
line (e.g. `/mnt/tank/games:/games:ro`). The container has to be able to *read* that
dataset: set `user: "568:568"` (TrueNAS's built-in `apps` user) and give that user read
access in the dataset's permissions. If the server starts but finds no games, this is almost
always why: the log says `No games found. Is your games folder mounted at /games?`.

Other settings, if you need them (environment variables): `PORT` (inside the container;
easier to change the published port instead), `LIBRARY_ROOT` (default `/games`).

### C. From Node (development, or a Linux box without Docker)

```
cd server
npm install
LIBRARY_ROOT=/path/to/games npm start       # Windows: set LIBRARY_ROOT=D:\Games  then  npm start
```

Prints the addresses to use. Settings: `PORT` (default 5155), `HOST` (default every
address), `LIBRARY_ROOT` (default `./library`).

### Upgrading from the old `server.js`

The server folder is reorganised: the code is now in `server/src/`. Delete the old
`server/server.js`, `server/scanner.js` and `server/package-lock.json`. Your games
don't have to move: point the Windows app or `LIBRARY_ROOT` at wherever they already are.

### Per-game extras

An optional `game.json` in a game's folder can override details (see
`server/library/README.txt`). Players don't need it: they can fix a game's info from
inside the launcher.

## Client

**One-time setup step before your first build:** this app bundles
`innoextract` and `unrar` (see below for why) so end users never have to
install anything separately. Follow `client/tools/README.txt` to obtain
them — **not** from the official innoextract GitHub releases page, which
has a confirmed bug on Windows for multi-part GOG installers; the README
walks through getting a working build via MSYS2 instead, as a one-time
step on your own machine. Do this once — every `npm start` and
`npm run dist` after that picks it up automatically.

```
cd client
npm install
npm start          # run it
npm run dist       # build a Windows installer into client/dist/ -- innoextract ships inside it
```

In **Settings** set the Server URL (e.g. `http://192.168.1.50:5155`), an optional
SteamGridDB API key (https://www.steamgriddb.com/profile/preferences/api) for
cover art, and the install folder. Trailing slashes and a missing `http://`
are handled automatically. The innoextract field can stay blank — it's an
override for using a different copy than the bundled one, not something
end users need to fill in.

## How installing actually works (important)

GOG's offline installers are Inno Setup executables, but the screen you see
when you double-click one — the slideshow background, the "INSTALL" /
"MD5 CHECK" buttons — is a **custom Pascal-scripted page**, not Inno
Setup's normal wizard. Inno's own `/SILENT`/`/VERYSILENT` automation works
by simulating a click on the standard wizard's Next button; it has no way
to trigger GOG's custom button logic, so on this custom page the installer
detects that nothing happened and deliberately aborts
(`Failed to proceed to next wizard page; aborting`). No command-line flag
combination fixes this — it's baked into the installer itself.

This is exactly why other self-hosted/open-source GOG library tools
(Heroic Games Launcher, Lutris, minigalaxy) don't run the installer's
wizard either — they extract the installer archive directly instead, using
[**innoextract**](https://github.com/dscharrer/innoextract), an open-source
(zlib-licensed) tool built for exactly this. This client does the same
thing, with its own bundled copy — see the one-time setup step above.

**Larger, multi-part games need two more pieces, both bundled.** Bigger
games are split into GOG Galaxy-format parts (`setup_game.exe` + `-1.bin`,
`-2.bin`, ...). Reassembling those needs:

1. A working `innoextract` build. The **official Windows release has a
   confirmed bug** here — it fails with `unable to create .r?? symlinks`
   regardless of admin rights or Developer Mode (both were tested directly
   against this; neither fixed it). A build pulled from MSYS2 (which
   tracks the project's ongoing git history rather than the stale 2020
   GitHub release) doesn't have this bug. `client/tools/README.txt` walks
   through getting this build.
2. `unrar`, which innoextract shells out to for the actual RAR-format
   decompression. Also bundled the same way.

Small single-file installers never needed either of these and work
regardless. If, for some reason, extraction still fails on a given
machine (missing or mismatched DLLs, a future installer format change),
the app automatically falls back to running the real GOG installer with
its normal window visible instead, with the destination folder already
filled in — you'd see it pop up partway through install and just need to
click through it once (Next → Accept the EULA → Install → Finish).
Detection of the installed game, the desktop shortcut, and the library
status afterward are all still fully automatic either way.

After extraction (or the fallback install), the app reads the
`goggame-<id>.info` file GOG bundles into the archive, which names the
exact primary executable — that becomes the Play target. If that file
isn't there (non-GOG installer) it falls back to the largest
non-uninstaller `.exe`.

If extraction fails outright, the error message includes whatever output
is available to explain what went wrong.

## Installing, cleanup, and missing games

Each game has a single **Install** button. It downloads the game's files
(resuming a partial download, skipping files already complete), then starts
the install straight away with no second click. When the install succeeds,
the downloaded installer files are deleted to save space. If the install
fails, they're kept so a retry doesn't have to download everything again.
Settings → **Clear downloads** removes any leftovers manually.

When the library loads, each installed game's executable is checked on
disk. If it's gone (deleted by hand, or on a drive that's unplugged), the
card shows "Game files not found" with an **Install** button instead of
Play. The saved state isn't wiped, so if the files come back, the game
shows as installed again after a refresh. Reinstalling replaces the old
desktop shortcut instead of making a duplicate.

## Installers that aren't Inno Setup

innoextract only reads Inno Setup installers. For anything else it reports
"Not a supported Inno Setup installer", and the app runs the installer itself.

**NSIS installers (a very common kind) run silently by default.** The app
recognizes them from their signature and runs them with NSIS's standard `/S`
switch plus the destination folder, so there's nothing to click: you'll see
Windows' admin prompt if the installer asks for one, then an animated bar with
the elapsed time and how much data has been written so far (unpacking and
runtime installs can take several minutes). There's no percentage, because a
silent installer doesn't report one and the total size isn't known in advance. If a silent run reports a failure, the app reopens the
installer normally so you can finish it, and if you cancel that too you get a
clear message. Note that silent mode skips the installer's license screens.

**Other kinds** (InstallShield, MSI, custom installers...) have no switch that's
safe to guess, so they open normally for you to click through. For NSIS and Inno
installers the destination is pre-filled with your install folder.

Per-game overrides go in a `game.json` next to the installer on the server:
- `{ "silent": false }` — never auto-run this NSIS installer silently; always
  show its window.
- `{ "installArgs": "/quiet" }` — run this installer with these switches instead
  (works for any installer type, and replaces the default `/S`). The destination
  folder is added for you where the installer type supports it.

If an installer needs a separate data file, keep it in the same server folder as
the installer.

If a silent install seems stuck, look for an installer window that's waiting for
you; if there isn't one, end the installer in Task Manager and set
`"silent": false` for that game.

Finding where the game went is automatic where possible: the app compares
Windows' installed-programs list before and after the install, and the new
entry normally gives the game's folder and often its exe. Redistributables
(Visual C++, DirectX, .NET...) are ignored. If nothing can be worked out, you're
asked to select the game's `.exe`, and that's used to launch it.

## The library, game pages, and sizes

**Sizes.** Every game shows what it will download and what it will take on disk.
The download size is exact (the total of the game's files on the server). The
installed size isn't known until a game is installed, so until then it's an
estimate, marked with **≈**: roughly 1.3× the download, a rule of thumb that can be
well off for some games. It becomes exact in either of two ways: after the game has
been installed once on this PC (the real size is remembered, even after an
uninstall), or when you set `installSizeGB` for the game on the server.

**Free space.** Before installing, the app checks there's room. Downloads go to the
app's data folder and games to your install folder, which can be different drives,
so each drive is checked for what it needs. If one is short you're told which and
asked whether to continue.

**Download speed.** While downloading, the status shows how much has arrived, the
speed in MB/s, and the time remaining.

**Game pages.** Click a game to open its page: banner and logo art, a description,
genres, developer, release date, screenshots (click one to enlarge) and its storage
details. The text and screenshots come from Steam's public store (no account or key
needed, but it needs internet access); the covers, banners and logos come from
SteamGridDB (needs the API key in Settings).

**Saved for good.** Once a game's info and art have been found, they're kept on the PC
permanently: the page opens instantly and works with no internet. Nothing expires.
(A search that found nothing is tried again after a day, since a store listing can
appear later.) To update a game's info, use **Refresh info** on its page: if that can't
reach the internet, what's already saved is left untouched.

**Fixing a wrong match, inside the app.** The game page has **Wrong info? Fix match…**.
It searches Steam (description, genres, screenshots) and SteamGridDB (cover, banner,
logo) by name, shows the candidates, and you click the right one. There are two
extra choices for each: *this game isn't on Steam: show no Steam info* / *use no
artwork*, and *back to automatic*. The choice is remembered on that PC, applies at
once (the cover on the library card updates too), and never involves editing a file.
When Steam matched a title different from the game's name, the page says so with a
**Not right?** button. A game with no info at all offers **Find the right game…**.

Automatic matching is deliberately conservative: a title that only partly matches (a
sequel, a soundtrack, a different subtitle) is rejected rather than showing another
game's description.

**For whoever runs the server only** (players never need this): a `game.json` in a
game's folder can supply the details up front, which is handy for a game no store knows
(a mod, a small release) and saves each player from fixing it by hand. All of it is
optional, and a player's own choice in the app beats it:

```json
{
  "steamAppId": 17470,
  "sgdbId": 5252,
  "installSizeGB": 8.5,
  "description": "Shown if Steam has nothing, and wins over it if it does.",
  "developer": "Studio name",
  "publisher": "Publisher name",
  "genres": ["Action", "Horror"],
  "releaseDate": "2008"
}
```

## Messages and errors

Status lines are short plain sentences (a card never shows more than two lines; hover
for the rest) and don't use installer jargon. When something fails, the dialog shows
one sentence saying what happened and what to try. The technical text, including the
list of files that failed (grouped by cause, since a game with many data files used
to print one long line per file), is behind a collapsed **Technical details** section
with a **Copy** button, so it's there for a support request but out of the way.

## Desktop shortcuts and uninstalling

A desktop shortcut is created automatically right after a game installs
(pointing at the detected executable, with its working directory set
correctly). If a shortcut creation fails for some reason, it's logged but
doesn't fail the install itself.

Every installed game gets a **⋮** menu next to its title in the library
with:
- **Open install folder** — jumps straight to where the game lives on disk.
- **Create desktop shortcut** — recreates it, e.g. if you deleted it by
  hand and want it back.
- **Uninstall** — deletes the installed files and the game's desktop shortcuts.
  Installer files are already deleted after install, so reinstalling means
  downloading the game again. It only deletes inside your install folder: a
  game that its own installer put somewhere else (e.g. Program Files) is
  removed from the library but its files are left alone, with a message saying
  where they are.

**What "the game's desktop shortcuts" covers.** The one the launcher made, and also
any other shortcut on your desktop (or the shared Public desktop) that points at the
game, such as the one a game's own installer adds. When the game's folder is deleted,
that includes shortcuts to anything inside it (an installer's "Uninstall" link). A
shortcut to anything else is never touched, and when a game's files are *left* on disk
only shortcuts that run the game itself are removed. If a game's files can't all be
deleted (it's still running, say), nothing is removed: you're told to close it and try
again, and the game and its shortcuts stay as they were. Start Menu entries made by an
installer, and the entry in Windows' "Apps" list, are not touched.

## Known limitations

- Only NSIS installers run silently by default. Other non-Inno installers open
  their normal window (there's no safe silent switch to guess), and for all of
  them, finding the game afterward depends on the installer registering itself
  with Windows or you picking the exe. A silent install that hangs on a hidden
  prompt can't be cancelled from inside the app, since installers that need
  admin rights run elevated; end it in Task Manager.
- Only the first (best-ranked) installer runs; DLC installers in the same folder
  are downloaded but not run automatically yet.
- The fallback executable heuristic can guess wrong; there's no manual "set play
  target" UI yet.
- No checksum verification and no authentication — fine on a trusted LAN only.
- Games must be in their own top-level folder; loose installers directly in the
  library root and nested subfolders are not scanned.
- Uninstall deletes the whole install folder; any save files a game stores
  inside its own install directory (rather than in `%APPDATA%` or similar)
  would go with it.
- innoextract, its runtime DLLs, and unrar all ship bundled in the built
  app, but you (the developer) need to gather them into `client/tools/`
  once before your first build — see `client/tools/README.txt`. A future
  Windows update to innoextract's official release may fix the underlying
  bug, at which point this MSYS2-sourcing step could be simplified away.

If you would like to support me and what I do please consider donating to my Ko-Fi: https://ko-fi.com/frostygraybob 
