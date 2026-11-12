# Only kills browsers/scripts started by this extension's tests/debug runs; never the user's own browser
$procs = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'msedge.exe' -and $_.CommandLine -match 'ilt-(test|dbg)-') -or
  ($_.Name -match '^python' -and $_.CommandLine -match '(debug_run|test_extension)\.py')
}
foreach ($p in $procs) {
  Write-Output ("kill {0} {1}" -f $p.ProcessId, $p.Name)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Output ("cleaned {0}" -f @($procs).Count)