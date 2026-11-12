Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('D:\Users\sms\Desktop\Repos\translator\vibe_images\inline-translator-icon.png')
$out = 'D:\Users\sms\Desktop\Repos\translator\public\icon'
foreach ($s in 16, 32, 48, 128) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.SmoothingMode = 'HighQuality'
    $g.DrawImage($src, 0, 0, $s, $s)
    $bmp.Save((Join-Path $out "$s.png"))
    $g.Dispose()
    $bmp.Dispose()
}
$src.Dispose()
Remove-Item (Join-Path $out '.png') -ErrorAction SilentlyContinue
Write-Output 'icons done'