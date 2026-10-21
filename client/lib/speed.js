/**
 * Smooths a byte counter into a transfer speed. Feed it the running total of
 * bytes with sample(); it returns an exponentially-smoothed bytes/second, so
 * the figure doesn't jump around with every network chunk.
 *
 * Call rebase() whenever the counter jumps for reasons other than download
 * traffic (a finished file is skipped, a partial file resumes), so that jump
 * isn't mistaken for a burst of speed.
 */
function createSpeedMeter({ minIntervalMs = 400, alpha = 0.3 } = {}) {
  let lastTime = null;
  let lastBytes = 0;
  let smoothed = 0;
  let needsBaseline = true;

  return {
    sample(bytes, now = Date.now()) {
      if (needsBaseline || lastTime === null) {
        lastTime = now;
        lastBytes = bytes;
        needsBaseline = false;
        return smoothed;
      }
      const dt = now - lastTime;
      if (dt < minIntervalMs) return smoothed;
      const instant = (Math.max(0, bytes - lastBytes) / dt) * 1000;
      smoothed = smoothed === 0 ? instant : alpha * instant + (1 - alpha) * smoothed;
      lastTime = now;
      lastBytes = bytes;
      return smoothed;
    },
    rebase() {
      needsBaseline = true;
    },
    get bytesPerSec() {
      return smoothed;
    },
  };
}

module.exports = { createSpeedMeter };
