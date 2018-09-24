param(
    <# Compile typescript #>
    [switch]$build,
    <# run npm version #>
    [string]$npmVersion,
    <# publish to npm registry #>
    [switch]$publish
)

$ErrorActionPreference = 'Stop'

function main() {
    if($clean) {
        Remove-Item -r out -EA continue
    }

    if($build) {
        tsc -p .
    }

    if($npmVersion) {
        npm version $npmVersion
    }

    if($publish) {
        npm publish
    }
}

try {
    $oldPath = $env:PATH
    $env:PATH = "$PSScriptRoot/node_modules/.bin;" + $env:PATH
    $oldPwd = $PWD
    Set-Location $PSScriptRoot
    main
} finally {
    $env:PATH = $oldPath
    Set-Location $oldPwd
}
