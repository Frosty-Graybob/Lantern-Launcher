Put innoextract.exe, unrar.exe, and innoextract's runtime DLLs here.

DO NOT use the official Windows build from the innoextract GitHub releases
page -- as of this writing it has a real bug on Windows (fails with
"unable to create .r?? symlinks") when extracting larger, multi-part GOG
installers. Single-file installers work fine with it, but multi-part ones
don't, and this was confirmed against real Windows 10/11 machines across
three different permission configurations (plain, elevated, and Developer
Mode), ruling out a permissions cause.

The fix that's confirmed to work: a build of innoextract pulled from MSYS2,
which tracks the project's git history rather than the stale 2020 GitHub
release, plus the external `unrar` tool it needs for the RAR-based parts.

ONE-TIME SETUP (do this once per machine you build on):

1. Install MSYS2 from https://www.msys2.org (safe, widely-used, ~100MB).

2. Open "MSYS2 UCRT64" from the Start menu and run:
     pacman -Syu
   (it may ask you to close and reopen the terminal partway through --
   that's normal; reopen it and run pacman -Syu again if prompted)

3. Install the tools:
     pacman -S mingw-w64-ucrt-x86_64-innoextract
     pacman -S unrar

4. Copy everything needed in one shot. In that same MSYS2 UCRT64 terminal,
   set DEST to this folder's Windows path (written MSYS-style, so
   C:\Users\you\game-launcher\client\tools becomes
   /c/Users/you/game-launcher/client/tools), then paste the whole block:

     DEST="/c/PATH/TO/game-launcher/client/tools"
     mkdir -p "$DEST"
     cp /ucrt64/bin/innoextract.exe "$DEST/"
     cp /usr/bin/unrar.exe "$DEST/"
     ldd /ucrt64/bin/innoextract.exe | grep '/ucrt64/bin/' | awk '{print $3}' \
       | while read -r f; do cp "$f" "$DEST/"; done
     ls "$DEST"

   That last `ls` should show innoextract.exe, unrar.exe, and a handful of
   DLLs (exact names vary by build -- that's fine, the script finds
   whatever your specific build actually needs instead of guessing).

5. Verify it's genuinely self-contained: open a PLAIN Windows Command
   Prompt (not an MSYS2 terminal -- that has its own PATH which would hide
   a missing-DLL problem), cd into this folder, and run:
     innoextract.exe --version
   If that prints a version instead of a "DLL not found" error, you're good.

That's it -- after this:
  - `npm start` (dev mode) finds it here automatically.
  - `npm run dist` bundles everything in this folder into the built app
    automatically (see the "extraResources" entry in package.json) --
    end users never see this folder, never install MSYS2, and never
    install anything themselves. The MSYS2 install above is purely a
    one-time way to obtain the right files, not a runtime dependency.

This folder is gitignored except for this README, so none of these
binaries accidentally get committed to source control.
