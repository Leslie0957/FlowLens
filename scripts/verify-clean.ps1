param([switch]$Offline)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$verificationRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'logs\m4'))
$cleanRoot = [IO.Path]::GetFullPath((Join-Path $verificationRoot ('clean-' + [guid]::NewGuid().ToString('N'))))
if (-not $cleanRoot.StartsWith($verificationRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $cleanRoot)) { throw 'Unsafe or existing verification path' }
New-Item -ItemType Directory -Path $cleanRoot -Force | Out-Null
# Include the current uncommitted deliverable; exclude ignored secrets/data/dependencies.
Push-Location $repoRoot
try {
    $sourceFiles = @(git ls-files --cached --others --exclude-standard)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate repository files' }
    foreach ($relativeFile in $sourceFiles) {
        $sourceFile = Join-Path $repoRoot $relativeFile
        if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) { continue }
        $destinationFile = Join-Path $cleanRoot $relativeFile
        New-Item -ItemType Directory -Path (Split-Path -Parent $destinationFile) -Force | Out-Null
        Copy-Item -LiteralPath $sourceFile -Destination $destinationFile
    }
} finally { Pop-Location }
@'
MODEL_MODE=MOCK
MODEL_API_KEY=
FLOWLENS_LIVE_APPROVED=0
FLOWLENS_LIVE_MAX_REQUESTS=0
APP_DB_PATH=data/flowlens.sqlite
APP_PORT=4176
'@ | Set-Content -LiteralPath (Join-Path $cleanRoot '.env.local') -Encoding utf8
$env:MODEL_MODE = 'MOCK'
$env:MODEL_API_KEY = ''
$env:FLOWLENS_LIVE_APPROVED = '0'
$env:FLOWLENS_LIVE_MAX_REQUESTS = '0'
$env:FLOWLENS_API_TARGET = 'http://127.0.0.1:4176'
$env:FLOWLENS_EVAL_WEB_PORT = '5176'
$checks = [Collections.Generic.List[object]]::new()
$reportPath = Join-Path $cleanRoot 'verification.json'
function Invoke-Verification([string]$Label, [string[]]$Arguments) {
    $started = Get-Date
    & pnpm @Arguments *> (Join-Path $cleanRoot ($Label + '.txt'))
    $code = $LASTEXITCODE
    $checks.Add(@{ check = $Label; arguments = $Arguments; exit_code = $code; elapsed_ms = [int]((Get-Date) - $started).TotalMilliseconds })
    @{ directory = $cleanRoot; node = (& node --version); pnpm = (& pnpm --version); offline_install = [bool]$Offline; checks = @($checks.ToArray()) } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding utf8
    Write-Output "$Label exit=$code"
    if ($code -ne 0) { throw "$Label failed; see $cleanRoot" }
}
Push-Location $cleanRoot
try {
    if ($Offline) { Invoke-Verification 'install' @('install','--frozen-lockfile','--offline') }
    else { Invoke-Verification 'install' @('install','--frozen-lockfile') }
    Invoke-Verification 'migrate' @('db:migrate')
    Invoke-Verification 'seed' @('db:seed')
    Invoke-Verification 'seed-again' @('db:seed')
    Invoke-Verification 'typecheck' @('typecheck')
    Invoke-Verification 'lint' @('lint')
    Invoke-Verification 'test' @('test')
    Invoke-Verification 'build' @('build')
    Invoke-Verification 'e2e' @('test:e2e')
    Invoke-Verification 'evaluation-mock' @('eval:mock')
    Invoke-Verification 'start-preview' @('check:start')
    Write-Output "Clean verification passed: $reportPath"
} finally { Pop-Location }
