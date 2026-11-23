param([string] $OutputPath = (Join-Path $PSScriptRoot 'DirectProxyHost.exe'))

$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw 'The Windows x64 .NET Framework C# compiler is required.'
}

$source = Join-Path $PSScriptRoot 'ProxyHost.cs'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 /reference:System.Web.Extensions.dll "/out:$OutputPath" $source
if ($LASTEXITCODE -ne 0) { throw "Native host build failed (exit $LASTEXITCODE)." }
