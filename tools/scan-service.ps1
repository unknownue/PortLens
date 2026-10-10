# scan-service.ps1 - dig service facts out of a directory and emit a PortLens manifest draft.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan-service.ps1 -Path E:\Workspace\dev-kit\stzbmcp
#   ... -Path <dir> -Port 15901 -Name "stzbmcp host" -Json > draft.json
#
# Output (default): human-readable evidence report. With -Json: one JSON object holding the same
# facts plus a ready-to-edit "draft" ServiceDef. The script never writes files and never starts anything.
#
# What it looks at (depth <= -MaxDepth, skipping node_modules/.git/target/dist/build/obj/bin/venv/
# __pycache__/out/runs/tmp/logs/.svn): source + config + docs. Port candidates are ranked by how many
# of their hits come from source files rather than documentation.
#
# ASCII-only on purpose: Windows PowerShell 5.1 decodes BOM-less files as ANSI.

param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$Port = 0,
    [string]$Name = '',
    [int]$MaxDepth = 3,
    [int]$MaxFileKb = 512,
    [switch]$AllListeners,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) { throw "path not found: $Path" }
$item = Get-Item -LiteralPath $Path
$root = $item.FullName
if ($item.LinkType -and $item.Target) {
    $target = @($item.Target)[0]
    if (Test-Path -LiteralPath $target) { $root = (Get-Item -LiteralPath $target).FullName }
}

$skipDirs = @('node_modules', '.git', '.svn', 'target', 'dist', 'build', 'obj', 'bin', 'venv', '.venv',
    '__pycache__', '.next', 'out', 'runs', 'tmp', '.idea', '.vs', 'coverage')
$textExt = @('.json', '.ts', '.js', '.mjs', '.cjs', '.py', '.cs', '.go', '.rs', '.toml', '.yaml', '.yml',
    '.ps1', '.psm1', '.psd1', '.bat', '.cmd', '.sh', '.md', '.env', '.config', '.ini', '.txt', '.xml')
$scriptExt = @('.ps1', '.cmd', '.bat', '.sh')
$textNames = @('Makefile', 'makefile', 'Dockerfile', 'Procfile', 'README', 'README.md', '.env', '.ws.env')
$sourceExt = @('.ts', '.js', '.mjs', '.cjs', '.py', '.cs', '.go', '.rs', '.ps1', '.psm1', '.psd1', '.toml', '.yaml', '.yml', '.env', '.json')

function Get-Files {
    param([string]$Base, [int]$Depth, [string[]]$Extensions, [string[]]$Names)
    $out = New-Object System.Collections.Generic.List[object]
    $stack = New-Object System.Collections.Stack
    $stack.Push(@($Base, 0))
    while ($stack.Count -gt 0) {
        $frame = $stack.Pop()
        $dir = $frame[0]
        $level = [int]$frame[1]
        try { $entries = Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop } catch { continue }
        foreach ($entry in $entries) {
            if ($entry.PSIsContainer) {
                if ($level -lt $Depth -and ($skipDirs -notcontains $entry.Name)) { $stack.Push(@($entry.FullName, $level + 1)) }
                continue
            }
            if ($entry.Length -gt ($MaxFileKb * 1024)) { continue }
            $ext = $entry.Extension.ToLowerInvariant()
            if (($Extensions -contains $ext) -or ($Names -contains $entry.Name)) { $out.Add($entry) }
        }
    }
    return $out.ToArray()
}

function Get-Lines {
    param([string]$File)
    try { return @(Get-Content -LiteralPath $File -ErrorAction Stop) } catch { return @() }
}

$rel = { param($p) $p.Substring($root.Length).TrimStart('\') }
$files = Get-Files -Base $root -Depth $MaxDepth -Extensions $textExt -Names $textNames

# ---------------------------------------------------------------- detected kinds
function Test-Rel {
    param([string]$Pattern, [int]$Depth)
    $found = Get-Files -Base $root -Depth $Depth -Extensions @('.json', '.toml', '.txt', '.csproj', '.sln', '.mod', '.ps1', '.py') -Names @('go.mod')
    return @($found | Where-Object { $_.Name -like $Pattern }).Count -gt 0
}
$kinds = @()
if (Test-Rel 'package.json' 1) { $kinds += 'node' }
if ((Test-Rel 'pyproject.toml' 1) -or (Test-Rel 'requirements*.txt' 1) -or (Test-Rel '*.py' 2)) { $kinds += 'python' }
if ((Test-Rel '*.csproj' 2) -or (Test-Rel '*.sln' 1)) { $kinds += 'dotnet' }
if (Test-Rel 'go.mod' 1) { $kinds += 'go' }
if (Test-Rel 'Cargo.toml' 1) { $kinds += 'rust' }
if (Test-Rel '*.ps1' 2) { $kinds += 'powershell' }

# ---------------------------------------------------------------- port candidates
$portHits = @()
$patterns = @(
    @{ re = 'listen\s*\(\s*(\d{2,5})'; why = 'listen()' },
    @{ re = '--port[= ]\s*(\d{2,5})'; why = '--port' },
    @{ re = 'PORT\s*[=:]\s*["'']?(\d{2,5})'; why = 'PORT env' },
    @{ re = '"port"\s*:\s*(\d{2,5})'; why = 'json port' },
    @{ re = 'port\s*[:=]\s*(\d{2,5})'; why = 'port assignment' },
    @{ re = '127\.0\.0\.1:(\d{2,5})'; why = 'loopback url' },
    @{ re = 'localhost:(\d{2,5})'; why = 'localhost url' }
)
foreach ($file in $files) {
    $lines = Get-Lines $file.FullName
    $isDoc = $file.Extension.ToLowerInvariant() -eq '.md'
    for ($i = 0; $i -lt $lines.Count; $i++) {
        foreach ($pattern in $patterns) {
            $match = [regex]::Match($lines[$i], $pattern.re)
            if (-not $match.Success) { continue }
            $value = [int]$match.Groups[1].Value
            if ($value -lt 1 -or $value -gt 65535) { continue }
            $portHits += [pscustomobject]@{
                    port = $value; why = $pattern.why; file = (& $rel $file.FullName); line = $i + 1
                    text = $lines[$i].Trim(); source = -not $isDoc
                }
        }
    }
}
$portTable = $portHits | Group-Object port | ForEach-Object {
    $group = $_.Group
    $src = @($group | Where-Object { $_.source })
    [pscustomobject]@{
        port       = [int]$_.Name
        hits       = $group.Count
        sourceHits = $src.Count
        evidence   = (($src + $group) | Select-Object -First 3 | ForEach-Object { "{0}:{1}" -f $_.file, $_.line }) -join ', '
        sample     = $group[0].text
    }
} | Sort-Object -Property @{ Expression = 'sourceHits'; Descending = $true }, @{ Expression = 'hits'; Descending = $true }

# ---------------------------------------------------------------- listening ports
$listening = @()
try {
    $listening = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
        $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
        $cmd = $null
        try { $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue).CommandLine } catch { }
        [pscustomobject]@{
            port = [int]$_.LocalPort; address = $_.LocalAddress; pid = [int]$_.OwningProcess
            name = if ($proc) { $proc.ProcessName } else { '' }
            path = if ($proc) { $proc.Path } else { '' }
            commandLine = $cmd
        }
    }
} catch { $listening = @() }
$listening = @($listening)

$rootLower = $root.ToLowerInvariant()
$related = @($listening | Where-Object {
        ($_.path -and $_.path.ToLowerInvariant().StartsWith($rootLower)) -or
        ($_.commandLine -and $_.commandLine.ToLowerInvariant().Contains($rootLower))
    })
$candidatePorts = @($portTable | Select-Object -First 8 | ForEach-Object { $_.port })
$listeningShown = if ($AllListeners) { $listening } else {
    @($listening | Where-Object { ($candidatePorts -contains $_.port) -or ($related.port -contains $_.port) })
}

# ---------------------------------------------------------------- port risk
$dynamicStart = 0; $dynamicCount = 0; $excluded = @()
try {
    foreach ($line in (netsh int ipv4 show dynamicport tcp 2>$null)) {
        if ($line -match 'Start Port\s*:\s*(\d+)') { $dynamicStart = [int]$Matches[1] }
        if ($line -match 'Number of Ports\s*:\s*(\d+)') { $dynamicCount = [int]$Matches[1] }
    }
    foreach ($line in (netsh int ipv4 show excludedportrange protocol=tcp 2>$null)) {
        if ($line -match '^\s*(\d+)\s+(\d+)\s*(\*?)\s*$') {
            $excluded += [pscustomobject]@{ start = [int]$Matches[1]; end = [int]$Matches[2]; reserved = ($Matches[3] -eq '*') }
        }
    }
} catch { }
$isRisky = {
    param([int]$p)
    if ($p -le 0) { return $false }
    if ($dynamicStart -gt 0 -and $p -ge $dynamicStart -and $p -lt ($dynamicStart + $dynamicCount)) { return $true }
    foreach ($range in $excluded) { if ($p -ge $range.start -and $p -le $range.end) { return $true } }
    return $false
}

# ---------------------------------------------------------------- start command candidates
$commands = @()
$pkgPath = Join-Path $root 'package.json'
if (Test-Path -LiteralPath $pkgPath) {
    try {
        $pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
        $runner = if (Test-Path -LiteralPath (Join-Path $root 'pnpm-lock.yaml')) { 'pnpm' } else { 'npm run' }
        foreach ($key in $pkg.scripts.PSObject.Properties.Name) {
            if ($key -in @('dev', 'start', 'serve', 'preview') -or $key -like 'dev:*' -or $key -like 'serve:*') {
                $commands += [pscustomobject]@{ command = "$runner $key".Trim(); source = 'package.json scripts'; priority = 1 }
            }
        }
    } catch { }
}
$mk = Join-Path $root 'Makefile'
if (Test-Path -LiteralPath $mk) {
    foreach ($line in Get-Lines $mk) {
        if ($line -match '^([A-Za-z0-9_][A-Za-z0-9_.-]*):') {
            $target = $Matches[1]
            if ($target -match 'serve|run|dev|start|host|up|launch|ui|web') {
                $commands += [pscustomobject]@{ command = "make $target"; source = 'Makefile target'; priority = 2 }
            }
        }
    }
}
$scripts = Get-Files -Base $root -Depth 2 -Extensions $scriptExt -Names @()
foreach ($script in $scripts) {
    if ($script.Name -match 'host|serve|server|start|run|launch|dev') {
        $verb = switch ($script.Extension.ToLowerInvariant()) {
            '.ps1' { 'powershell -NoProfile -ExecutionPolicy Bypass -File' }
            '.sh' { 'bash' }
            default { '' }
        }
        $relPath = (& $rel $script.FullName)
        $commands += [pscustomobject]@{ command = ("{0} {1}" -f $verb, $relPath).Trim(); source = "script file $relPath"; priority = 3 }
    }
}
$readmeHints = @()
foreach ($file in ($files | Where-Object { $_.Extension.ToLowerInvariant() -eq '.md' })) {
    foreach ($line in Get-Lines $file.FullName) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^(uvicorn|gunicorn|python3?\s|node\s|npm\s|pnpm\s|dotnet\s+run|go\s+run|cargo\s+run|powershell\s|\./)' -and
            $trimmed -match 'host|serve|server|start|run|--port|listen') {
            $readmeHints += [pscustomobject]@{
                    command = ($trimmed -replace '^[`\$\s>]+', ''); source = (& $rel $file.FullName); priority = 4
                }
            if ($readmeHints.Count -ge 5) { break }
        }
    }
    if ($readmeHints.Count -ge 5) { break }
}
foreach ($hint in $readmeHints) { $commands += $hint }

# ---------------------------------------------------------------- health + log candidates
$healthPaths = @()
foreach ($file in $files) {
    foreach ($line in Get-Lines $file.FullName) {
        foreach ($match in [regex]::Matches($line, '["''](/(health|healthz|status|ping|ready|live|metrics)[A-Za-z0-9_/-]*)["'']')) {
            if (-not $healthPaths.Contains($match.Groups[1].Value)) { $healthPaths += $match.Groups[1].Value }
        }
    }
}
$logFiles = @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.log' -Depth $MaxDepth -ErrorAction SilentlyContinue | Where-Object { $skipDirs -notcontains $_.Directory.Name } | Sort-Object LastWriteTime -Descending | Select-Object -First 10)
$logHints = @()
foreach ($file in $files) {
    $lines = Get-Lines $file.FullName
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match 'log[-_]?file|LOGFILE|FileHandler|--log-file') {
            $logHints += [pscustomobject]@{ file = (& $rel $file.FullName); line = $i + 1; text = $lines[$i].Trim() }
            if ($logHints.Count -ge 8) { break }
        }
    }
    if ($logHints.Count -ge 8) { break }
}

# ---------------------------------------------------------------- draft entry
$best = @($portTable | Where-Object { $_.sourceHits -gt 0 })
$chosenPort = if ($Port -gt 0) { $Port }
elseif ($best.Count -gt 0) { [int]$best[0].port }
elseif ($portTable.Count -gt 0) { [int]$portTable[0].port }
elseif ($related.Count -gt 0) { [int]$related[0].port }
else { 0 }

$chosenName = if ($Name) { $Name } else { Split-Path -Leaf $root }
$slug = ($chosenName.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
$id = if ($chosenPort -gt 0) { "$slug-$chosenPort" } else { $slug }
$ordered = @($commands | Sort-Object priority)
$chosenCommand = if ($ordered.Count -gt 0) { $ordered[0].command } else { $null }
$health = if ($healthPaths.Count -gt 0) { [pscustomobject]@{ type = 'http'; path = $healthPaths[0] } } else { [pscustomobject]@{ type = 'tcp'; path = $null } }
$logSource = if ($logFiles.Count -gt 0) {
    $newest = $logFiles[0]
    $dirPart = $newest.Directory.FullName.Substring($root.Length).TrimStart('\')
    $basePattern = ($newest.BaseName -replace '\d', '*') + $newest.Extension
    $pattern = if ($dirPart) { Join-Path $dirPart $basePattern } else { $basePattern }
    [pscustomobject]@{ type = 'file'; path = (Join-Path $root $pattern); encoding = 'utf-8' }
} else {
    [pscustomobject]@{ type = 'process'; path = $null; encoding = $null }
}

$draft = [pscustomobject]@{
    id = $id; name = $chosenName; port = $chosenPort; command = $chosenCommand; cwd = $root
    health = [pscustomobject]@{ type = $health.type; path = $health.path; intervalMs = 2000; timeoutMs = 1000; failureThreshold = 2 }
    logSource = $logSource
}

$questions = @()
if ($chosenPort -eq 0) { $questions += 'no port candidate - ask the user which port the service listens on' }
if ($portTable.Count -gt 1) { $questions += "$($portTable.Count) port candidates - confirm which one is the real listen port" }
if ($ordered.Count -eq 0) { $questions += 'no start command candidate - ask the user how the service is started' }
elseif ($ordered.Count -gt 1) { $questions += "$($ordered.Count) start command candidates - confirm the right one before filling" }
if ($logFiles.Count -eq 0) { $questions += 'no log file found - process output only works when PortLens starts the service (or add a log file to the service)' }
if ((& $isRisky $chosenPort)) { $questions += "port $chosenPort is inside the dynamic/excluded range - prefer a port >= 15001" }
if ($related.Count -eq 0) { $questions += 'service is not listening right now - start it once to confirm port and health' }

$logFileList = @()
foreach ($logFile in $logFiles) {
    $logFileList += [pscustomobject]@{
            path = [string]$logFile.FullName
            size = [long]$logFile.Length
            modified = [string]$logFile.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
        }
}

$listeningSorted = @()
if ($listeningShown) { $listeningSorted = @($listeningShown | Sort-Object port) }

$result = [pscustomobject]@{}
# 注意：数组值先落到变量再传，直接写 @(...) 在为空时会让 Add-Member 的绑定失败（Argument types do not match）。
$detected = [pscustomobject]@{ textFiles = $files.Count; kinds = @($kinds) }
$portCandidates = @($portTable)
$relatedList = @($related)
$portRisk = [pscustomobject]@{
    dynamicStart = $dynamicStart; dynamicCount = $dynamicCount
    excludedRanges = @($excluded); chosenIsRisky = [bool](& $isRisky $chosenPort)
}
$commandList = @($ordered)
$healthList = @($healthPaths)
$logFileArray = @($logFileList)
$logHintArray = @($logHints)
$questionArray = @($questions)

$result | Add-Member -NotePropertyName basePath -NotePropertyValue $root
$result | Add-Member -NotePropertyName detected -NotePropertyValue $detected
$result | Add-Member -NotePropertyName portCandidates -NotePropertyValue $portCandidates
$result | Add-Member -NotePropertyName listeningShown -NotePropertyValue $listeningSorted
$result | Add-Member -NotePropertyName listeningRelatedToPath -NotePropertyValue $relatedList
$result | Add-Member -NotePropertyName portRisk -NotePropertyValue $portRisk
$result | Add-Member -NotePropertyName commandCandidates -NotePropertyValue $commandList
$result | Add-Member -NotePropertyName healthCandidates -NotePropertyValue $healthList
$result | Add-Member -NotePropertyName logFileCandidates -NotePropertyValue $logFileArray
$result | Add-Member -NotePropertyName logHints -NotePropertyValue $logHintArray
$result | Add-Member -NotePropertyName draft -NotePropertyValue $draft
$result | Add-Member -NotePropertyName openQuestions -NotePropertyValue $questionArray

if ($Json) { $result | ConvertTo-Json -Depth 8; exit 0 }

Write-Host "== scan: $root"
Write-Host "   files scanned: $($files.Count)   kinds: $(@($kinds) -join ', ')"
Write-Host ""
Write-Host "-- port candidates (source hits first) --"
if ($portTable.Count -eq 0) { Write-Host "   (none)" } else {
    $portTable | Select-Object -First 10 | ForEach-Object { Write-Host ("   {0,-6} src={1,-3} hits={2,-3} {3}" -f $_.port, $_.sourceHits, $_.hits, $_.evidence) }
}
Write-Host ""
Write-Host "-- listening now (candidate/related ports only) --"
if ($listeningShown.Count -eq 0) { Write-Host "   (none of the candidate ports is listening)" } else {
    $listeningShown | Sort-Object port -Unique | ForEach-Object { Write-Host ("   {0,-6} pid={1,-7} {2}" -f $_.port, $_.pid, $_.name) }
}
if ($related.Count -gt 0) { Write-Host ("   related to this path: {0}" -f (($related.port | Sort-Object -Unique) -join ', ')) }
Write-Host ""
Write-Host "-- start command candidates --"
if ($ordered.Count -eq 0) { Write-Host "   (none)" } else {
    $ordered | Select-Object -First 10 | ForEach-Object { Write-Host ("   [p{0}] {1}   <- {2}" -f $_.priority, $_.command, $_.source) }
}
Write-Host ""
Write-Host "-- health path candidates --"
if ($healthPaths.Count -eq 0) { Write-Host "   (none -> use tcp)" } else { $healthPaths | Select-Object -First 8 | ForEach-Object { Write-Host "   $_" } }
Write-Host ""
Write-Host "-- log candidates --"
if ($logFiles.Count -eq 0) { Write-Host "   (no *.log file)" } else { $logFiles | Select-Object -First 6 | ForEach-Object { Write-Host ("   {0}  ({1} bytes)" -f $_.FullName, $_.Length) } }
Write-Host ""
Write-Host ("-- port risk: dynamic range starts at {0} ({1} ports); chosen port risky: {2}" -f $dynamicStart, $dynamicCount, (& $isRisky $chosenPort))
Write-Host ""
Write-Host "-- draft ServiceDef --"
Write-Host ($draft | ConvertTo-Json -Depth 5)
Write-Host ""
Write-Host "-- open questions --"
if ($questions.Count -eq 0) { Write-Host "   (none - verify by loading it into PortLens and watching the state)" } else { $questions | ForEach-Object { Write-Host "   - $_" } }
