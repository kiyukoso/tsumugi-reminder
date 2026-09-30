# Dev-only helper: capture THIS app's own window so the UI can be inspected
# without grabbing the whole desktop. Uses PrintWindow(PW_RENDERFULLCONTENT)
# so occlusion by other windows does not matter.
# ASCII only -- PowerShell here reads non-ASCII as GBK and breaks parsing.
param(
  # Defaults are the main window (1280x713 DIP) as measured in PHYSICAL pixels
  # on this machine's 150% scaling. Pass different values for the pet window.
  [int]$Width = 1941,
  [int]$Height = 1082,
  [string]$Out = "shot.png",
  [string]$MatchTitle = "",
  [string]$Pick = "largest",
  [switch]$UseScreen,
  # Packaged builds run as 事件提醒.exe, not electron.exe -- pass the name here.
  # Kept as a parameter rather than hardcoded because this file must stay ASCII.
  [string]$Proc = "electron"
)

# Must run before any window/screen API: without this the process is DPI
# virtualized and reports scaled-down sizes, so captures come out as a
# magnified crop of the window instead of the whole thing.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DpiAware {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][DpiAware]::SetProcessDPIAware()

Add-Type -AssemblyName System.Drawing, System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Output ("screen: {0}x{1}" -f $scr.Width, $scr.Height)

# Collect every visible window here, filter afterwards.
# Deliberately no parameter references inside the callback: it runs as a .NET
# delegate, where PowerShell does not reliably resolve variables from the
# enclosing scope -- a $Proc lookup there silently yields $null, which makes
# every -like comparison fail and reports NO_WINDOW no matter what.
$script:all = New-Object System.Collections.ArrayList

$cb = [Win+EnumProc]{
  param($h, $p)
  if (-not [Win]::IsWindowVisible($h)) { return $true }
  $pid2 = 0
  [void][Win]::GetWindowThreadProcessId($h, [ref]$pid2)
  $proc = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
  $r = New-Object Win+RECT
  [void][Win]::GetWindowRect($h, [ref]$r)
  $len = [Win]::GetWindowTextLength($h)
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][Win]::GetWindowText($h, $sb, $sb.Capacity)
  [void]$script:all.Add([pscustomobject]@{
    H = $h; W = ($r.Right - $r.Left); Hh = ($r.Bottom - $r.Top)
    L = $r.Left; T = $r.Top; Title = $sb.ToString()
    Proc = $(if ($proc) { $proc.ProcessName } else { "" })
  })
  return $true
}
[void][Win]::EnumWindows($cb, [IntPtr]::Zero)

# >= 60px on both axes: skips the 1x1 and 158x26 helper windows that Windows
# and various tray apps leave lying around, which would otherwise win -Pick smallest
$found = @($script:all | Where-Object { $_.Proc -like $Proc -and $_.W -ge 60 -and $_.Hh -ge 60 })

if ($found.Count -eq 0) {
  Write-Output "NO_WINDOW (proc filter: '$Proc'; saw: $(($script:all | Select-Object -ExpandProperty Proc -Unique) -join ', '))"
  exit 1
}

Write-Output "windows:"
foreach ($f in $found) { Write-Output ("  {0}x{1} at ({2},{3}) [{4}]" -f $f.W, $f.Hh, $f.L, $f.T, $f.Proc) }

if ($Pick -eq "smallest") {
  $win = $found | Sort-Object { $_.W * $_.Hh } | Select-Object -First 1
} elseif ($MatchTitle -ne "") {
  $win = $found | Where-Object { $_.Title -like "*$MatchTitle*" } | Select-Object -First 1
} else {
  # Exact size is the most reliable discriminator here: it sidesteps both the
  # process-name filter (a Chinese exe name is awkward to pass through bash)
  # and the taskbar / overlay windows that win any "smallest area" contest.
  $win = $found | Where-Object { $_.W -eq $Width -and $_.Hh -eq $Height } | Select-Object -First 1
  if (-not $win) {
    $win = $found | Where-Object { $_.W -ge $Width -and $_.Hh -ge $Height } |
           Sort-Object { $_.W * $_.Hh } | Select-Object -First 1
  }
}
if (-not $win) {
  $win = $found | Sort-Object { $_.W * $_.Hh } -Descending | Select-Object -First 1
}

$r2 = New-Object Win+RECT
[void][Win]::GetWindowRect($win.H, [ref]$r2)
$w2 = $r2.Right - $r2.Left
$h2 = $r2.Bottom - $r2.Top

$bmp = New-Object System.Drawing.Bitmap $w2, $h2
$g = [System.Drawing.Graphics]::FromImage($bmp)
# PrintWindow renders the window's own content, so occlusion doesn't matter
# and we never have to raise or focus it.
#
# Deliberately NO SetForegroundWindow: activating a Chromium window makes it
# deliver a synthetic activation click at the cursor position, which presses
# whatever button happens to be under the pointer. That silently clicked the
# alert dialog's "complete" button during testing and looked like an app bug.
if ($UseScreen) {
  # Real screen pixels -- needed to confirm a transparent window really is
  # see-through (PrintWindow renders alpha=0 as black, which is ambiguous).
  $g.CopyFromScreen($r2.Left, $r2.Top, 0, 0, (New-Object System.Drawing.Size $w2, $h2))
} else {
  $hdc = $g.GetHdc()
  [void][Win]::PrintWindow($win.H, $hdc, 2)   # 2 = PW_RENDERFULLCONTENT
  $g.ReleaseHdc($hdc)
}
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output ("saved {0} ({1}x{2})" -f $Out, $w2, $h2)
