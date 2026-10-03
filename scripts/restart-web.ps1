# 重启 dsh web：停掉占用端口的旧实例，以「脱离当前 shell」的方式重新拉起。
#
# 为什么要这个脚本：升级全局 @deepseek-ai/dsh 之后，**已经在跑的进程仍然执行旧代码**，
# 必须重启才生效；而在 Harness 自己的会话里直接重启会把当前对话打断，所以这里用
# Start-Process（不带 -Wait）把新进程变成独立进程，输出重定向到日志文件便于排查。
#
# 用法：
#   pwsh -NoProfile -File scripts/restart-web.ps1                 # 默认 3080
#   pwsh -NoProfile -File scripts/restart-web.ps1 -Port 8080
#   pwsh -NoProfile -File scripts/restart-web.ps1 -Profile web -WhatIfOnly
param(
  [int]$Port = 3080,
  [string]$Profile = 'web',
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Continue'

# 1) 解析 node 与全局安装的 dsh 入口（不硬编码盘符/用户名）
#    只用 Windows PowerShell 5.1 也支持的语法：不要用 `?.`（5.1 会报 Unexpected token）
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw '找不到 node（请确认它在 PATH 里）' }
$node = $nodeCmd.Source

$npmRoot = (npm root -g 2>$null | Select-Object -First 1)
if (-not $npmRoot) { $npmRoot = Join-Path $env:APPDATA 'npm\node_modules' }
$bin = Join-Path $npmRoot '@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path $bin)) {
  throw "找不到 dsh 入口：$bin（请先 npm i -g @deepseek-ai/dsh）"
}
$installed = (Get-Content (Join-Path $npmRoot '@deepseek-ai\dsh\package.json') -Raw | ConvertFrom-Json).version

$logDir = Join-Path $DshHome 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir "web-$Port.out.log"
$errLog = Join-Path $logDir "web-$Port.err.log"

Write-Output "node        : $node"
Write-Output "dsh 入口    : $bin"
Write-Output "已装版本    : $installed"
Write-Output "端口 / 日志 : $Port / $outLog"

if ($WhatIfOnly) { Write-Output '（-WhatIfOnly：只检查环境，不重启）'; return }

# 2) 停掉当前占用端口的实例
$old = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty OwningProcess
if ($old) {
  Write-Output "停止旧进程 PID $old"
  Stop-Process -Id $old -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
  }
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "端口 $Port 仍被占用，未启动新实例"
  }
  Write-Output "端口 $Port 已释放"
} else {
  Write-Output "端口 $Port 上没有监听进程"
}

# 3) 新起一份（脱离父进程：Start-Process 不带 -Wait）
$proc = Start-Process -FilePath $node `
  -ArgumentList @($bin, $Profile, '--port', "$Port", '--no-open') `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden
Write-Output "已启动新进程 PID $($proc.Id)（dsh $installed）"
Write-Output "stdout: $outLog"
Write-Output "stderr: $errLog"
