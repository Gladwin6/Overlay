# Build SwBridge.exe (single self-contained executable for Windows x64)
# Run this once from the sw-bridge directory:  .\build.ps1
# Output goes to: sw-bridge\bin\SwBridge.exe

$outDir = "$PSScriptRoot\bin"
dotnet publish "$PSScriptRoot\SwBridge.csproj" `
  -c Release `
  -r win-x64 `
  --self-contained true `
  /p:PublishSingleFile=true `
  -o $outDir

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n[OK] SwBridge.exe built at: $outDir\SwBridge.exe" -ForegroundColor Green
} else {
    Write-Host "`n[FAIL] Build failed" -ForegroundColor Red
}
