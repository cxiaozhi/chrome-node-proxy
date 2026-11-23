param([string] $ExtensionId, [switch] $LocalUpdate)
$ErrorActionPreference = 'Stop'
$hostName = 'com.directproxy.bridge'
$registry = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
if ($ExtensionId -and $ExtensionId -cnotmatch '^[a-p]{32}$') { throw 'Invalid Chrome extension ID.' }
$chromeData = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
$ids = [System.Collections.Generic.HashSet[string]]::new()
[void]$ids.Add('jjgbdejncfnmacfjobfnhklifcmcedgb')
if ($ExtensionId) { [void]$ids.Add($ExtensionId) }
if (Test-Path -LiteralPath $chromeData) {
    foreach ($profile in Get-ChildItem -LiteralPath $chromeData -Directory) {
        foreach ($fileName in @('Secure Preferences','Preferences')) {
            $path = Join-Path $profile.FullName $fileName
            if (!(Test-Path -LiteralPath $path -PathType Leaf)) { continue }
            try { $options = Get-Content -Raw -Encoding UTF8 -LiteralPath $path | ConvertFrom-Json }
            catch { continue }
            $records = $options.extensions.settings
            if (!$records) { continue }
            foreach ($property in $records.PSObject.Properties) {
                $id = $property.Name
                $folder = $property.Value.path
                if ($id -cnotmatch '^[a-p]{32}$' -or !$folder -or ![IO.Path]::IsPathRooted($folder)) { continue }
                $manifest = Join-Path $folder 'manifest.json'
                if (!(Test-Path -LiteralPath $manifest -PathType Leaf)) { continue }
                try { $definition = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifest | ConvertFrom-Json }
                catch { continue }
                if ($definition.name -eq '直连代理' -and $definition.background.service_worker -eq 'background.mjs') { [void]$ids.Add($id) }
            }
        }
    }
}
if (!$ids.Count) { throw '先在 Chrome 加载「直连代理」，再运行安装程序。' }
$build = Join-Path $env:LOCALAPPDATA 'DirectProxyBridge\1.3.0'
New-Item -ItemType Directory -Path $build -Force | Out-Null
$expectedCore = '5A0231811A80B27477EBDEE15684B41946D01AFBD2114534E9A4B256125CA147'
$archiveHash = 'CD6738D4648CC1A5F48049A1343B697AB510889D648F045C5C780FC1AB443A79'
$core = Join-Path $build 'mihomo.exe'
$localCore = Join-Path $PSScriptRoot 'mihomo.exe'
if ($LocalUpdate -and (Test-Path -LiteralPath $registry)) {
    $registeredManifest = (Get-Item -LiteralPath $registry).GetValue('')
    if ($registeredManifest -and (Test-Path -LiteralPath $registeredManifest -PathType Leaf)) {
        $previousCore = Join-Path (Split-Path -Parent $registeredManifest) 'mihomo.exe'
        if (Test-Path -LiteralPath $previousCore -PathType Leaf) { $localCore = $previousCore }
    }
}
if (!(Test-Path -LiteralPath $core) -or (Get-FileHash -LiteralPath $core).Hash -ne $expectedCore) {
    if ((Test-Path -LiteralPath $localCore) -and (Get-FileHash -LiteralPath $localCore).Hash -eq $expectedCore) {
        Copy-Item -LiteralPath $localCore -Destination $core -Force
    } else {
        Write-Output '正在下载并校验 Mihomo…'
        $staging = Join-Path $build "mihomo-$([Guid]::NewGuid().ToString('N')).zip"
        $binary = "$staging.exe"
        try {
            $asset = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/assets/734504968?download=1'
            $headers = @{ Accept = 'application/octet-stream'; 'User-Agent' = 'DirectProxy-Setup' }
            Invoke-WebRequest -Uri $asset -UseBasicParsing -Headers $headers -OutFile $staging -TimeoutSec 180
            if ((Get-FileHash -LiteralPath $staging).Hash -ne $archiveHash) { throw 'Mihomo ZIP SHA-256 mismatch.' }
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $zip = [IO.Compression.ZipFile]::OpenRead($staging)
            try {
                $entry = $zip.GetEntry('mihomo-windows-amd64-compatible.exe')
                if (!$entry) { throw 'Mihomo executable is missing.' }
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $binary)
            } finally { $zip.Dispose() }
            if ((Get-FileHash -LiteralPath $binary).Hash -ne $expectedCore) { throw 'Mihomo executable SHA-256 mismatch.' }
            [IO.File]::Copy($binary, $core, $true)
        } finally {
            [IO.File]::Delete($staging)
            [IO.File]::Delete($binary)
        }
    }
}
foreach ($name in @('DirectProxyHost.exe','MIHOMO-LICENSE')) {
    $source = Join-Path $PSScriptRoot $name
    $target = Join-Path $build $name
    if (!(Test-Path -LiteralPath $target) -or (Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $target).Hash) {
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
}
$manifestPath = Join-Path $build 'native-host.json'
$manifest = [ordered]@{
    name = $hostName
    description = 'Direct Proxy Windows helper'
    path = (Join-Path $build 'DirectProxyHost.exe')
    type = 'stdio'
    allowed_origins = @($ids | Sort-Object | ForEach-Object { "chrome-extension://$_/" })
}
$manifest | ConvertTo-Json -Depth 3 | Out-String | ForEach-Object { [IO.File]::WriteAllText($manifestPath, $_, [Text.UTF8Encoding]::new($false)) }
New-Item -Path $registry -Force | Out-Null
Set-Item -LiteralPath $registry -Value $manifestPath
Write-Output "本机组件安装完成。匹配 $($ids.Count) 个 Chrome 扩展。"
