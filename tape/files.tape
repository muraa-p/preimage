# VHS tape for README demo 1: the agent rewrote your config and deleted a file.
#
#   vhs tape/files.tape
#
# Records `node scripts/demo.mjs --story=1 --paced`, which is the same script the
# README quotes. The 31-line transcript fits an 1120x620 terminal, so nothing
# scrolls off. Re-record and update the README transcript together.

Output docs/demo-files.gif

Set Shell "powershell"
Set FontFamily "Cascadia Mono"
Set FontSize 15
Set LetterSpacing 0
Set Width 1120
Set Height 620
Set Padding 20
Set BorderRadius 12
Set TypingSpeed 40ms

Set Theme {"name":"One Dark","background":"#282c34","foreground":"#abb2bf","black":"#282c34","red":"#e06c75","green":"#98c379","yellow":"#e5c07b","blue":"#61afef","magenta":"#c678dd","cyan":"#56b6c2","white":"#dcdfe4","brightBlack":"#5c6370","brightRed":"#ef7178","brightGreen":"#a5d6a7","brightYellow":"#f0d399","brightBlue":"#7cc4f5","brightMagenta":"#d19ae6","brightCyan":"#71cdd8","brightWhite":"#ffffff"}

Type "node scripts/demo.mjs --story=1 --paced"
Sleep 500ms
Enter
Sleep 26s