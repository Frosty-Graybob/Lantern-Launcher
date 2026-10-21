Put one folder per game in here. Each folder just needs the game's installer
files -- no config needed.

  library/
    Cyberpunk 2077/
      setup_cyberpunk_2077_2.13_(64bit)_(12345).exe
      setup_cyberpunk_2077_2.13_(64bit)_(12345)-1.bin
    Stardew Valley/
      setup_stardew_valley_1.5.6.exe

The server re-scans this folder on every request, so new games appear as soon
as you hit Refresh in the client. Optionally add a game.json inside a game's
folder to override the detected name/version:

  { "name": "Cyberpunk 2077", "gogId": "1423049311", "version": "2.13" }

For installers that are NOT Inno Setup, the client runs the installer itself.
NSIS installers (a common kind) run silently by default with no setup at all.
Other kinds open their normal window. Two optional game.json settings change
that for a particular game:

  { "silent": false }          never run this NSIS installer silently; show its window
  { "installArgs": "/quiet" }  run this installer with these switches instead

(The client adds the destination folder itself; don't include it.)

If an installer needs a separate data file (e.g. h2pc_data.bin), put that file
in the same folder -- every file in a game's folder is downloaded next to the
installer.

Optional extras in game.json, all for the client's game page and size display:

  { "steamAppId": 17470 }       use this Steam page for the description/screenshots
                                (when the automatic name match finds nothing or the wrong game)
  { "sgdbId": 5252 }            use this SteamGridDB entry for covers/banners/logos
  { "installSizeGB": 8.5 }      how big the game is once installed, so players see an
                                exact figure before downloading (otherwise it's estimated)
  { "description": "...",       details to show on the game's page, for games no store
    "developer": "...",         knows about. These win over anything fetched from Steam.
    "publisher": "...",
    "genres": ["Action"],
    "releaseDate": "2016" }

Note: all of these are shortcuts for whoever runs the server, and none are needed.
Players can correct a game's info themselves from inside the launcher (on a game's
page: "Wrong info? Fix match..."), and what they pick there wins over this file.

