$procs = Get-Process -Name chrome -ErrorAction SilentlyContinue
foreach ($p in $procs) {
    try {
        if ($p.Path -like "*puppeteer*") {
            Write-Host "Killing puppeteer Chrome PID $($p.Id)"
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}
Write-Host "Done killing puppeteer chrome."
