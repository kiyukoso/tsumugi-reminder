# Dev-only: list every visible top-level window with its owning process and
# size. Used to work out why a capture targeted the wrong window.
# ASCII only -- PowerShell on this machine parses non-ASCII as GBK and breaks.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class D {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

# Output written from inside the EnumWindows callback does NOT reach the
# pipeline (it runs as a .NET delegate), so collect first and print after.
$script:rows = New-Object System.Collections.ArrayList

$cb = [D+EnumProc]{
  param($h, $p)
  $vis = [D]::IsWindowVisible($h)
  $pid2 = 0
  [void][D]::GetWindowThreadProcessId($h, [ref]$pid2)
  $proc = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
  $name = if ($proc) { $proc.ProcessName } else { "<gone>" }
  $r = New-Object D+RECT
  [void][D]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left
  $hh = $r.Bottom - $r.Top
  if ($w -gt 0 -and $hh -gt 0) {
    [void]$script:rows.Add([pscustomobject]@{
      Vis = $vis; Name = $name; W = $w; H = $hh; L = $r.Left; T = $r.Top; Pid = $pid2
    })
  }
  return $true
}
[void][D]::EnumWindows($cb, [IntPtr]::Zero)

foreach ($row in ($script:rows | Sort-Object -Property @{Expression={$_.Vis};Descending=$true}, Name)) {
  $flag = if ($row.Vis) { "VIS" } else { "hid" }
  Write-Output ("  {0} {1,-26} {2,5}x{3,-5} at ({4},{5}) pid={6}" -f $flag, $row.Name, $row.W, $row.H, $row.L, $row.T, $row.Pid)
}
Write-Output ("total sized windows: " + $script:rows.Count)
Write-Output ("visible: " + ($script:rows | Where-Object { $_.Vis }).Count)
