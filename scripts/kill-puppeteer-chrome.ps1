$procs = Get-Process -Name chrome -ErrorAction SilentlyContinue
foreach ($p in $procs) {
    try {
        if ($p.Path -like "*puppeteer*") {
            Write-Host "Killing puppeteer Chrome PID $($p.Id)"
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}
try {
    $cimProcs = Get-CimInstance Win32_Process -Filter "name='chrome.exe'" -ErrorAction SilentlyContinue
    foreach ($cp in $cimProcs) {
        if ($cp.CommandLine -like "*wwebjs_auth*" -or $cp.CommandLine -like "*puppeteer*") {
            Write-Host "Killing orphan wwebjs Chrome PID $($cp.ProcessId)"
            Stop-Process -Id $cp.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
} catch {}
Write-Host "Done killing puppeteer chrome."
