const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { withDetails, describeUnpackFailure } = require("./errors");

/**
 * Why this doesn't run the installer silently
 * ---------------------------------------------
 * GOG's offline installers are Inno Setup executables, but the Welcome
 * page (the one with the slideshow background, "MD5 CHECK" / "INSTALL"
 * buttons, etc.) is a fully custom Pascal-scripted page, not Inno Setup's
 * built-in wizard page. Inno's /SILENT and /VERYSILENT automation works by
 * simulating clicks on the *standard* wizard's Next button -- it has no way
 * to trigger GOG's custom button logic, so on a custom page like this one
 * the script itself detects that nothing happened and aborts on purpose
 * ("Failed to proceed to next wizard page; aborting"). No combination of
 * command-line flags fixes this -- it's a property of the installer, not
 * something the caller controls.
 *
 * This is exactly why Heroic Games Launcher, Lutris, and minigalaxy don't
 * run GOG's installer wizard either -- for most games, they extract the
 * installer archive directly with innoextract
 * (https://github.com/dscharrer/innoextract), an open-source tool built
 * for precisely this. That's the primary method used here too, requiring
 * zero clicks.
 *
 * Requires innoextract.exe to be available -- either on PATH, or pointed
 * to directly via the innoExtractPath setting. Get it from
 * https://github.com/dscharrer/innoextract/releases (or constexpr.org/innoextract).
 *
 * The multi-part fallback
 * -------------------------
 * Larger games are split into GOG Galaxy-format parts (setup_game.exe +
 * setup_game-1.bin, -2.bin, ...). Reassembling those requires innoextract
 * to create temporary symlinks internally, which is unreliable on Windows
 * in practice -- it fails with "unable to create .r?? symlinks" regardless
 * of admin rights or Developer Mode (both were tried and both failed to
 * resolve it; this appears to be a limitation of the Windows build of
 * innoextract's GOG-specific handling, not a permissions issue we can fix
 * from here). Single-file installers never hit this at all.
 *
 * When that specific failure happens, this falls back to running the real
 * installer with its normal GUI visible, with the destination folder
 * already filled in -- you click through it once (Next, Accept, Install,
 * Finish). That's reliable because it's the installer doing exactly what
 * it's designed to do; only the *silent* automation of it is broken.
 * Detection, the desktop shortcut, and library status afterward are fully
 * automatic either way.
 */
async function extractGogInstaller(installerPath, installDir, innoExtractPath, onLog, options = {}) {
  fs.mkdirSync(installDir, { recursive: true });

  const args = [
    "--extract",
    "--gog",           // reassemble GOG Galaxy-format file parts when present
    "--output-dir",
    installDir,
    "--silent",
    installerPath,
  ];

  const { exitCode, output } = await runInnoExtract(innoExtractPath, args, onLog);

  if (exitCode !== 0 && exitCode !== "ENOENT" && /unable to create .*symlink|install `unrar`/i.test(output)) {
    onLog && onLog("Opening the setup window — click through it.");
    return await installViaVisibleWizard(installerPath, installDir, onLog);
  }

  // Not an Inno Setup installer at all (NSIS, InstallShield, a custom one...):
  // innoextract can't unpack those, so run the installer itself -- silently if
  // it's a type with a reliable silent switch (NSIS), otherwise with its window.
  // This also covers anything else innoextract can't make sense of (an Inno
  // version it doesn't know, a self-extractor, etc.): as long as it isn't
  // reporting damaged data files ("Could not extract ..."), running the real
  // installer is better than giving up.
  if (
    exitCode !== 0 &&
    exitCode !== "ENOENT" &&
    (/not a supported inno setup installer|not an inno setup|unexpected setup data version|unsupported/i.test(output) ||
      !/could not extract/i.test(output))
  ) {
    onLog && onLog("Not a standard unpackable installer — running it directly.");
    return await installViaGenericInstaller(installerPath, installDir, onLog, options);
  }

  if (exitCode !== 0) {
    if (exitCode === "ENOENT") {
      throw new Error(
        withDetails(
          "A component the launcher needs to unpack games is missing. Reinstalling the launcher should fix this.",
          `Looked for: ${innoExtractPath}\n` +
            "In a development build, see client/tools/README.txt for how to add it."
        )
      );
    }
    const failure = describeUnpackFailure(output, exitCode);
    throw new Error(withDetails(failure.summary, failure.details));
  }

  // innoextract usually mirrors Inno Setup's {app} constant into an "app" subfolder
  // of the output directory, with tmp, __redist and the like beside it. But some
  // installers (A Hat in Time, for one) put the game straight into the output
  // directory and leave "app" holding only a few stray files. So look in "app"
  // first, then in the output directory itself, and take the first place where the
  // game's program is really there.
  const appDir = path.join(installDir, "app");
  const roots = fs.existsSync(appDir) ? [appDir, installDir] : [installDir];
  const searchRoot = roots[0];

  let result = null;
  for (const root of roots) {
    result = detectInstalledGame(root);
    if (result) break;
  }
  if (!result) {
    // Some installers (old disc-based ones in particular) don't carry the game's
    // program inside the setup file: they copy it from the disc, i.e. from the
    // folder next to the installer. innoextract can't see those files, so bring
    // over the program files that sit beside the installer and look again.
    const copied = copySiblingProgramFiles(installerPath, searchRoot);
    if (copied.length) {
      onLog && onLog(`Added program files from beside the installer: ${copied.join(", ")}`);
      result = detectInstalledGame(searchRoot);
    }
  }
  if (!result) {
    throw new Error(
      withDetails(
        "The game was unpacked, but the launcher couldn't find the program that starts it.",
        `Looked in: ${roots.join("\n           ")}`
      )
    );
  }
  return result;
}


// Program files that sit next to an installer (not inside it): .exe/.dll/.sys
// and similar, never the installer itself, other installers/launchers/redists,
// temp files or multi-part data. Existing files are never overwritten.
const SIBLING_EXTENSIONS = /\.(exe|dll|sys|ico|ini|cfg|manifest)$/i;
function copySiblingProgramFiles(installerPath, destDir) {
  const srcDir = path.dirname(installerPath);
  const self = path.basename(installerPath).toLowerCase();
  const copied = [];
  let entries;
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return copied;
  }
  for (const e of entries) {
    if (!e.isFile() || e.name.toLowerCase() === self) continue;
    if (!SIBLING_EXTENSIONS.test(e.name)) continue;
    if (/\.exe$/i.test(e.name) && (SKIP_NAME_PATTERN.test(e.name) || /launcher|autorun|install/i.test(e.name))) continue;
    try {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(path.join(srcDir, e.name), path.join(destDir, e.name), fs.constants.COPYFILE_EXCL);
      copied.push(e.name);
    } catch {
      /* already there or unreadable: skip */
    }
  }
  diag(`copySiblingProgramFiles from ${srcDir}: ${copied.join(", ") || "none"}`);
  return copied;
}


// ---------------------------------------------------------------------------
// Portable games: nothing was installed, so which program starts the game?
// ---------------------------------------------------------------------------

const NOT_THE_GAME = /launcher|config|setup|install|unins|crash|report|updater?|redist|vcredist|dxsetup|dotnet|helper|handler|server|editor|benchmark|curl|7z|ffmpeg|cef|webhelper/i;
const SKIP_DIRS = /^(_?_?redist|directx|dotnet|vcredist|support|_commonredist|__support|tools|crashreporter)$/i;

const squash = (str) => String(str || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Picks the program that starts a portable game. `hint` (from the server) is a path
 * relative to the folder and wins when it exists. Otherwise each .exe is scored: a name
 * that matches the game's name counts for a lot; launchers, setup, crash reporters and
 * redistributables count against; deeper folders count slightly against; size breaks ties.
 */
function findPlayExecutable(dir, gameName, hint) {
  if (hint) {
    const hinted = path.join(dir, ...String(hint).split(/[\\/]/));
    if (fs.existsSync(hinted)) return hinted;
  }

  const gameKey = squash(gameName);
  const gameWords = String(gameName || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const found = [];

  const walk = (current, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.test(e.name)) walk(full, depth + 1);
      } else if (e.isFile() && /\.exe$/i.test(e.name)) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* vanished: score it as empty */
        }
        found.push({ full, name: e.name, depth, size });
      }
    }
  };
  walk(dir, 0);
  if (!found.length) return null;

  const scored = found.map((f) => {
    const base = squash(f.name.replace(/\.exe$/i, ""));
    let score = 0;
    if (gameKey && base && (base.includes(gameKey) || (base.length >= 5 && gameKey.includes(base))) && base.length >= 3) score += 100;
    for (const w of gameWords) if (base.includes(w)) score += 15;
    if (NOT_THE_GAME.test(f.name)) score -= 200;
    score -= f.depth * 5;
    return { ...f, score };
  });
  scored.sort((a, b) => b.score - a.score || b.size - a.size);
  return scored[0].full;
}

/**
 * Unpacks a DLC installer on top of an installed game. GOG DLC installers put
 * their files in the same {app} folder as the game, so extracting them into the
 * game's folder is all it takes. `outputDir` is the folder innoextract writes
 * into (it creates an "app" folder inside it, just as for the base game).
 */
async function extractDlcInstaller(installerPath, outputDir, innoExtractPath, onLog) {
  fs.mkdirSync(outputDir, { recursive: true });
  const args = ["--extract", "--gog", "--output-dir", outputDir, "--silent", installerPath];
  const { exitCode, output } = await runInnoExtract(innoExtractPath, args, onLog);
  diag(`dlc extract: ${installerPath} -> ${outputDir} exit=${exitCode} ${String(output).slice(0, 300)}`);
  if (exitCode === 0) return;
  if (exitCode === "ENOENT") {
    throw new Error(
      withDetails(
        "A component the launcher needs to unpack games is missing. Reinstalling the launcher should fix this.",
        `Looked for: ${innoExtractPath}`
      )
    );
  }
  if (/not a supported inno setup installer/i.test(output)) {
    throw new Error(
      withDetails(
        "This DLC's installer isn't a kind the launcher can unpack automatically.",
        output
      )
    );
  }
  const failure = describeUnpackFailure(output, exitCode);
  throw new Error(withDetails(failure.summary, failure.details));
}

/**
 * Runs the installer's own (visible) wizard for the user to click through,
 * with the destination pre-filled via /DIR. No silent flags at all here --
 * showing the real UI is exactly what makes this reliable, since GOG's
 * custom Welcome page only breaks under *silent* automation.
 */
async function installViaVisibleWizard(installerPath, installDir, onLog) {
  const args = [`/DIR=${installDir}`, "/LANG=english"];

  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(installerPath, args, { windowsHide: false });
    } catch (err) {
      return reject(err);
    }
    child.on("error", reject);
    child.on("exit", () => resolve()); // exit code isn't meaningful here; detection below is the real check
  });

  const result = detectInstalledGame(installDir);
  if (!result) {
    throw new Error(
      withDetails(
        "The setup window closed before the game finished installing. Click Install to try again.",
        `Looked in: ${installDir}`
      )
    );
  }
  return result;
}

function runInnoExtract(innoExtractPath, args, onLog) {
  return new Promise((resolve) => {
    let output = "";
    let child;
    try {
      child = spawn(innoExtractPath, args, { windowsHide: true });
    } catch (err) {
      return resolve({ exitCode: err.code === "ENOENT" ? "ENOENT" : -1, output: err.message });
    }

    // Output is collected, not shown live: innoextract runs with --silent, so
    // anything it prints is an error, and for installers it can't read (e.g.
    // NSIS) that error is expected and is about to be handled by another path.
    // Real failures still show up in full, via the error thrown with `output`.
    child.stdout && child.stdout.on("data", (d) => {
      output += d.toString();
    });
    child.stderr && child.stderr.on("data", (d) => {
      output += d.toString();
    });
    child.on("error", (err) => {
      resolve({ exitCode: err.code === "ENOENT" ? "ENOENT" : -1, output: err.message });
    });
    child.on("exit", (code) => resolve({ exitCode: code, output: output.trim() }));
  });
}

/**
 * Looks for GOG's own metadata file (goggame-<id>.info), which lists the
 * exact primary executable GOG intends players to launch. Falls back to a
 * heuristic scan for the largest non-uninstaller .exe if that's missing.
 */
function detectInstalledGame(installDir) {
  const infoFile = findGogInfoFile(installDir);

  if (infoFile) {
    try {
      const info = JSON.parse(fs.readFileSync(infoFile, "utf-8"));
      const primaryTask = (info.playTasks || []).find(
        (task) => task.isPrimary && task.type === "FileTask" && task.path
      );
      // The info file can sit in a different folder than the game's files (and
      // other folders may have one too), so only trust it when its program exists here.
      if (primaryTask && !fs.existsSync(path.join(installDir, primaryTask.path))) {
        return null;
      }
      if (primaryTask) {
        return {
          installPath: installDir,
          exePath: path.join(installDir, primaryTask.path),
          exeArgs: primaryTask.arguments || "",
          gameName: info.name || null,
          detectionMethod: "goggame-info",
        };
      }
    } catch (err) {
      console.error("Failed to parse goggame info file:", err);
    }
  }

  const candidate = findLikelyExecutable(installDir);
  if (candidate) {
    return {
      installPath: installDir,
      exePath: candidate,
      exeArgs: "",
      gameName: null,
      detectionMethod: "heuristic",
    };
  }

  return null;
}

function findGogInfoFile(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && /^goggame-.*\.info$/i.test(entry.name)) {
      return path.join(dir, entry.name);
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findGogInfoFile(path.join(dir, entry.name));
      if (found) return found;
    }
  }
  return null;
}

const SKIP_NAME_PATTERN = /(unins|redist|vcredist|dxsetup|directx|setup)/i;

function findLikelyExecutable(dir, depth = 0) {
  if (depth > 3) return null;
  let best = null;
  let bestSize = -1;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && /\.exe$/i.test(entry.name) && !SKIP_NAME_PATTERN.test(entry.name)) {
      const size = fs.statSync(full).size;
      if (size > bestSize) {
        best = full;
        bestSize = size;
      }
    }
  }

  if (best) return best;

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findLikelyExecutable(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}


// ---------------------------------------------------------------------------
// Installers that aren't Inno Setup
// ---------------------------------------------------------------------------
//
// There's no universal silent switch, so these are run normally (the user
// clicks through them). What *can* be automated is finding where the game
// ended up: Windows keeps a list of installed programs in the registry
// ("Uninstall" keys), most installers add an entry there, and comparing the
// list before and after the install shows which entry is new. That entry
// usually names the install folder and often the game's own exe (as its icon).

// Redistributables and runtimes that games commonly install alongside
// themselves; their registry entries aren't the game.
const NOISE_NAME = /redistributable|visual c\+\+|vcredist|directx|\.net (framework|runtime|desktop)|microsoft .*runtime|windows sdk|physx|openal|xna/i;

// Best-effort guess at the installer's engine from signature strings, only
// used to pre-fill the destination folder where the engine supports it.
function detectInstallerType(filePath) {
  let buf;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const size = Math.min(fs.fstatSync(fd).size, 8 * 1024 * 1024);
      buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "unknown";
  }
  const has = (str) => buf.includes(Buffer.from(str, "latin1"));
  const typeOf = () => {
    if (has("Nullsoft Install System") || has("NullsoftInst")) return "nsis";
    if (has("Inno Setup")) return "inno";
    if (has("InstallShield")) return "installshield";
    if (has(".wixburn")) return "wix";
    if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0) return "msi";
    return null;
  };
  const found = typeOf();
  if (found) return found;

  // Big installers often keep their signature (or a trailing payload header)
  // near the end of the file, beyond the first 8 MB.
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const total = fs.fstatSync(fd).size;
      if (total > buf.length) {
        const tailSize = Math.min(total - buf.length, 8 * 1024 * 1024);
        buf = Buffer.alloc(tailSize);
        fs.readSync(fd, buf, 0, tailSize, total - tailSize);
        const tail = typeOf();
        if (tail) return tail;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* ignore: fall through to unknown */
  }
  return "unknown";
}

function powerShellQuote(str) {
  return `'${String(str).replace(/'/g, "''")}'`;
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

// Exit code PowerShell uses when the installer couldn't be *started* at all
// (e.g. the user declined the UAC prompt), so that isn't mistaken for the
// installer itself returning a failure code.
const LAUNCH_FAILED_CODE = 9009;

// Runs an installer, waits for it (and anything it launches) to finish, and
// returns its exit code. Start-Process goes through the Windows shell, so
// installers that need admin rights get the normal UAC prompt -- a plain
// spawn() would just fail on those.
async function runInstallerAndWait(installerPath, argString) {
  if (process.platform !== "win32") {
    return await new Promise((resolve, reject) => {
      const child = spawn(installerPath, argString ? [argString] : []);
      child.on("error", reject);
      child.on("exit", (code) => resolve(code === null ? 1 : code));
    });
  }
  const script =
    "try {" +
    " $p = Start-Process -FilePath " + powerShellQuote(installerPath) +
    " -WorkingDirectory " + powerShellQuote(path.dirname(installerPath)) +
    (argString ? " -ArgumentList " + powerShellQuote(argString) : "") +
    " -Wait -PassThru -ErrorAction Stop;" +
    " exit $p.ExitCode" +
    " } catch {" +
    " [Console]::Error.WriteLine('LAUNCH_FAILED: ' + $_.Exception.Message);" +
    " exit " + LAUNCH_FAILED_CODE +
    " }";
  const t0 = Date.now();
  const { code, stdout, stderr } = await runPowerShell(script);
  diag(`run: ${installerPath} args=[${argString}] -> exit=${code} after ${Math.round((Date.now() - t0) / 1000)}s stderr=${String(stderr).trim().slice(0, 500)}`);
  if (code === LAUNCH_FAILED_CODE && /LAUNCH_FAILED/.test(stderr)) {
    const reason = stderr.replace(/^[\s\S]*?LAUNCH_FAILED:\s*/, "").trim();
    throw new Error(
      withDetails(
        /cancel|declin|denied|refus/i.test(reason)
          ? "Windows asked for permission to run the installer, and it was declined. Click Install to try again."
          : "The installer couldn't be started.",
        reason
      )
    );
  }
  return code === null ? 1 : code;
}

function cleanPath(p) {
  const trimmed = String(p || "").trim().replace(/^"+|"+$/g, "");
  return /^[A-Za-z]:[\\/]*$/.test(trimmed) ? trimmed : trimmed.replace(/[\\/]+$/, "");
}

// "C:\\Games\\X\\x.exe,0" or '"C:\\Games\\X\\x.exe",0' -> the exe path, else null.
function iconExePath(displayIcon) {
  let p = String(displayIcon || "").trim();
  if (!p) return null;
  if (p.startsWith('"')) {
    const end = p.indexOf('"', 1);
    p = end > 0 ? p.slice(1, end) : p.slice(1);
  } else {
    p = p.replace(/,\s*-?\d+$/, "");
  }
  p = p.trim();
  return /\.exe$/i.test(p) ? p : null;
}

// Rejects folders that can't be "the game's folder": missing ones, drive
// roots, the Windows folder, and the bare Program Files folders.
function isUsableDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  const resolved = path.resolve(dir);
  const lower = resolved.toLowerCase();
  if (path.parse(resolved).root.toLowerCase() === lower) return false;

  const bare = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432, process.env.ProgramData]
    .filter(Boolean)
    .map((d) => path.resolve(d).toLowerCase());
  if (bare.includes(lower)) return false;

  const win = process.env.windir || process.env.SystemRoot;
  if (win) {
    const w = path.resolve(win).toLowerCase();
    if (lower === w || lower.startsWith(w + path.sep)) return false;
  }
  return true;
}

// Turns one raw registry entry into { name, dir, exe }, where dir/exe are only
// set if they exist on disk right now.
function resolveEntryTarget(raw) {
  const name = raw.DisplayName || "";
  if (NOISE_NAME.test(name)) return { name, dir: null, exe: null };

  const icon = iconExePath(raw.DisplayIcon);
  const exe = icon && fs.existsSync(icon) && !SKIP_NAME_PATTERN.test(path.basename(icon)) ? icon : null;

  const location = cleanPath(raw.InstallLocation);
  let dir = null;
  if (location && isUsableDir(location)) dir = location;
  else if (exe && isUsableDir(path.dirname(exe))) dir = path.dirname(exe);

  return { name, dir, exe: dir ? exe : null };
}

// Snapshot of Windows' installed-programs list, as [{ key, name, dir, exe }].
async function readUninstallEntries() {
  if (process.platform !== "win32") return [];
  const script =
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
    "$k='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*';" +
    "$r=@(Get-ItemProperty -Path $k -ErrorAction SilentlyContinue | " +
    "Select-Object PSPath,DisplayName,InstallLocation,DisplayIcon);" +
    "ConvertTo-Json -InputObject $r -Compress";
  try {
    const { stdout } = await runPowerShell(script);
    const parsed = JSON.parse(stdout.trim() || "[]");
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.filter((r) => r && r.PSPath).map((r) => ({ key: r.PSPath, ...resolveEntryTarget(r) }));
  } catch {
    return []; // can't read the list: detection falls back to the other methods
  }
}

// The entry that's new since `before`, or whose folder didn't exist before but
// does now (e.g. a reinstall over a stale entry left by an earlier uninstall).
function pickNewEntry(before, after) {
  const prev = new Map(before.map((e) => [e.key, e]));
  const candidates = after.filter((e) => e.dir && (!prev.has(e.key) || !prev.get(e.key).dir));
  return candidates.find((e) => e.exe) || candidates[0] || null;
}

function buildInstallerArgs(type, installDir, customArgs) {
  const custom = (customArgs || "").trim();
  // NSIS wants /D= as the *last* argument and unquoted; Inno uses /DIR=.
  // Anything else gets no destination argument and the user picks the folder.
  // If the custom options already set a destination, don't add another.
  const dest =
    type === "nsis" && !/\/D=/i.test(custom) ? `/D=${installDir}`
    : type === "inno" && !/\/DIR=/i.test(custom) ? `/DIR=${installDir}`
    : "";
  return [custom, dest].filter(Boolean).join(" ");
}


// Plain-text trail of what the generic installer path did, for diagnosing
// installers that misbehave. Lives in the temp folder; failures are ignored.
const DIAG_LOG = path.join(os.tmpdir(), "game-launcher-install.log");
function diag(line) {
  try {
    fs.appendFileSync(DIAG_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never break an install */
  }
}

// Which switches to try for a hands-off install, or "" to just show the
// installer's normal window. Explicit per-game installArgs always win. NSIS
// installers get /S (its standard silent switch) unless the game opts out with
// silent:false. Other installer types have no switch that's safe to guess.
function chooseUnattendedArgs(type, options = {}) {
  const custom = (options.installArgs || "").trim();
  if (custom) return custom;
  if (options.silent !== false && type === "nsis") return "/S";
  return "";
}

// Exit codes that mean "worked": 0, plus the Windows Installer codes for
// "worked, restart needed".
const SUCCESS_CODES = [0, 3010, 1641];

// Total size in bytes of the files under `dir` (0 if it doesn't exist yet).
// Async so scanning a big install folder doesn't stall the app.
async function dirSize(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += await dirSize(full);
      else if (entry.isFile()) total += (await fs.promises.stat(full)).size;
    } catch {
      /* a file vanished mid-scan (installers delete temp files): ignore it */
    }
  }
  return total;
}

// Runs `fn` while reporting progress once a second via onProgress:
//   { elapsedSec, writtenBytes, stalledSec, mayNeedAdmin }
// A silent installer says nothing about how far along it is, so the best honest
// signals are how long it's been going and how much it has written to the
// destination folder. `stalledSec` is how long that number has stayed the same,
// so the UI can tell a slow phase (checking files, installing runtimes) from a
// stuck installer.
async function withProgress(installDir, onProgress, fn, { intervalMs = 1000, scanEveryMs = 3000 } = {}) {
  if (!onProgress) return await fn();

  const started = Date.now();
  let written = 0;
  let lastChange = started;
  let lastScan = 0;
  let scanning = false;

  const emit = () =>
    onProgress({
      elapsedSec: Math.floor((Date.now() - started) / 1000),
      writtenBytes: written,
      stalledSec: Math.floor((Date.now() - lastChange) / 1000),
      mayNeedAdmin: true,
    });

  const tick = () => {
    if (!scanning && Date.now() - lastScan >= scanEveryMs) {
      scanning = true;
      lastScan = Date.now();
      dirSize(installDir)
        .then((size) => {
          if (size !== written) {
            written = size;
            lastChange = Date.now();
          }
        })
        .finally(() => {
          scanning = false;
        });
    }
    emit();
  };

  emit(); // show something immediately
  const timer = setInterval(tick, intervalMs);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

// Some older installers (InstallShield and friends) never write a usable
// "Uninstall" entry. As a second signal, note which folders exist in the usual
// program locations before the install, and look for new ones afterward.
function programFolderRoots(installDir) {
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramW6432,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
    path.dirname(installDir),
  ].filter(Boolean);
  return [...new Set(roots.map((r) => path.resolve(r)))];
}

function snapshotProgramFolders(installDir) {
  const seen = new Set();
  for (const root of programFolderRoots(installDir)) {
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isDirectory()) seen.add(path.join(root, e.name).toLowerCase());
      }
    } catch {
      /* unreadable root: skip */
    }
  }
  return seen;
}

function findNewProgramFolder(before, installDir) {
  let best = null;
  let bestSize = -1;
  for (const root of programFolderRoots(installDir)) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(root, e.name);
      if (!e.isDirectory() || before.has(full.toLowerCase())) continue;
      if (path.resolve(full).toLowerCase() === path.resolve(installDir).toLowerCase()) continue;
      const exe = findLikelyExecutable(full);
      if (!exe) continue;
      const size = fs.statSync(exe).size;
      if (size > bestSize) {
        best = { dir: full, exe };
        bestSize = size;
      }
    }
  }
  return best;
}

async function installViaGenericInstaller(installerPath, installDir, onLog, options = {}) {
  const type = detectInstallerType(installerPath);
  const unattendedArgs = chooseUnattendedArgs(type, options);
  const visibleArgs = buildInstallerArgs(type, installDir, "");
  onLog && onLog(`Installer type: ${type}`);
  diag(`--- generic install: ${installerPath} (${fs.statSync(installerPath).size} bytes) type=${type} unattended=[${unattendedArgs}] dest=${installDir}`);

  const foldersBefore = snapshotProgramFolders(installDir);
  const before = await readUninstallEntries();

  // Works out where the game went, trying the registry first, then the folder
  // we offered, then any new program folder. Returns null if nothing turns up.
  async function locate() {
    const after = await readUninstallEntries();
    const found = pickNewEntry(before, after);
    let dir = found ? found.dir : null;
    let exePath = found ? found.exe : null;
    let method = "registry";

    if (dir && !exePath) exePath = findLikelyExecutable(dir);

    // Maybe the installer honored the destination we offered.
    if (!exePath && fs.existsSync(installDir)) {
      const guess = findLikelyExecutable(installDir);
      if (guess) {
        exePath = guess;
        dir = installDir;
        method = "heuristic";
      }
    }

    // Last automatic resort: a program folder that appeared during the install.
    if (!exePath) {
      const folder = findNewProgramFolder(foldersBefore, installDir);
      if (folder) {
        exePath = folder.exe;
        dir = folder.dir;
        method = "new-folder";
      }
    }
    diag(`locate: registryEntry=${found ? JSON.stringify({ name: found.name, dir: found.dir, exe: found.exe }) : "none"} exe=${exePath || "none"} method=${method}`);
    return exePath ? { dir, exePath, method, name: found ? found.name : null } : null;
  }

  let exitCode;
  let located = null;

  if (unattendedArgs) {
    onLog && onLog("Installing — Windows may ask for permission first.");
    exitCode = await withProgress(installDir, options.onProgress, () =>
      runInstallerAndWait(installerPath, buildInstallerArgs(type, installDir, unattendedArgs))
    );
    console.log(`Unattended install exited with code ${exitCode}`);
    if (SUCCESS_CODES.includes(exitCode)) located = await locate();

    if (!located) {
      // Silent mode isn't reliable for every installer: it may fail outright,
      // or "succeed" without installing anything (e.g. a launcher that hands
      // off to another process and quits). Either way, show the installer
      // normally so the user can finish it.
      onLog && onLog("The silent install didn't produce a game — opening the setup window instead.");
      exitCode = await runInstallerAndWait(installerPath, visibleArgs);
      located = await locate();
    }
  } else {
    onLog && onLog("Opening the setup window — click through it.");
    exitCode = await runInstallerAndWait(installerPath, visibleArgs);
    located = await locate();
  }

  if (!located) {
    // NSIS exit codes 1 and 2 mean the user cancelled / the installer aborted.
    if (type === "nsis" && (exitCode === 1 || exitCode === 2)) {
      throw new Error(
        "The installer was cancelled or stopped before it finished, so nothing was installed. " +
          "Click Install to try again."
      );
    }
    const err = new Error(
      "The installer finished, but I couldn't tell where it installed the game or which program starts it."
    );
    err.code = "DETECT_FAILED";
    err.hintDir = installDir;
    throw err;
  }

  const { dir, exePath, method, name } = located;

  // The folder we pre-created is useless if the game went elsewhere.
  if (path.resolve(dir) !== path.resolve(installDir)) {
    try {
      fs.rmdirSync(installDir); // only succeeds if it's empty
    } catch {
      /* not empty or already gone: leave it */
    }
  }

  return {
    installPath: dir,
    exePath,
    exeArgs: "",
    gameName: name,
    detectionMethod: method,
  };
}

module.exports = {
  extractGogInstaller,
  findPlayExecutable,
  extractDlcInstaller,
  detectInstalledGame,
  dirSize,
  _internals: { dirSize, withProgress, SUCCESS_CODES, buildInstallerArgs, chooseUnattendedArgs, detectInstallerType, iconExePath, cleanPath, isUsableDir, resolveEntryTarget, pickNewEntry },
};
