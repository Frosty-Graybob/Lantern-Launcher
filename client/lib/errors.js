// Errors reach the player as one message string (Electron drops everything else
// when an error crosses from the main process to the window). So a friendly
// one-line summary and the technical detail travel together, split by a marker;
// the window shows the summary and keeps the detail behind a "Technical details"
// disclosure. The same marker string is used in renderer/renderer.js.
const DETAILS_MARKER = "\n\n[[details]]\n";

function withDetails(summary, details) {
  const d = String(details || "").trim();
  return d ? `${summary}${DETAILS_MARKER}${d}` : summary;
}

const MAX_LISTED = 12;

/**
 * Turns innoextract's raw output into { summary, details }.
 *
 * It prints one long, path-filled "Could not extract ..." line for every file it
 * fails on, so a game with many data (.bin) files produces a wall of near-identical
 * text. Those lines are grouped by cause, file names are shortened to just the
 * name, and the player gets a single sentence.
 */
function describeUnpackFailure(output, exitCode) {
  const failures = [];
  const other = [];
  for (const raw of String(output || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^Done with \d+ errors?\.?$/i.test(line)) continue;
    const m = /^Could not extract "(.+)": (.+)$/.exec(line);
    if (m) failures.push({ file: m[1].replace(/\\/g, "/").split("/").pop(), reason: m[2].trim() });
    else other.push(line);
  }

  const byReason = new Map();
  for (const f of failures) {
    if (!byReason.has(f.reason)) byReason.set(f.reason, []);
    byReason.get(f.reason).push(f.file);
  }

  const detailLines = [];
  if (exitCode != null) detailLines.push(`Unpacker exit code: ${exitCode}`);
  for (const [reason, files] of byReason) {
    detailLines.push("", `${reason}  (${files.length} file${files.length === 1 ? "" : "s"})`);
    files.slice(0, MAX_LISTED).forEach((f) => detailLines.push(`  ${f}`));
    if (files.length > MAX_LISTED) detailLines.push(`  …and ${files.length - MAX_LISTED} more`);
  }
  if (other.length) detailLines.push("", ...other.slice(0, 20));

  const missingTool = failures.some((f) => /unrar|unar\b/i.test(f.reason)) || other.some((l) => /install `?unrar/i.test(l));
  let summary;
  if (missingTool) {
    summary =
      "This game's data files couldn't be unpacked because a tool the launcher needs (unrar) wasn't found. " +
      "Reinstalling the launcher should fix this.";
  } else if (failures.length) {
    summary =
      `${failures.length === 1 ? "A file" : `${failures.length} files`} in this game couldn't be unpacked. ` +
      "The download may be incomplete or damaged: clear the downloads in Settings and try again.";
  } else {
    summary = "The game's installer couldn't be unpacked. Clear the downloads in Settings and try again.";
  }
  return { summary, details: detailLines.join("\n").trim() };
}

module.exports = { DETAILS_MARKER, withDetails, describeUnpackFailure };
