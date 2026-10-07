$ErrorActionPreference = 'Stop'

$planPath = Join-Path $PSScriptRoot '..\docs\anicore-feature-plan.html'
if (-not (Test-Path -LiteralPath $planPath -PathType Leaf)) {
    throw "Feature plan not found: $planPath"
}

$resolvedPlanPath = (Resolve-Path -LiteralPath $planPath).Path
Start-Process -FilePath $resolvedPlanPath
