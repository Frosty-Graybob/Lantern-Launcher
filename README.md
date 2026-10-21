# Game Launcher

A self-hosted replacement for Steam's library and installer flow. Put your game installers on one machine, and every PC on your network gets a clean library with covers, descriptions, one-click installs and a Play button.

- **Server** (`server/`): shares a folder of games over your network. Run it as a Windows app, a Docker container, or straight from Node.
- **Client** (`client/`): a Windows desktop app. It downloads a game, installs it for you, finds the program to start, and gives you a Play button.

The server only ever reads your games folder. It never changes it.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Adding games](#adding-games)
- [Server install](#server-install)
  - [Option A: Windows app](#option-a-windows-app)
  - [Option B: Docker](#option-b-docker)
  - [Option C: Node](#option-c-node)
- [Client install](#client-install)
- [Using the launcher](#using-the-launcher)
- [Optional per-game settings](#optional-per-game-settings-gamejson)
- [How installing works](#how-installing-works)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)

## Features

**Library and installing**

- One **Install** button per game. It downloads (resuming a partial download), checks the files, installs, then deletes the installer files to save space.
- **GOG offline installers install silently**, with no wizard to click through. Multi-part games (`.exe` + `-1.bin`, `-2.bin`...) work too.
- Other installer types are handled as well: NSIS installers run silently, and anything else opens its normal window with the destination pre-filled.
- **Portable games** (a folder that needs no installer) are downloaded as they are and given a Play button.
- **Download checksums.** The server hashes every file (SHA-256) in the background, and the client rejects any file that doesn't match.
- Download and install **sizes** shown up front, a **free space** check on each drive, and live download speed and time remaining.
- Finds where the game was installed automatically, creates a **desktop shortcut**, and has **Open install folder**, **Run as administrator** and **Uninstall** in each game's menu.

**DLC**

- DLC is detected from installer file names or from a `DLC` / `Add-ons` / `Expansions` / `Bonus` folder.
- Each DLC gets its own page with a thumbnail, description and **Install** button, and installs into the base game's folder.
- DLC names and pictures come from Steam when it can match them, and the base game's title is trimmed off the front.

**Game pages and artwork**

- Banner, logo, description, genres, developer, release date and screenshots from **Steam's public store** (no account needed) and **SteamGridDB** (free API key).
- Everything is **saved on the PC**, so pages open instantly and work offline.
- **Wrong info? Fix match...** lets you pick the right Steam or SteamGridDB entry. Artwork follows your match.
- **Change cover...** shows the covers SteamGridDB has, or lets you pick a picture from your PC.
- **Clear metadata** in Settings forgets everything looked up and starts fresh. Your own matches and covers are kept.

**Manuals**

- PDF manuals appear on the game page and open in a built-in viewer. The server picks up PDFs next to the installer and inside folders named `Manuals`, `Docs`, `Extras`, `Bonus`, `Guides` and similar.

**Server**

- Windows app that lives in the system tray, with a status window showing the address to give players.
- Docker image for TrueNAS, Unraid, Synology or any Docker host (amd64 and arm64).
- No config files or registration: drop a folder in, press **Refresh** in the launcher.

## Quick start

1. **Server:** install it on the machine that holds your games ([Windows app](#option-a-windows-app) or [Docker](#option-b-docker)).
2. **Games:** put each game in its own folder inside the games folder ([how](#adding-games)).
3. **Client:** install the launcher on each PC, open **Settings**, and enter the server address, for example `http://192.168.1.50:5155`.
4. Press **Refresh**, click a game, click **Install**.

## Adding games

Put each game in **its own folder** inside the games folder, with its installer in it. No config file is needed.

```
Game Library/
  Cyberpunk 2077/
    setup_cyberpunk_2077_2.13_(64bit)_(12345).exe
    setup_cyberpunk_2077_2.13_(64bit)_(12345)-1.bin
    Manuals/
      cyberpunk_manual.pdf
  Stardew Valley/
    setup_stardew_valley_1.5.6.exe
  Some Portable Game/
    Game.exe
    data/...
```

- The game's name comes from the folder name, and the version from the installer's file name.
- The installer that runs is the `setup_*.exe` with the shortest name, so the base game wins over DLC installers. `patch_*.exe` files are never chosen.
- Every file in the folder is downloaded (that's how multi-part `.bin` installers work), except DLC and manuals, which are listed separately.
- New games appear the next time a player presses **Refresh**.
- Each game must be in a top-level folder. Loose installers in the root are not scanned.

**DLC** can sit in the same folder (a `setup_*` installer whose name starts with the base game's name plus a word, such as `setup_a_hat_in_time_-_seal_the_deal_...exe`) or in a subfolder named `DLC`, `DLCs`, `Add-ons`, `Expansions` or `Bonus`.

## Server install

Pick whichever fits where your games live. All three serve the same way, and the launcher can't tell them apart.

### Option A: Windows app

The easy way, for a Windows PC that has your games.

1. Run **Game Launcher Server Setup** (build it yourself, see below).
2. It creates `Documents\Game Library`, starts serving it, and shows the address to give players.
3. The first time it runs, **Windows Firewall** asks whether to allow it. Allow it on **private networks**, or other PCs can't connect.

In the window you can copy the address, change or open the games folder, and see the games found and current downloads. Closing the window keeps the server running in the system tray. Tick **Start with Windows** to launch it at login.

To build the installer (on Windows, with [Node.js](https://nodejs.org) 20 or newer):

```
cd server
npm install
npm run dist
```

The installer is written to `server/dist/`. Use `npm run app` to run it without building.

### Option B: Docker

For TrueNAS, Unraid, Synology, a NAS, a Raspberry Pi or any Docker host. The container runs as a normal user and mounts your games **read-only**.

**1. Get the image.** Either pull a published one or build it yourself.

Pull (replace `YOUR-NAME` with the GitHub user that published it, lowercase):

```
docker pull ghcr.io/YOUR-NAME/game-launcher-server:latest
```

Or build from this repository:

```
docker build -t game-launcher-server server/
```

**2. Run it.** Change `/path/to/your/games` to the folder that holds your games.

```
docker run -d --name game-launcher-server --restart unless-stopped \
  -p 5155:5155 \
  -v /path/to/your/games:/games:ro \
  ghcr.io/YOUR-NAME/game-launcher-server:latest
```

If you built it yourself, use `game-launcher-server` as the image name on the last line.

**Or use Docker Compose.** Edit `server/docker-compose.yml`: set the image (or uncomment `build: .`) and put your games path on the left of the volume line, then run:

```
cd server
docker compose up -d
```

```yaml
services:
  game-launcher-server:
    image: ghcr.io/YOUR-NAME/game-launcher-server:latest
    container_name: game-launcher-server
    restart: unless-stopped
    ports:
      - "5155:5155"
    volumes:
      - /path/to/your/games:/games:ro
```

**3. Check it works.** Open `http://<server address>:5155` in a browser. The status page shows the games found and exactly what to give players. Players enter that same address in the launcher.

**Settings (environment variables, all optional)**

| Variable | Default | What it does |
| --- | --- | --- |
| `LIBRARY_ROOT` | `/games` | Where the container looks for games |
| `PORT` | `5155` | Port inside the container (easier to change the published port instead) |

**Useful commands**

```
docker logs game-launcher-server          # see what it found
docker restart game-launcher-server       # after changing settings
docker pull ghcr.io/YOUR-NAME/game-launcher-server:latest   # update, then re-create the container
```

**TrueNAS SCALE** (24.10 or newer): go to *Apps → Discover Apps → Custom App → Install via YAML* (wording varies by version) and paste the compose file above, with your dataset path on the left of the volume line, for example `/mnt/tank/games:/games:ro`. The container must be able to read that dataset: add `user: "568:568"` (TrueNAS's built-in `apps` user) to the service and give that user read access in the dataset permissions. If the server starts but finds no games, this is almost always the cause. The log says `No games found. Is your games folder mounted at /games?`.

**Publishing your own image.** Push this project to GitHub, then run `git tag server-v1.1.0 && git push --tags`. The workflow in `.github/workflows/docker-publish.yml` builds for amd64 and arm64 and publishes to GitHub's container registry. In the repository's *Packages* settings, set the image to **Public** so other servers can pull it.

### Option C: Node

For development, or a Linux box without Docker. Needs [Node.js](https://nodejs.org) 20 or newer.

```
cd server
npm install
LIBRARY_ROOT=/path/to/games npm start
```

On Windows use `set LIBRARY_ROOT=D:\Games` and then `npm start`. It prints the addresses to use. Settings: `PORT` (default 5155), `HOST` (default every address), `LIBRARY_ROOT` (default `./library`).

## Client install

The client is a Windows desktop app built with Electron.

**One-time step before your first build.** The app bundles `innoextract` and `unrar` so players never install anything separately. Follow `client/tools/README.txt` to get them. Do **not** take innoextract from the official GitHub releases page: its Windows build has a bug with multi-part GOG installers, and the README explains how to get a working build instead. You only do this once.

Then:

```
cd client
npm install
npm start          # run it
npm run dist       # build a Windows installer into client/dist/
```

Open **Settings** and fill in:

| Setting | What to enter |
| --- | --- |
| **Server URL** | The server's address, for example `http://192.168.1.50:5155`. A missing `http://` or trailing slash is fixed for you. |
| **SteamGridDB API key** | Optional, for covers, banners and logos. Get one free at [steamgriddb.com/profile/preferences/api](https://www.steamgriddb.com/profile/preferences/api). |
| **Install folder** | Where games are installed. |

Leave the innoextract field blank unless you want to use a different copy than the bundled one.

## Using the launcher

- **Install.** Downloads the game, checks it, installs it, and cleans up the installer files. If it fails, the files are kept so a retry doesn't download everything again. **Clear downloads** in Settings removes leftovers.
- **Game page.** Click a game for artwork, description, screenshots, sizes, DLC and manuals. If the info is wrong, use **Wrong info? Fix match...**.
- **Missing games.** If a game's files have been deleted or the drive is unplugged, the card shows "Game files not found" with an Install button. If the files come back, it shows as installed again after a refresh.
- **Menu (⋮).** Open install folder, create desktop shortcut, run as administrator, uninstall. Uninstall only deletes inside your install folder and removes shortcuts that point at the game.
- **Metadata.** Info and art are kept on the PC permanently. **Refresh info** on a game page updates one game, and **Clear metadata** in Settings starts over for all of them.

## Optional per-game settings (`game.json`)

A `game.json` in a game's folder on the server can override details. Players don't need it, since they can fix a game from inside the launcher. All fields are optional, and a player's own choice in the app beats them.

```json
{
  "steamAppId": 17470,
  "sgdbId": 5252,
  "installSizeGB": 8.5,
  "description": "Shown if Steam has nothing, and wins over it if it does.",
  "developer": "Studio name",
  "publisher": "Publisher name",
  "genres": ["Action", "Horror"],
  "releaseDate": "2008",
  "installer": "setup_special.exe",
  "silent": false,
  "installArgs": "/quiet",
  "portable": true,
  "playExe": "Game.exe"
}
```

- `installer` picks which file is the installer.
- `silent: false` stops an NSIS installer running silently.
- `installArgs` runs the installer with your own switches instead of the default `/S`.
- `portable` and `playExe` force the portable-game detection and the program that starts.
- `installSizeGB` makes the installed size exact before anyone has installed the game.

More details are in `server/library/README.txt`.

## How installing works

<details>
<summary>Why GOG installers are extracted instead of run</summary>

GOG's offline installers are Inno Setup executables, but the screen you see when you double-click one (the slideshow background, the "INSTALL" button) is a custom page, not Inno's normal wizard. Inno's `/SILENT` switches work by clicking the standard Next button, so on this custom page the installer notices nothing happened and aborts. No command-line flag fixes that.

Other open-source GOG tools (Heroic, Lutris, minigalaxy) extract the archive directly with [innoextract](https://github.com/dscharrer/innoextract), and so does this client, using its own bundled copy.

Larger games are split into GOG Galaxy parts (`setup_game.exe` plus `-1.bin`, `-2.bin`...), which need a working innoextract build and `unrar`. Both ship inside the built app. If extraction still fails on a machine, the app falls back to running the real GOG installer with its window visible and the destination already filled in. You click through it once and the rest stays automatic.

After extraction the app reads the `goggame-<id>.info` file inside the archive, which names the game's main program. That becomes the Play target. Without it, the largest non-uninstaller `.exe` is used.

</details>

<details>
<summary>Installers that aren't Inno Setup</summary>

- **NSIS** installers are recognised by signature and run silently with `/S` plus the destination. You'll see Windows' admin prompt if needed, then a progress bar with elapsed time and data written. If a silent run fails, the installer reopens normally so you can finish it. Silent mode skips license screens.
- **Everything else** (InstallShield, MSI, custom installers) opens normally to click through, because there is no safe switch to guess.
- The game's folder is found by comparing Windows' installed-programs list before and after. Redistributables such as Visual C++, DirectX and .NET are ignored. If nothing is found you're asked to pick the game's `.exe`.
- If a silent install seems stuck, look for an installer window waiting for you. If there isn't one, end the installer in Task Manager and set `"silent": false` for that game.

</details>

## Troubleshooting

| Problem | Try this |
| --- | --- |
| Players can't connect to the Windows server | Allow it through Windows Firewall on **private** networks. The server window has a "Players can't connect?" section. |
| Docker server finds no games | Check the volume maps to `/games`, and that the container's user can read the folder (on TrueNAS, `user: "568:568"`). |
| New game missing | Press **Refresh** in the launcher. Each game needs its own top-level folder. |
| Changes to the server don't show | Restart the server (or rebuild/re-create the container). Client changes need a client restart. |
| A game has the wrong description or art | Open its page and use **Wrong info? Fix match...**. |
| Info looks stale or wrong everywhere | Settings → **Clear metadata**. |
| Install says it failed | Open **Technical details** in the message and use **Copy** if you need to report it. The downloaded files are kept for a retry. |
| Extraction errors on multi-part games | Check the bundled tools came from `client/tools/README.txt`, not the official innoextract release. |

## Known limitations

- Only NSIS installers run silently. Other non-Inno installers open their window, and finding the game afterwards depends on the installer registering itself with Windows or you picking the `.exe`.
- A silent install that hangs on a hidden prompt can't be cancelled from the app, because installers that need admin rights run elevated. End it in Task Manager.
- DLC installs only work for Inno Setup and GOG installers, and only after the base game is installed.
- The fallback "which exe starts the game" heuristic can guess wrong, and there is no manual "set play target" option yet.
- Matching to Steam depends on Steam's search and store API. A few DLC aren't separate Steam pages, so they keep a tidied file name until you use Fix match.
- There is no authentication, which is fine on a trusted home network only.
- Uninstall deletes the whole install folder, so save files a game keeps inside its own folder go with it.
- Some old games with copy protection (for example Sonic Riders' disc copy) may still show their own popups.
- Build step for developers: innoextract, its DLLs and unrar must be gathered into `client/tools/` once before your first build.

## Branding

Logo masters are vector files in `branding/` (`icon.svg`, `icon-small.svg` for 32 px and below, `icon-square.svg`). The icons in both apps are generated from them. To change the artwork, edit the SVGs and run `npm i --no-save sharp && node branding/make-icons.js`.

If you would like to support me and what I do please consider donating to my Ko-Fi: https://ko-fi.com/frostygraybob 
