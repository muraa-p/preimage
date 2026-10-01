# VHS tape for the README's opening demo: a small service, an agent that changes
# what it shouldn't, and the project's own tests going from failing to passing.
#
#   vhs tape/files.tape
#
# Records `node scripts/demo.mjs --story=1 --paced`, the same script the README
# quotes. Under vhs the output is a real terminal, so the diff is coloured exactly
# as a user sees it; when piped for the README transcript the same script forces
# NO_COLOR and prints plain text, so the two cannot drift apart.
#
# Re-record and update the README transcript together. test/readme.test.js checks
# that every line the README claims is a line the tool actually prints.

Output docs/demo-files.gif

Set Shell "powershell"
Set FontFamily "Cascadia Mono"
Set FontSize 13
Set LetterSpacing 0
# GitHub renders README images in a column around 800px wide, so recording
# wider than that only costs bytes.
Set Width 1000
Set Height 660
Set Padding 16
Set BorderRadius 12
Set TypingSpeed 40ms


Set Theme {"name":"One Dark","background":"#282c34","foreground":"#abb2bf","black":"#282c34","red":"#e06c75","green":"#98c379","yellow":"#e5c07b","blue":"#61afef","magenta":"#c678dd","cyan":"#56b6c2","white":"#dcdfe4","brightBlack":"#5c6370","brightRed":"#ef7178","brightGreen":"#a5d6a7","brightYellow":"#f0d399","brightBlue":"#7cc4f5","brightMagenta":"#d19ae6","brightCyan":"#71cdd8","brightWhite":"#ffffff"}

Type "node scripts/demo.mjs --story=1 --paced"
Sleep 500ms
Enter
Sleep 23s
