# Đóng gói code để đưa lên VPS (chạy trên Windows)
#   powershell -ExecutionPolicy Bypass -File deploy\pack.ps1
# Kết quả: file api-server.tar.gz ở thư mục gốc dự án (không gồm node_modules, data)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$items = @('src', 'public', 'scripts', 'deploy', 'package.json', 'package-lock.json', 'ecosystem.config.cjs',
           '.env.example', '.env', 'credentials', 'README.md', 'HUONG-DAN.md', 'TRIEN-KHAI-VPS.md') |
         Where-Object { Test-Path $_ }

if (-not (Test-Path 'credentials\service-account.json')) {
  Write-Host 'Thiếu credentials\service-account.json - server trên VPS sẽ không đọc được Google Sheet.' -ForegroundColor Yellow
}

$out = Join-Path $root 'api-server.tar.gz'
if (Test-Path $out) { Remove-Item $out -Force }

# tar.exe có sẵn trên Windows 10/11
& tar.exe -czf 'api-server.tar.gz' @items
if ($LASTEXITCODE -ne 0) { throw "tar lỗi (mã $LASTEXITCODE)" }

$size = [math]::Round((Get-Item $out).Length / 1KB)
Write-Host ''
Write-Host "Đã tạo: $out ($size KB)" -ForegroundColor Green
Write-Host 'Gồm:' ($items -join ', ')
Write-Host ''
Write-Host 'Bước tiếp theo (thay IP_VPS bằng IP của bạn):' -ForegroundColor Cyan
Write-Host '  scp api-server.tar.gz root@IP_VPS:/root/'
Write-Host '  ssh root@IP_VPS'
