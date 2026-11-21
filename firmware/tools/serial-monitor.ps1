# Serial monitor for the ESP32-S3 board (native USB CDC).
# Arduino IDE's Serial Monitor often stops after the board resets, because the USB port
# disappears and comes back. This one reopens the port by itself and keeps printing.
# Usage:  powershell -ExecutionPolicy Bypass -File serial-monitor.ps1 [-Port COM3] [-Filter ADC]
# Stop with Ctrl+C. Close Arduino IDE's Serial Monitor first (only one program can open the port).
param(
  [string]$Port = 'COM3',
  [int]$Baud = 115200,
  [string]$Filter = ''   # e.g. 'ADC' shows only the pH / TDS voltage lines
)

Write-Host "Serial monitor $Port @ $Baud  (Ctrl+C = stop)" -ForegroundColor Cyan
if ($Filter) { Write-Host "Showing only lines containing: $Filter" -ForegroundColor Cyan }

$buffer = ''
while ($true) {
  $sp = New-Object System.IO.Ports.SerialPort $Port, $Baud
  # DTR/RTS stay low: toggling them on open resets the ESP32-S3, and after that reset the USB port
  # comes back as a new connection, so the monitor would only ever see the "ESP-ROM" line.
  $sp.DtrEnable = $false
  $sp.RtsEnable = $false
  try {
    $sp.Open()
    Write-Host "[connected to $Port]" -ForegroundColor Green
    $lastData = Get-Date
    while ($sp.IsOpen) {
      $chunk = $sp.ReadExisting()
      # The board prints at least every 10 s. Silence = the board reset and its USB port came back
      # as a new connection (the old handle stays "open" but dead) -> reopen.
      if (-not $chunk -and ((Get-Date) - $lastData).TotalSeconds -gt 12) {
        Write-Host "[no data for 12 s - reconnecting]" -ForegroundColor DarkYellow
        break
      }
      if ($chunk) {
        $lastData = Get-Date
        $buffer += $chunk
        while ($buffer.Contains("`n")) {
          $i = $buffer.IndexOf("`n")
          $line = $buffer.Substring(0, $i).TrimEnd("`r")
          $buffer = $buffer.Substring($i + 1)
          if (-not $Filter -or $line -like "*$Filter*") {
            $stamp = Get-Date -Format 'HH:mm:ss'
            if ($line -match '\[ADC\] pH') { Write-Host "$stamp $line" -ForegroundColor Yellow }
            else { Write-Host "$stamp $line" }
          }
        }
      }
      Start-Sleep -Milliseconds 100
    }
  } catch {
    Write-Host "[$Port not available: $($_.Exception.Message.Split([Environment]::NewLine)[0]) - retrying in 2 s]" -ForegroundColor DarkYellow
  } finally {
    if ($sp.IsOpen) { $sp.Close() }
    $sp.Dispose()
  }
  Start-Sleep -Seconds 2
}
