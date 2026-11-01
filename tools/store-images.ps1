# Gera as imagens da Chrome Web Store em store/:
# - prints/*.png|jpg -> store/print-N.png (1280x800, fundo preto, sem alfa)
# - blocos promocionais 440x280 e 1400x560 a partir do logo
# Uso: powershell -ExecutionPolicy Bypass -File tools\store-images.ps1

Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'store'
New-Item -ItemType Directory -Force $out | Out-Null

$black = [System.Drawing.Color]::Black
$white = [System.Drawing.Color]::FromArgb(245, 245, 245)
$muted = [System.Drawing.Color]::FromArgb(160, 160, 160)
$accent = [System.Drawing.Color]::FromArgb(79, 179, 255)

# Canvas RGB de 24 bits (a loja recusa PNG com alfa).
function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear($black)
  return @($bmp, $g)
}

# ---- Prints: encaixa a imagem inteira em 1280x800, centralizada ----
$i = 1
Get-ChildItem (Join-Path $root 'prints') -File |
  Where-Object { $_.Extension -match '^\.(png|jpe?g)$' } |
  Sort-Object Name |
  ForEach-Object {
    $src = [System.Drawing.Image]::FromFile($_.FullName)
    $bmp, $g = New-Canvas 1280 800
    $scale = [Math]::Min(1280 / $src.Width, 800 / $src.Height)
    $w = [int]($src.Width * $scale); $h = [int]($src.Height * $scale)
    $g.DrawImage($src, [int]((1280 - $w) / 2), [int]((800 - $h) / 2), $w, $h)
    $file = Join-Path $out "print-$i.png"
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose(); $src.Dispose()
    "{0} -> {1}" -f $_.Name, (Split-Path $file -Leaf)
    $i++
  }

# ---- Blocos promocionais: logo + nome + slogan ----
$logo = [System.Drawing.Image]::FromFile((Join-Path $root 'icons\logo512.png'))

# $stacked: logo acima do texto (bloco pequeno); senão, logo à esquerda (letreiro).
function New-Promo([int]$w, [int]$h, [string]$name, [bool]$stacked) {
  $bmp, $g = New-Canvas $w $h
  if ($stacked) {
    $logoSize = [int]($h * 0.42); $titleSize = [single]($h * 0.13); $subSize = [single]($h * 0.058)
  } else {
    $logoSize = [int]($h * 0.5); $titleSize = [single]($h * 0.15); $subSize = [single]($h * 0.065)
  }
  $titleFont = New-Object System.Drawing.Font 'Segoe UI Semibold', $titleSize, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $subFont = New-Object System.Drawing.Font 'Segoe UI', $subSize, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $titleBrush = New-Object System.Drawing.SolidBrush $white
  $subBrush = New-Object System.Drawing.SolidBrush $muted

  $title = 'ShadowFocus'
  # Acento via código: o PowerShell 5.1 lê o script como ANSI.
  $sub = "Aprenda ingl$([char]0x00EA)s ouvindo, com foco total"
  $titleW = $g.MeasureString($title, $titleFont).Width
  $subW = $g.MeasureString($sub, $subFont).Width

  if ($stacked) {
    $top = [int](($h - ($logoSize + $titleSize * 1.4 + $subSize * 1.4)) / 2)
    $g.DrawImage($logo, [int](($w - $logoSize) / 2), $top, $logoSize, $logoSize)
    $ty = $top + $logoSize + $h * 0.02
    $g.DrawString($title, $titleFont, $titleBrush, (($w - $titleW) / 2), $ty)
    $g.DrawString($sub, $subFont, $subBrush, (($w - $subW) / 2), ($ty + $titleSize * 1.3))
  } else {
    $gap = [int]($h * 0.08)
    $textW = [Math]::Max($titleW, $subW)
    $x = [int](($w - ($logoSize + $gap + $textW)) / 2)
    $g.DrawImage($logo, $x, [int](($h - $logoSize) / 2), $logoSize, $logoSize)
    $tx = $x + $logoSize + $gap
    $g.DrawString($title, $titleFont, $titleBrush, $tx, ($h / 2 - $titleSize * 1.05))
    $g.DrawString($sub, $subFont, $subBrush, ($tx + $titleSize * 0.06), ($h / 2 + $subSize * 0.3))
  }

  # Linha de destaque na cor da marca.
  $g.FillRectangle((New-Object System.Drawing.SolidBrush $accent), 0, ($h - [int]($h * 0.02)), $w, [int]($h * 0.02))

  $file = Join-Path $out $name
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  "promo -> $name"
}

New-Promo 440 280 'promo-440x280.png' $true
New-Promo 1400 560 'promo-1400x560.png' $false
$logo.Dispose()
