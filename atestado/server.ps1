$root = "C:\Users\vv\Desktop\atestado"
$port = if ($env:PORT) { [int]$env:PORT } else { 3030 }
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Servidor rodando em http://localhost:$port/"

$mimes = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css'
  '.js'   = 'application/javascript'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.json' = 'application/json'
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response

  $urlPath = $req.Url.LocalPath
  if ($urlPath -eq '/') { $urlPath = '/index.html' }

  $filePath = Join-Path $root ($urlPath.TrimStart('/').Replace('/', '\'))

  if (Test-Path $filePath -PathType Leaf) {
    $ext  = [System.IO.Path]::GetExtension($filePath).ToLower()
    $mime = if ($mimes.ContainsKey($ext)) { $mimes[$ext] } else { 'application/octet-stream' }
    $bytes = [System.IO.File]::ReadAllBytes($filePath)
    $res.ContentType   = $mime
    $res.ContentLength64 = $bytes.Length
    $res.StatusCode    = 200
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $msg   = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $urlPath")
    $res.StatusCode = 404
    $res.ContentType = 'text/plain'
    $res.ContentLength64 = $msg.Length
    $res.OutputStream.Write($msg, 0, $msg.Length)
  }

  $res.OutputStream.Close()
}
