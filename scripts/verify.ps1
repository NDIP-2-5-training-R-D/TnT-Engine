# scripts/verify.ps1
$BAO_ADDR  = "http://localhost:8200"
$BAO_TOKEN = "root"
$API_ADDR  = "http://localhost:8000"
$PHONE     = "0912345678"
$BaoHeaders = @{ "X-Vault-Token" = $BAO_TOKEN; "Content-Type" = "application/json" }
$ApiHeaders = @{ "Content-Type" = "application/json" }

$pass = 0
$fail = 0

function Write-Pass($msg) { Write-Host "  [PASS] $msg" -ForegroundColor Green; $script:pass++ }
function Write-Fail($msg) { Write-Host "  [FAIL] $msg" -ForegroundColor Red;  $script:fail++ }
function Write-Sep($msg)  { Write-Host ""; Write-Host "--- $msg ---" -ForegroundColor Cyan }

# 1. OpenBao health
Write-Sep "1. OpenBao Health"
try {
    $h = Invoke-RestMethod -Uri "$BAO_ADDR/v1/sys/health" -Method GET -TimeoutSec 5 -ErrorAction Stop
    if ($h.initialized -eq $true -and $h.sealed -eq $false) {
        Write-Pass "OpenBao OK (initialized=true, sealed=false)"
    } else {
        Write-Fail "OpenBao unhealthy (initialized=$($h.initialized), sealed=$($h.sealed))"
    }
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -in @(200,429,473)) { Write-Pass "OpenBao OK (HTTP $code)" }
    else { Write-Fail "Cannot connect to OpenBao: $_" }
}

# 2. Transit mount
Write-Sep "2. Secrets Engine Mounts"
try {
    $mounts = Invoke-RestMethod -Uri "$BAO_ADDR/v1/sys/mounts" -Method GET -Headers $BaoHeaders -TimeoutSec 5 -ErrorAction Stop
    $keys = $mounts.PSObject.Properties.Name
    if ($keys -contains "transit/") { Write-Pass "Transit engine: OK" }
    else                            { Write-Fail "Transit engine: MISSING" }
} catch {
    Write-Fail "Cannot list mounts: $_"
}

# 3. T&T Engine API health
Write-Sep "3. T&T Engine API Health"
try {
    $h = Invoke-RestMethod -Uri "$API_ADDR/health" -Method GET -TimeoutSec 5 -ErrorAction Stop
    if ($h.status -eq "ok") { Write-Pass "T&T Engine API OK" }
    else                    { Write-Fail "T&T Engine API unhealthy: $($h.status)" }
} catch {
    Write-Fail "Cannot connect to T&T Engine API: $_"
}

# 4. Transit encrypt/decrypt via API
Write-Sep "4. Transit Encrypt/Decrypt via API (round-trip)"
$ciphertext = $null
try {
    $body = "{`"plaintext`":`"$PHONE`",`"key_name`":`"ndip-key`"}"
    $resp = Invoke-RestMethod -Uri "$API_ADDR/api/v1/transit/encrypt" -Method POST -Headers $ApiHeaders -Body $body -TimeoutSec 5 -ErrorAction Stop
    $ciphertext = $resp.ciphertext
    Write-Pass "Encrypted OK: $ciphertext"
} catch {
    Write-Fail "Encrypt failed: $_"
}

if ($ciphertext) {
    try {
        $body = "{`"ciphertext`":`"$ciphertext`",`"key_name`":`"ndip-key`"}"
        $resp = Invoke-RestMethod -Uri "$API_ADDR/api/v1/transit/decrypt" -Method POST -Headers $ApiHeaders -Body $body -TimeoutSec 5 -ErrorAction Stop
        $decrypted = $resp.plaintext
        if ($decrypted -eq $PHONE) { Write-Pass "Decrypted OK: $decrypted (matches original)" }
        else                       { Write-Fail "Mismatch: got '$decrypted', expected '$PHONE'" }
    } catch {
        Write-Fail "Decrypt failed: $_"
    }
} else {
    Write-Fail "Skipped decrypt - no ciphertext"
}

# 5. FPE tokenize/detokenize via API
Write-Sep "5. FPE Tokenize/Detokenize via API (round-trip)"
$token = $null
try {
    $body = "{`"value`":`"$PHONE`"}"
    $resp = Invoke-RestMethod -Uri "$API_ADDR/api/v1/transform/tokenize" -Method POST -Headers $ApiHeaders -Body $body -TimeoutSec 5 -ErrorAction Stop
    $token = $resp.encoded_value
    Write-Pass "Tokenized OK: $token"
} catch {
    Write-Fail "Tokenize failed: $_"
}

if ($token) {
    try {
        $body = "{`"value`":`"$token`"}"
        $resp = Invoke-RestMethod -Uri "$API_ADDR/api/v1/transform/detokenize" -Method POST -Headers $ApiHeaders -Body $body -TimeoutSec 5 -ErrorAction Stop
        $decoded = $resp.decoded_value
        if ($decoded -eq $PHONE) { Write-Pass "Detokenized OK: $decoded (matches original)" }
        else                     { Write-Fail "Mismatch: got '$decoded', expected '$PHONE'" }
    } catch {
        Write-Fail "Detokenize failed: $_"
    }
} else {
    Write-Fail "Skipped detokenize - no token"
}

# Summary
$total = $pass + $fail
$sep = "=" * 40
Write-Host ""
Write-Host $sep
if ($fail -eq 0) {
    Write-Host "  Result: ALL PASS ($pass/$total)" -ForegroundColor Green
} else {
    Write-Host "  Result: $fail FAILED / $pass PASSED / $total total" -ForegroundColor Red
}
Write-Host $sep
Write-Host ""
