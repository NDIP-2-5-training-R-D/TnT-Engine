# scripts/setup.ps1
# Setup script for NDIP T&T Engine - OpenBao initialization

$ErrorActionPreference = "Stop"

$BAO_ADDR  = "http://localhost:8200"
$BAO_TOKEN = "root"
$Headers   = @{ "X-Vault-Token" = $BAO_TOKEN; "Content-Type" = "application/json" }

function Invoke-Bao {
    param([string]$Method, [string]$Path, [hashtable]$Body = @{})
    $uri  = "$BAO_ADDR/v1/$Path"
    $json = $Body | ConvertTo-Json -Depth 10
    try {
        return Invoke-RestMethod -Uri $uri -Method $Method -Headers $Headers -Body $json
    } catch {
        $status = $_.Exception.Response.StatusCode.value__
        if ($status -eq 400) { return $null }   # already exists = OK
        Write-Host "  [WARN] $Method $Path -> HTTP $status"
        return $null
    }
}

# 1. Start containers (OpenBao + tnt-engine)
Write-Host ""
Write-Host "==> Starting containers via Docker Compose..."
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed" }

# 2. Wait for OpenBao healthy
Write-Host "==> Waiting for OpenBao to be healthy..."
$maxRetries = 30
$retryCount = 0
$healthy    = $false

while (-not $healthy -and $retryCount -lt $maxRetries) {
    Start-Sleep -Seconds 2
    $retryCount++
    try {
        $health = Invoke-RestMethod -Uri "$BAO_ADDR/v1/sys/health" -Method GET -ErrorAction SilentlyContinue
        if ($health.initialized -eq $true -and $health.sealed -eq $false) { $healthy = $true }
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($code -in @(200, 429, 473)) { $healthy = $true }
    }
    Write-Host "  Attempt $retryCount/$maxRetries - healthy: $healthy"
}

if (-not $healthy) { throw "OpenBao did not become healthy after $maxRetries attempts." }
Write-Host "  OpenBao is healthy!"

# 3. Enable Transit secrets engine
Write-Host "==> Enabling Transit secrets engine..."
Invoke-Bao -Method POST -Path "sys/mounts/transit" -Body @{
    type        = "transit"
    description = "NDIP encryption / signing"
}

# 4. Create Transit key
Write-Host "==> Creating Transit key 'ndip-key'..."
Invoke-Bao -Method POST -Path "transit/keys/ndip-key" -Body @{
    type = "aes256-gcm96"
}

# Note: FPE tokenization uses Python ff3 inside tnt-engine container
Write-Host "  [INFO] FPE tokenization runs inside tnt-engine container (ff3 library)"

# Done
$sep = "=" * 40
Write-Host ""
Write-Host $sep
Write-Host "  Done! Stack is ready."
Write-Host "  OpenBao  : $BAO_ADDR"
Write-Host "  API      : http://localhost:8000"
Write-Host "  Swagger  : http://localhost:8000/docs"
Write-Host "  Transit key: ndip-key"
Write-Host "  FPE token  : via tnt-engine /api/v1/transform/tokenize"
Write-Host $sep
Write-Host ""
