-- LedgerPDF launcher. A SHORTCUT, not a packaged app: it starts the dev
-- build out of the repo, so the repo, node_modules and the engine venv must all
-- be present. Real packaging is handled by the repository release pipeline.
--
-- Every `do shell script` sits inside a `try`. Without that an applet launched
-- by LaunchServices dies silently mid-script -- no window, no error, no clue --
-- which is exactly how this was built wrong the first three times.

set repo to "__LEDGERPDF_REPO__"
set q to quoted form of ((POSIX path of (path to library folder from user domain)) & "Logs/WorkpaperBinder.log")

try
	do shell script "echo \"=== $(date) launcher ===\" >> " & q
end try

-- Match the process NAME. `pgrep -f` can match the very shell running it.
set isRunning to false
try
	set n to do shell script "pgrep -x Electron | wc -l | tr -d ' '"
	try
		do shell script "echo 'electron count: " & n & "' >> " & q
	end try
	if n is not "0" then set isRunning to true
end try

if isRunning then
	try
		do shell script "echo 'already running - activating' >> " & q
	end try
	try
		tell application "System Events" to set frontmost of (first process whose name is "Electron") to true
	end try
	return
end if

set hasModules to "no"
try
	set hasModules to do shell script "test -d " & quoted form of (repo & "/app/node_modules") & " && echo yes || echo no"
end try
if hasModules is "no" then
	display alert "LedgerPDF can't start" message "node_modules is missing." & return & return & "Run:  cd " & repo & "/app && npm install" as critical
	return
end if

try
	do shell script "echo 'starting dev server' >> " & q
end try
-- `< /dev/null` matters: without it `do shell script` keeps waiting on the
-- background job's stdin and this applet never exits, leaving a stray process
-- (and, without LSUIElement, a second Dock tile).
try
	do shell script "export PATH=/opt/homebrew/bin:/usr/bin:/bin; cd " & quoted form of (repo & "/app") & " && nohup npm run dev >> " & q & " 2>&1 < /dev/null &"
on error errMsg
	display alert "LedgerPDF can't start" message errMsg as critical
end try
