---
about: what Harv's Google connectors (claude.ai: Gmail, Calendar, Drive, Docs, Sheets) can and can't reach
keys: gmail, google doc, google docs, google drive, google sheet, google calendar, connector
updated: <setup date>
---
The Google connectors are the user's own Google account, turned on at claude.ai › Settings › Connectors; Harv reaches them through the same login. A doc shared with another address isn't visible there: ask for "anyone with the link: viewer" or a downloaded file (look in Downloads first). Mail attachments through the Gmail connector need the whole file as base64 inside the call: don't; open the draft in Harv's browser and attach the file with browser_upload instead. The `google` skill has the rest.
