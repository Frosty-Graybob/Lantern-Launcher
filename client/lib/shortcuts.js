const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function powerShellQuote(str) {
  return `'${String(str).replace(/'/g, "''")}'`;
}

function sanitizeFileName(name) {
  return String(name).replace(/[<>:"/\\|?*]/g, "").trim() || "Game";
}

// Picks a filename that won't collide with an existing, unrelated shortcut
// (e.g. two games with the same sanitized name).
function uniqueShortcutPath(desktopDir, baseName) {
  let candidate = path.join(desktopDir, `${baseName}.lnk`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(desktopDir, `${baseName} (${n++}).lnk`);
  }
  return candidate;
}

/**
 * Creates a .lnk shortcut on the desktop pointing at targetExe. Windows has
 * no built-in Node API for this, so it shells out to PowerShell's
 * WScript.Shell COM object, which is the standard way to do it without a
 * native module.
 */
function createDesktopShortcut(desktopDir, gameName, targetExe, workingDir) {
  return new Promise((resolve, reject) => {
    const shortcutPath = uniqueShortcutPath(desktopDir, sanitizeFileName(gameName));

    const psScript =
      `$ws = New-Object -ComObject WScript.Shell;` +
      ` $s = $ws.CreateShortcut(${powerShellQuote(shortcutPath)});` +
      ` $s.TargetPath = ${powerShellQuote(targetExe)};` +
      ` $s.WorkingDirectory = ${powerShellQuote(workingDir)};` +
      ` $s.Save()`;

    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
      windowsHide: true,
    });

    let stderr = "";
    child.stderr && child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 && fs.existsSync(shortcutPath)) {
        resolve(shortcutPath);
      } else {
        reject(new Error(`Couldn't create the desktop shortcut.${stderr ? `\n${stderr}` : ""}`));
      }
    });
  });
}

function removeShortcutIfExists(shortcutPath) {
  if (shortcutPath && fs.existsSync(shortcutPath)) {
    fs.rmSync(shortcutPath, { force: true });
  }
}

// ------------------------------------------------------------------ cleaning up after a game

// True if `child` is `parent` itself or somewhere inside it (case-insensitive on Windows).
function isSameOrInside(child, parent) {
  let c = path.resolve(child);
  let p = path.resolve(parent);
  if (process.platform === "win32") {
    c = c.toLowerCase();
    p = p.toLowerCase();
  }
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// Every .lnk directly inside `dirs`, with the program each one points at:
// [{ path, target }]. Reads the targets with PowerShell's WScript.Shell, the same
// way shortcuts are created above. Returns [] where that isn't available or fails,
// so a problem here can never block an uninstall.
function listShortcuts(dirs) {
  if (process.platform !== "win32" || !dirs.length) return Promise.resolve([]);
  const script =
    "$ErrorActionPreference='SilentlyContinue';" +
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
    "$ws=New-Object -ComObject WScript.Shell;$items=@();" +
    `foreach($d in @(${dirs.map(powerShellQuote).join(",")})){` +
    "if(Test-Path -LiteralPath $d){" +
    "foreach($f in Get-ChildItem -LiteralPath $d -Filter *.lnk -File){" +
    "$items+=[pscustomobject]@{path=$f.FullName;target=$ws.CreateShortcut($f.FullName).TargetPath}}}};" +
    "ConvertTo-Json -InputObject @($items) -Compress";
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    } catch {
      return resolve([]);
    }
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve([]));
    child.on("exit", () => {
      try {
        const parsed = JSON.parse(out.trim() || "[]");
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        resolve(rows.filter((r) => r && typeof r.path === "string" && typeof r.target === "string" && r.target));
      } catch {
        resolve([]);
      }
    });
  });
}

/**
 * Which shortcuts belong to a game that's being uninstalled?
 *   - any pointing at its exe, and
 *   - when the whole game folder is being deleted (`folder`), any pointing at
 *     anything inside it. That also catches an installer's own "Uninstall" link.
 * A shortcut to something outside the game is never touched.
 */
function shortcutsToRemove(shortcuts, { exePath, folder }) {
  return shortcuts.filter((s) => {
    if (exePath && path.resolve(s.target).toLowerCase() === path.resolve(exePath).toLowerCase()) return true;
    return !!folder && isSameOrInside(s.target, folder);
  });
}

/**
 * Removes the shortcuts a game leaves behind: the one this launcher made (`recorded`)
 * and any others on the desktop that point at the game, however they got there (the
 * game's own installer, made by hand...). Pass `folder` only when the game's folder
 * has been deleted. Returns the paths removed. Never throws: a shortcut that can't be
 * deleted (say, one on the shared Public desktop without admin rights) is skipped.
 */
async function removeGameShortcuts({ recorded, dirs, exePath, folder, list = listShortcuts }) {
  const removed = [];
  const tryRemove = (p) => {
    try {
      if (p && fs.existsSync(p)) {
        fs.rmSync(p, { force: true });
        removed.push(p);
      }
    } catch {
      /* e.g. no permission on the shared desktop */
    }
  };
  tryRemove(recorded);
  let found = [];
  try {
    found = await list(dirs);
  } catch {
    /* keep what was removed above */
  }
  for (const s of shortcutsToRemove(found, { exePath, folder })) tryRemove(s.path);
  return removed;
}

module.exports = {
  createDesktopShortcut,
  removeShortcutIfExists,
  sanitizeFileName,
  listShortcuts,
  shortcutsToRemove,
  removeGameShortcuts,
  isSameOrInside,
};
