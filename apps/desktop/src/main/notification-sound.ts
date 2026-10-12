import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Win32/Electron toasts cannot use an arbitrary WAV as toast audio. Play in
// Windows' SYSTEM notification audio session, not a renderer/media session.
// Read policy at playback time and fail closed on any query error. No registry
// writes, volume changes, or default-beep fallback.
const WINDOWS_SOUND = String.raw`
$ErrorActionPreference = 'Stop'
function Skip([string] $reason) {
  @{ status = 'suppressed'; reason = $reason } | ConvertTo-Json -Compress
  exit 0
}
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$manager = [Windows.UI.Notifications.ToastNotificationManager]::GetDefault()
if ($manager.NotificationMode.ToString() -ne 'Unrestricted') { Skip 'do-not-disturb' }
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:MIXDOG_NOTIFICATION_APP_ID)
if ($notifier.Setting.ToString() -ne 'Enabled') { Skip 'notifications-disabled' }
$settings = 'HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings'
$globalSound = [Microsoft.Win32.Registry]::GetValue($settings, 'NOC_GLOBAL_SETTING_ALLOW_NOTIFICATION_SOUND', $null)
if ($null -ne $globalSound -and $globalSound -eq 0) { Skip 'global-sound-disabled' }
$appSettings = $settings + '\' + $env:MIXDOG_NOTIFICATION_APP_ID
$sound = [Microsoft.Win32.Registry]::GetValue($appSettings, 'SoundFile', $null)
if ($null -ne $sound -and [string]$sound -eq '') { Skip 'app-sound-disabled' }
$banner = [Microsoft.Win32.Registry]::GetValue($appSettings, 'ShowBanner', $null)
if ($null -ne $banner -and $banner -eq 0) { Skip 'banner-disabled' }
$scheme = [Microsoft.Win32.Registry]::GetValue('HKEY_CURRENT_USER\AppEvents\Schemes', '', $null)
if ($scheme -eq '.None') { Skip 'no-sounds-scheme' }
$defaultSound = [Microsoft.Win32.Registry]::GetValue('HKEY_CURRENT_USER\AppEvents\Schemes\Apps\.Default\Notification.Default\.Current', '', $null)
if ($null -ne $defaultSound -and [string]$defaultSound -eq '') { Skip 'notification-event-muted' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MixdogNotificationAudio {
  [DllImport("winmm.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool PlaySound(string sound, IntPtr module, uint flags);
  [DllImport("shell32.dll")]
  public static extern int SHQueryUserNotificationState(out int state);
}
'@
$state = 0
$hr = [MixdogNotificationAudio]::SHQueryUserNotificationState([ref]$state)
if ($hr -ne 0) { throw "Notification state query failed: $hr" }
if ($state -ne 5) { Skip 'desktop-not-accepting-notifications' }
if ($env:MIXDOG_NOTIFICATION_SOUND_CHECK_ONLY -eq '1') {
  @{ status = 'allowed' } | ConvertTo-Json -Compress
  exit 0
}
# SND_SYSTEM | SND_FILENAME | SND_NODEFAULT, synchronous until the short WAV ends.
if (-not [MixdogNotificationAudio]::PlaySound($env:MIXDOG_NOTIFICATION_SOUND_FILE, [IntPtr]::Zero, 0x00220002)) {
  throw 'Notification sound playback failed'
}
@{ status = 'played' } | ConvertTo-Json -Compress
`;

export function notificationSoundPath(input: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  const root = input.packaged
    ? join(input.resourcesPath, 'app.asar.unpacked', 'out', 'renderer')
    : join(input.appPath, 'src', 'renderer', 'public');
  return join(root, 'notification-sounds', 'soft-rise.wav');
}

/** The notification WAV at `volume` percent: 16-bit PCM samples scaled and
 *  clamped into a cached copy under `directory`; 100% is the source itself. */
export function scaledNotificationSound(sourcePath: string, volume: number, directory: string): string {
  if (volume === 100) return sourcePath;
  const target = join(directory, `${basename(sourcePath, '.wav')}-${volume}.wav`);
  if (existsSync(target)) return target;
  const wav = readFileSync(sourcePath);
  let bits = 0;
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (wav.readUInt16LE(body) !== 1) throw new Error('Notification sound must be PCM');
      bits = wav.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error('Notification sound must be 16-bit PCM');
      const end = Math.min(body + size, wav.length);
      for (let index = body; index + 1 < end; index += 2) {
        const sample = Math.round((wav.readInt16LE(index) * volume) / 100);
        wav.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), index);
      }
      mkdirSync(directory, { recursive: true });
      const temporary = `${target}.${process.pid}.tmp`;
      writeFileSync(temporary, wav);
      renameSync(temporary, target);
      return target;
    }
    offset = body + size + (size & 1);
  }
  throw new Error('Notification sound has no PCM data');
}

export async function playWindowsNotificationSound(
  filePath: string,
  checkOnly = false,
  appId = 'io.mixdog.desktop'
): Promise<string> {
  const { stdout } = await execute(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(WINDOWS_SOUND, 'utf16le').toString('base64'),
    ],
    {
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 16 * 1024,
      env: {
        ...process.env,
        MIXDOG_NOTIFICATION_APP_ID: appId,
        MIXDOG_NOTIFICATION_SOUND_FILE: filePath,
        MIXDOG_NOTIFICATION_SOUND_CHECK_ONLY: checkOnly ? '1' : '0',
      },
    }
  );
  const result = JSON.parse(stdout.trim()) as { status: string; reason?: string };
  if (!['allowed', 'played', 'suppressed'].includes(result.status))
    throw new Error('Invalid notification sound result');
  return result.reason ? `${result.status}:${result.reason}` : result.status;
}
