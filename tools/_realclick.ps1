# Dev-only: drive a REAL system-level left-button press (not a CDP synthetic
# event) so native browser/OS behaviours actually trigger, then watch the
# window rect while the button is held.
# ASCII only -- PowerShell here parses non-ASCII as GBK and breaks.
param(
  [int]$HoldMs = 3000,
  [string]$MatchProc = "electron"
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class RC {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
}
"@

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RCDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][RCDpi]::SetProcessDPIAware()

$script:rows = New-Object System.Collections.ArrayList
$cb = [RC+EnumProc]{
  param($h, $p)
  if (-not [RC]::IsWindowVisible($h)) { return $true }
  $pid2 = 0
  [void][RC]::GetWindowThreadProcessId($h, [ref]$pid2)
  $proc = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
  $r = New-Object RC+RECT
  [void][RC]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left
  $hh = $r.Bottom - $r.Top
  if ($w -ge 60 -and $hh -ge 60) {
    [void]$script:rows.Add([pscustomobject]@{
      H = $h; Name = $(if ($proc) { $proc.ProcessName } else { "" })
      W = $w; Hh = $hh; L = $r.Left; T = $r.Top
    })
  }
  return $true
}
[void][RC]::EnumWindows($cb, [IntPtr]::Zero)

$pet = $script:rows | Where-Object { $_.Name -like $MatchProc -and $_.W -lt 700 } |
       Sort-Object { $_.W * $_.Hh } | Select-Object -First 1
if (-not $pet) { Write-Output "NO_PET_WINDOW"; exit 1 }

Write-Output ("pet window: {0}x{1} at ({2},{3})" -f $pet.W, $pet.Hh, $pet.L, $pet.T)

# aim at roughly the middle of the character: sprite sits at the bottom of the
# window, so go down about 60% of the height
$cx = $pet.L + [int]($pet.W / 2)
$cy = $pet.T + [int]($pet.Hh * 0.58)
Write-Output ("cursor -> ($cx,$cy)")

[void][RC]::SetCursorPos($cx, $cy)
Start-Sleep -Milliseconds 400

$before = New-Object RC+RECT
[void][RC]::GetWindowRect($pet.H, [ref]$before)
Write-Output ("before press: {0}x{1} at ({2},{3})" -f ($before.Right-$before.Left), ($before.Bottom-$before.Top), $before.Left, $before.Top)

[RC]::mouse_event([RC]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)

$held = [int]($HoldMs / 5)
for ($i = 1; $i -le 5; $i++) {
  Start-Sleep -Milliseconds $held
  $r = New-Object RC+RECT
  [void][RC]::GetWindowRect($pet.H, [ref]$r)
  Write-Output ("  held {0}ms: {1}x{2} at ({3},{4})" -f ($i*$held), ($r.Right-$r.Left), ($r.Bottom-$r.Top), $r.Left, $r.Top)
}

[RC]::mouse_event([RC]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 300

$after = New-Object RC+RECT
[void][RC]::GetWindowRect($pet.H, [ref]$after)
Write-Output ("after release: {0}x{1} at ({2},{3})" -f ($after.Right-$after.Left), ($after.Bottom-$after.Top), $after.Left, $after.Top)
