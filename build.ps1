$ErrorActionPreference = 'Stop'

Remove-Item -r out -EA continue
& "$PSScriptRoot/tsc" -p .
