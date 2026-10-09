param([switch]$DryRun, [string]$ConfigLibrary, [string]$GatewayOrigin)
if (-not $ConfigLibrary) { $ConfigLibrary = Join-Path $env:LOCALAPPDATA 'Claude-3p\configLibrary' }
if (-not $GatewayOrigin) { $GatewayOrigin = $env:OCX_CLAUDE_GATEWAY_ORIGIN }
$ErrorActionPreference = 'Stop'
$library = $ConfigLibrary
$mutex = New-Object Threading.Mutex($false, 'Local\OCXClaudeModelLabels')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
    $meta = Get-Content -Raw -LiteralPath (Join-Path $library '_meta.json') | ConvertFrom-Json
    $profileId = [guid]::Parse($meta.appliedId).ToString()
    $path = Join-Path $library ($profileId + '.json')
    $before = [IO.File]::ReadAllText($path)
    $profile = $before | ConvertFrom-Json
    if ($profile.inferenceProvider -ne 'gateway') { exit 0 }
    $origin = [uri]$profile.inferenceGatewayBaseUrl
    if (-not $origin.IsAbsoluteUri -or $origin.Scheme -notin @('http','https') -or $origin.UserInfo -or $origin.Query -or $origin.Fragment) { throw 'Invalid gateway origin' }
    # Never send a profile key to a different gateway or synchronize an unrelated profile.
    if ($GatewayOrigin -and $origin.AbsoluteUri.TrimEnd('/') -ne ([uri]$GatewayOrigin).AbsoluteUri.TrimEnd('/')) { throw 'Applied Claude profile does not match the active OCX gateway' }
    $discoveryUrl = $origin.AbsoluteUri.TrimEnd('/') + '/v1/models?ids=desktop'
    $headers = @{ 'anthropic-version' = '2023-06-01' }
    if ($profile.inferenceGatewayApiKey) { $headers.Authorization = 'Bearer ' + $profile.inferenceGatewayApiKey }
    $response = Invoke-RestMethod -Uri $discoveryUrl -Headers $headers -TimeoutSec 15 -MaximumRedirection 0
    if ($null -eq $response.data -or @($response.data).Count -gt 2000) { throw 'Invalid discovery response' }
    # Retain the last known list during an empty/unavailable catalog response.
    if (@($response.data).Count -eq 0) { throw 'Empty discovery response; retained existing models' }
    $seen = @{}
    $models = @($response.data | Where-Object { $_.id -notmatch '\[' } | ForEach-Object {
        if ($_.id -notmatch '^claude-[a-z0-9-]+$' -or -not $_.display_name -or $seen.ContainsKey($_.id)) { throw 'Invalid model entry' }
        $seen[$_.id] = $true
        $label = [string]$_.display_name
        if ($label.Length -gt 80 -or $label -match '[\[\]\r\n]') { throw 'Invalid model label' }
        $tier = if ($_.id -match '^claude-(haiku|sonnet|fable)-') { $Matches[1] } else { 'opus' }
        # Do not infer 1M capability from the gateway bracket alias (it can mean 750k).
        $row = [ordered]@{name=$_.id; labelOverride=$label; anthropicFamilyTier=$tier}
        $effort = $_.capabilities.effort
        foreach ($level in @('max','xhigh','high','medium','low')) {
            if ($effort.$level.supported) { $row.maxEffort=$level; break }
        }
        [pscustomobject]$row
    })
    if ($models.Count -eq 0) { throw 'No selectable models; retained existing models' }
    if ($DryRun) { $models | Select-Object name,labelOverride | ConvertTo-Json; exit 0 }
    $oldModels = ConvertTo-Json -InputObject @($profile.inferenceModels) -Depth 12 -Compress
    $newModels = ConvertTo-Json -InputObject $models -Depth 12 -Compress
    if ($oldModels -eq $newModels -and $profile.modelDiscoveryEnabled -eq $false) { Write-Output ('Unchanged: ' + $models.Count); exit 0 }
    $profile | Add-Member -Force NoteProperty inferenceModels $models
    $profile | Add-Member -Force NoteProperty modelDiscoveryEnabled $false
    $after = ConvertTo-Json -InputObject $profile -Depth 30
    $temp = $path + '.sync-' + [guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($temp, $after, (New-Object Text.UTF8Encoding($false)))
    if ([IO.File]::ReadAllText($path) -ne $before) { Remove-Item -LiteralPath $temp; throw 'Profile changed concurrently; retry next time' }
    [IO.File]::Replace($temp, $path, $path + '.before-label-sync.bak')
    Write-Output ('Updated: ' + $models.Count)
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
