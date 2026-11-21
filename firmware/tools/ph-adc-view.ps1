# Live pH / ADC dashboard for the ESP32-S3 board. Redraws one screen every reading (5 s).
#   powershell -ExecutionPolicy Bypass -File ph-adc-view.ps1 [-Port COM3]
# Shows A0 (pH) volts and ADS1115 counts, the 12-reading sliding window (avg / sd / stable),
# the pH the board computes, the TDS input (A1) and water temperature. Ctrl+C = stop.
# Only one program can open the port: close Arduino Serial Monitor and ph-calibrate.ps1 first.
# -Target: volts to tune the pH module trimmer to (shown as a +/- mV difference). -Slow: keep 5 s readings.
param([string]$Port = 'COM3', [int]$Baud = 115200, [double]$Target = 2.50, [switch]$Slow)

$LSB = 4.096 / 32768        # ADS1115 at PGA +/-4.096 V: 0.125 mV per count
$inv = [Globalization.CultureInfo]::InvariantCulture
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$logFile = Join-Path $here 'ph_log.csv'
if (-not (Test-Path $logFile)) { 'time,raw_v,avg_v,sd_v,n,state' | Out-File $logFile -Encoding ascii }

$st = @{ raw = $null; avg = $null; sd = $null; n = 0; win = 12; state = '-'; ph = $null; cal = '?';
         tdsV = $null; tdsState = '-'; temp = $null; msg = 'waiting for the board...'; at = $null }
$hist = New-Object System.Collections.Generic.List[double]

function Bar([double]$v, [double]$lo, [double]$hi, [int]$w) {
  # 0.0 / 1.0 (not 0 / 1): with int literals [math]::Min picks the Int32 overload and rounds to 0
  $f = [math]::Max(0.0, [math]::Min(1.0, [double](($v - $lo) / ($hi - $lo)))); $k = [int][math]::Round($f * $w)
  ('#' * $k) + ('.' * ($w - $k))
}
function Fmt($v, $f) { if ($null -eq $v) { '   --   ' } else { $v.ToString($f, $inv) } }

function Draw {
  Clear-Host
  $line = '=' * 64
  Write-Host $line -ForegroundColor DarkCyan
  Write-Host ("  pH PROBE  (ADS1115 A0)        {0}   port {1}" -f (Get-Date -Format 'HH:mm:ss'), $Port) -ForegroundColor Cyan
  Write-Host $line -ForegroundColor DarkCyan
  if ($null -ne $st.raw) {
    $cnt = [int][math]::Round($st.raw / $LSB)
    Write-Host ''
    Write-Host ('   NOW        {0} V      ADC {1,6} counts' -f (Fmt $st.raw '0.0000'), $cnt) -ForegroundColor White
    Write-Host ('              0 V [{0}] 3.3 V' -f (Bar $st.raw 0 3.3 40)) -ForegroundColor DarkGray
    if ($PSBoundParameters.ContainsKey('Target')) {   # trimmer tuning hint only when -Target is given
    $d = ($st.raw - $Target) * 1000
    $dc = if ([math]::Abs($d) -le 5) { 'Green' } elseif ([math]::Abs($d) -le 50) { 'Yellow' } else { 'Red' }
    $hint = if ([math]::Abs($d) -le 5) { 'ON TARGET' } elseif ($d -gt 0) { 'too HIGH - turn the trimmer to lower it' } else { 'too LOW - turn the trimmer to raise it' }
    Write-Host ('   TARGET     {0} V      diff {1,8} mV   {2}' -f $Target.ToString('0.0000', $inv), $d.ToString('+0.0;-0.0;0.0', $inv), $hint) -ForegroundColor $dc
    }
    Write-Host ''
    $acnt = if ($null -ne $st.avg) { [int][math]::Round($st.avg / $LSB) } else { 0 }
    Write-Host ('   AVERAGE    {0} V      ADC {1,6} counts   (last {2}/{3} readings)' -f (Fmt $st.avg '0.0000'), $acnt, $st.n, $st.win) -ForegroundColor Yellow
    $sdmv = if ($null -ne $st.sd) { $st.sd * 1000 } else { $null }
    $color = if ($st.state -eq 'STABLE') { 'Green' } else { 'Yellow' }
    Write-Host ('   SPREAD     {0} mV (sd)   ->  {1}' -f (Fmt $sdmv '0.00'), $(if ($st.state -eq 'STABLE') { 'STABLE - ready to calibrate' } else { 'settling (wait until n=12/12 and STABLE)' })) -ForegroundColor $color
    Write-Host ''
    $phTxt = if ($null -ne $st.ph -and $st.ph -ge 0) { $st.ph.ToString('0.00', $inv) } else { '--' }
    Write-Host ('   pH (board) {0}    {1}' -f $phTxt, $(if ($st.cal -eq '~') { '<- NOT calibrated yet (default curve)' } else { 'calibrated' })) -ForegroundColor $(if ($st.cal -eq '~') { 'DarkYellow' } else { 'Green' })
  } else {
    Write-Host ''
    Write-Host "   $($st.msg)" -ForegroundColor Yellow
  }
  Write-Host ''
  Write-Host ('-' * 64) -ForegroundColor DarkCyan
  Write-Host '  last readings (oldest -> newest), volts / ADC counts' -ForegroundColor DarkGray
  if ($hist.Count -gt 0) {
    $min = ($hist | Measure-Object -Minimum).Minimum; $max = ($hist | Measure-Object -Maximum).Maximum
    foreach ($v in $hist) {
      $span = [math]::Max(0.002, $max - $min)
      Write-Host ('   {0} V  {1,6}  |{2}|' -f $v.ToString('0.0000', $inv), [int][math]::Round($v / $LSB), (Bar $v ($min - $span * 0.1) ($max + $span * 0.1) 30)) -ForegroundColor Gray
    }
    Write-Host ('   range in window: {0:N1} mV' -f (($max - $min) * 1000)) -ForegroundColor DarkGray
  }
  Write-Host ('-' * 64) -ForegroundColor DarkCyan
  Write-Host ('  TDS A1  {0} V  ({1})     water temp {2} C' -f (Fmt $st.tdsV '0.000'), $st.tdsState, (Fmt $st.temp '0.0')) -ForegroundColor DarkGray
  if ($st.msg -and $null -ne $st.raw) { Write-Host "  $($st.msg)" -ForegroundColor Red }
  Write-Host '  Ctrl+C = stop' -ForegroundColor DarkGray
}

$buffer = ''
Draw
while ($true) {
  $sp = New-Object System.IO.Ports.SerialPort $Port, $Baud
  $sp.DtrEnable = $false; $sp.RtsEnable = $false      # no reset of the board when the port opens
  try {
    $sp.Open(); $sp.NewLine = "`n"; $st.msg = 'connected, waiting for the next reading...'; Draw
    $last = Get-Date
    $fastSent = [datetime]::MinValue
    while ($sp.IsOpen) {
      # ask the board for one reading per second (it falls back to 5 s by itself after 10 min)
      if (-not $Slow -and ((Get-Date) - $fastSent).TotalMinutes -ge 5) { try { $sp.WriteLine('fast') } catch {}; $fastSent = Get-Date }
      $chunk = $sp.ReadExisting()
      if ($chunk) {
        $last = Get-Date; $buffer += $chunk; $redraw = $false
        while ($buffer.Contains("`n")) {
          $i = $buffer.IndexOf("`n"); $l = $buffer.Substring(0, $i).TrimEnd("`r"); $buffer = $buffer.Substring($i + 1)
          if ($l -match '\[PH\] raw=([\d.]+)V avg=([\d.]+)V sd=([\d.]+)V n=(\d+)/(\d+) (\w+) pH=(~?)(-?[\d.]+)') {
            $st.raw = [double]::Parse($Matches[1], $inv); $st.avg = [double]::Parse($Matches[2], $inv); $st.sd = [double]::Parse($Matches[3], $inv)
            $st.n = [int]$Matches[4]; $st.win = [int]$Matches[5]; $st.state = $Matches[6]; $st.cal = $Matches[7]; $st.ph = [double]::Parse($Matches[8], $inv)
            $st.msg = ''
            $hist.Add($st.raw); if ($hist.Count -gt $st.win) { $hist.RemoveAt(0) }
            ('{0},{1},{2},{3},{4},{5}' -f (Get-Date -Format s), $Matches[1], $Matches[2], $Matches[3], $Matches[4], $Matches[6]) | Add-Content $logFile
            $redraw = $true
          } elseif ($l -match '\[PH\] raw=([\d.]+)V rejected \(([^)]*)\)') {
            $st.raw = [double]::Parse($Matches[1], $inv); $st.n = 0; $st.state = 'rejected'; $st.msg = "reading rejected: $($Matches[2]) - window restarted"
            $hist.Clear(); $redraw = $true
          } elseif ($l -match 'TDS A1=([\d.]+)V spread=[\d.]+V -> (\S+)') {
            $st.tdsV = [double]::Parse($Matches[1], $inv); $st.tdsState = $Matches[2]
          } elseif ($l -match '\[DS18B20\].*OK ([\d.]+) C') {
            $st.temp = [double]::Parse($Matches[1], $inv)
          }
        }
        if ($redraw) { Draw }
      } elseif (((Get-Date) - $last).TotalSeconds -gt 15) {
        $st.msg = 'no data for 12 s - reconnecting...'; Draw; break
      }
      Start-Sleep -Milliseconds 150
    }
  } catch {
    $st.msg = "$Port not available ($($_.Exception.Message.Split([Environment]::NewLine)[0])) - close other serial monitors; retrying..."; Draw
  } finally {
    # the USB port may already be gone (board unplugged / reset): never let closing it stop the screen
    try { if ($sp.IsOpen) { $sp.Close() } } catch {}
    try { $sp.Dispose() } catch {}
  }
  Start-Sleep -Seconds 2
}
