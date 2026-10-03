// Zordon's voice through the computer's own speech engine, so he can talk without
// waiting for a click (browsers block web pages from speaking on their own).
import { execFile, spawn } from 'node:child_process';

const enabled = () => process.env.ZORDON_VOICE !== 'off';
let speaking = null;

function engine() {
  if (process.platform === 'darwin') return (text) => execFile('say', ['-v', process.env.ZORDON_MAC_VOICE || 'Daniel', '-r', '165', text]);
  if (process.platform === 'win32') {
    return (text) => {
      // Text goes in on stdin so nothing in it is ever interpreted as a command.
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; '
        + "try { $s.SelectVoiceByHints('Male') } catch {}; $s.Rate = -2; $s.Speak([Console]::In.ReadToEnd())"], { stdio: ['pipe', 'ignore', 'ignore'] });
      ps.on('error', () => {});
      ps.stdin.end(text);
      return ps;
    };
  }
  return (text) => {
    const p = spawn('espeak', ['-p', '25', '-s', '140', text], { stdio: 'ignore' });
    p.on('error', () => {}); // no espeak installed: stay silent
    return p;
  };
}

export function say(text) {
  if (!enabled() || !text) return false;
  try {
    speaking?.kill?.();
    speaking = engine()(String(text).slice(0, 1000));
    speaking?.on?.('error', () => {});
    return true;
  } catch {
    return false;
  }
}

export function greeting(name, date = new Date()) {
  const h = date.getHours();
  const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  return `Good ${part}${name ? `, ${name}` : ''}. Make today a day better than the last.`;
}

export const FAREWELL = 'May the Power protect you.';

// Closing the tab schedules a farewell; a quick reload cancels it so refreshes stay quiet.
export function createVoiceSession({ greetCooldownMs = 90_000, farewellDelayMs = 4_000 } = {}) {
  let lastGreet = 0;
  let farewellTimer = null;
  return {
    hello(text) {
      if (farewellTimer) {
        clearTimeout(farewellTimer);
        farewellTimer = null;
        return { spoken: false, reason: 'reload' };
      }
      if (Date.now() - lastGreet < greetCooldownMs) return { spoken: false, reason: 'recently greeted' };
      lastGreet = Date.now();
      return { spoken: say(text), text };
    },
    goodbye() {
      clearTimeout(farewellTimer);
      farewellTimer = setTimeout(() => { farewellTimer = null; say(FAREWELL); }, farewellDelayMs);
      farewellTimer.unref?.();
      return { scheduled: true };
    },
    markGreeted() { lastGreet = Date.now(); },
    enabled,
  };
}
