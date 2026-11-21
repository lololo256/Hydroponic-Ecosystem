# Guided pH calibration for the ESP32-S3 board (firmware with the "[PH] raw=..." line, one per 5 s).
#
#   powershell -ExecutionPolicy Bypass -File ph-calibrate.ps1 [-Port COM3]
#
# Each step:
#   1. the tool ASKS you for the pH of the solution (measure it first with your pH meter / buffer label)
#   2. it then collects 12 NEW readings (1 min) from that solution only, shown live on one line
#   3. when the readings are steady it saves the point (pH -> volts) to ph_cal_points.csv
# Type  f  instead of a pH to fit a line through all points and store it on the board,
#       l  to list points, d to delete the last point, q to quit.
# Close Arduino IDE's Serial Monitor first (only one program can open the port).
param([string]$Port = 'COM3', [int]$Baud = 115200, [int]$Need = 12, [double]$MaxSd = 0.003)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pointsFile = Join-Path $here 'ph_cal_points.csv'
$logFile = Join-Path $here 'ph_log.csv'
if (-not (Test-Path $pointsFile)) { 'time,ph,avg_v,sd_v,n' | Out-File $pointsFile -Encoding ascii }
if (-not (Test-Path $logFile)) { 'time,raw_v,avg_v,sd_v,n,state' | Out-File $logFile -Encoding ascii }
$inv = [Globalization.CultureInfo]::InvariantCulture
$script:buffer = ''

function Get-Points {
  @(Import-Csv $pointsFile | ForEach-Object {
      [pscustomobject]@{ time = $_.time; ph = [double]::Parse($_.ph, $inv); v = [double]::Parse($_.avg_v, $inv); sd = [double]::Parse($_.sd_v, $inv) } })
}
function Show-Points {
  $pts = Get-Points
  if ($pts.Count -eq 0) { Write-Host '  (no points yet)' -ForegroundColor DarkGray; return }
  $i = 0
  foreach ($p in $pts) { $i++; Write-Host ('  {0}. pH {1,6:N2}  ->  {2:N4} V   (sd {3:N4} V)' -f $i, $p.ph, $p.v, $p.sd) -ForegroundColor Cyan }
}

# Reads whatever the board sent; returns the raw volts of each new [PH] line (and logs it).
function Read-PhLines([System.IO.Ports.SerialPort]$sp) {
  $out = @()
  $chunk = $sp.ReadExisting()
  if ($chunk) { $script:buffer += $chunk }
  while ($script:buffer.Contains("`n")) {
    $i = $script:buffer.IndexOf("`n"); $line = $script:buffer.Substring(0, $i).TrimEnd("`r"); $script:buffer = $script:buffer.Substring($i + 1)
    if ($line -match '\[PH\] raw=([\d.]+)V avg=([\d.]+)V sd=([\d.]+)V n=(\d+)/(\d+) (\w+)') {
      ('{0},{1},{2},{3},{4},{5}' -f (Get-Date -Format s), $Matches[1], $Matches[2], $Matches[3], $Matches[4], $Matches[6]) | Add-Content $logFile
      $out += [double]::Parse($Matches[1], $inv)
    } elseif ($line -match '\[PH\] raw=.*rejected') {
      $out += [double]::NaN
      Write-Host "`n  board: $line" -ForegroundColor Red
    } elseif ($line -match '\[CAL\]') {
      Write-Host "`n  board: $line" -ForegroundColor Magenta
    }
  }
  , $out
}

function Get-Stats([double[]]$v) {
  $m = ($v | Measure-Object -Average).Average
  $sd = 0.0
  if ($v.Count -gt 1) { $sd = [math]::Sqrt((($v | ForEach-Object { ($_ - $m) * ($_ - $m) }) | Measure-Object -Sum).Sum / ($v.Count - 1)) }
  @{ mean = $m; sd = $sd }
}

function Measure-Point([System.IO.Ports.SerialPort]$sp, [double]$ph) {
  [void](Read-PhLines $sp)           # drop readings from before the question (old solution)
  $vals = New-Object System.Collections.Generic.List[double]
  Write-Host ("  measuring pH {0}: collecting {1} new readings (5 s each). Enter = accept now, Esc = cancel" -f $ph, $Need) -ForegroundColor Yellow
  $lastData = Get-Date
  while ($true) {
    foreach ($r in (Read-PhLines $sp)) {
      $lastData = Get-Date
      if ([double]::IsNaN($r)) { $vals.Clear(); continue }   # rejected reading: start over
      $vals.Add($r)
      if ($vals.Count -gt $Need) { $vals.RemoveAt(0) }       # sliding window of the newest $Need readings
    }
    if (((Get-Date) - $lastData).TotalSeconds -gt 20) { Write-Host "`n  no data from the board for 20 s" -ForegroundColor Red; return $null }
    if ($vals.Count -gt 0) {
      $st = Get-Stats $vals.ToArray()
      $ok = ($vals.Count -ge $Need -and $st.sd -le $MaxSd)
      $state = if ($ok) { 'STABLE - saving' } elseif ($vals.Count -ge $Need) { 'still moving, waiting...' } else { 'collecting' }
      $color = if ($ok) { 'Green' } else { 'Yellow' }
      Write-Host -NoNewline ("`r  live  now {0:N4} V   avg {1:N4} V   sd {2:N4} V   {3,2}/{4}   {5,-26}" -f $vals[$vals.Count - 1], $st.mean, $st.sd, $vals.Count, $Need, $state) -ForegroundColor $color
      if ($ok) { Write-Host ''; return @{ mean = $st.mean; sd = $st.sd; n = $vals.Count } }
    }
    while ([Console]::KeyAvailable) {
      $k = [Console]::ReadKey($true)
      if ($k.Key -eq 'Escape') { Write-Host "`n  cancelled" -ForegroundColor Yellow; return $null }
      if ($k.Key -eq 'Enter' -and $vals.Count -ge 3) { $st = Get-Stats $vals.ToArray(); Write-Host "`n  accepted early" -ForegroundColor Yellow; return @{ mean = $st.mean; sd = $st.sd; n = $vals.Count } }
    }
    Start-Sleep -Milliseconds 200
  }
}

function Invoke-Fit([System.IO.Ports.SerialPort]$sp) {
  $pts = Get-Points
  if ($pts.Count -lt 2) { Write-Host '  need at least 2 points with different pH' -ForegroundColor Yellow; return }
  $mx = ($pts | Measure-Object ph -Average).Average; $my = ($pts | Measure-Object v -Average).Average
  $sxx = 0.0; $sxy = 0.0; $syy = 0.0
  foreach ($p in $pts) { $sxx += ($p.ph - $mx) * ($p.ph - $mx); $sxy += ($p.ph - $mx) * ($p.v - $my); $syy += ($p.v - $my) * ($p.v - $my) }
  if ($sxx -le 0) { Write-Host '  all points have the same pH' -ForegroundColor Yellow; return }
  $b = $sxy / $sxx; $a = $my - $b * $mx
  $r2 = if ($syy -gt 0) { ($sxy * $sxy) / ($sxx * $syy) } else { 0 }
  $v7 = $a + 7 * $b; $v4 = $a + 4 * $b
  Write-Host ('  line through {0} points: V = {1:N4} + ({2:N4}) x pH   slope {3:N1} mV/pH   R^2 {4:N4}' -f $pts.Count, $a, $b, ($b * 1000), $r2) -ForegroundColor Green
  Write-Host ('  V at pH 7 = {0:N4} V   V at pH 4 = {1:N4} V   (a good probe: about -50 to -59 mV/pH)' -f $v7, $v4) -ForegroundColor Green
  foreach ($p in $pts) { if ($b -ne 0) { $f = ($p.v - $a) / $b; Write-Host ('     pH {0,6:N2} would read {1,6:N2}' -f $p.ph, $f) } }
  if ([math]::Abs($v7 - $v4) -lt 0.10) { Write-Host '  pH 7 and pH 4 less than 0.10 V apart: the probe hardly responds - the board will refuse it' -ForegroundColor Red; return }
  if ((Read-Host '  store this on the board? (y/n)') -eq 'y') {
    $cmd = 'calset {0} {1}' -f $v7.ToString('0.0000', $inv), $v4.ToString('0.0000', $inv)
    $sp.WriteLine($cmd); Write-Host "  sent: $cmd" -ForegroundColor Green
    Start-Sleep -Milliseconds 800; [void](Read-PhLines $sp)
  }
}

Write-Host "Guided pH calibration on $Port" -ForegroundColor Cyan
Show-Points
$sp = New-Object System.IO.Ports.SerialPort $Port, $Baud
$sp.DtrEnable = $false; $sp.RtsEnable = $false; $sp.NewLine = "`n"
try { $sp.Open() } catch { Write-Host "cannot open $Port : $($_.Exception.Message)  (close Arduino Serial Monitor / other monitors)" -ForegroundColor Red; return }
Write-Host "[connected to $Port]" -ForegroundColor Green
$step = @(Get-Points).Count
try {
  while ($true) {
    $step++
    Write-Host ''
    Write-Host ("STEP {0}: put the probe in the solution, measure its pH with your meter first." -f $step) -ForegroundColor White
    $ans = (Read-Host '  pH of the solution (number), or f=fit+store  l=list  d=delete last  q=quit').Trim()
    if ($ans -eq 'q') { break }
    if ($ans -eq 'l') { Show-Points; $step--; continue }
    if ($ans -eq 'f') { Invoke-Fit $sp; $step--; continue }
    if ($ans -eq 'd') {
      $all = @(Get-Content $pointsFile); if ($all.Count -gt 1) { $all[0..($all.Count - 2)] | Set-Content $pointsFile -Encoding ascii; Write-Host '  last point deleted' -ForegroundColor Yellow }
      Show-Points; $step = (Get-Points).Count; continue
    }
    $ph = 0.0
    if (-not [double]::TryParse($ans, [Globalization.NumberStyles]::Float, $inv, [ref]$ph) -or $ph -lt 0 -or $ph -gt 14) { Write-Host '  type a pH between 0 and 14' -ForegroundColor Yellow; $step--; continue }
    $r = Measure-Point $sp $ph
    if (-not $r) { $step--; continue }
    ('{0},{1},{2},{3},{4}' -f (Get-Date -Format s), $ph.ToString($inv), $r.mean.ToString('0.0000', $inv), $r.sd.ToString('0.0000', $inv), $r.n) | Add-Content $pointsFile
    Write-Host ('  SAVED: pH {0} -> {1:N4} V (sd {2:N4} V, {3} readings)' -f $ph, $r.mean, $r.sd, $r.n) -ForegroundColor Green
    Show-Points
  }
} finally { if ($sp.IsOpen) { $sp.Close() }; $sp.Dispose() }
