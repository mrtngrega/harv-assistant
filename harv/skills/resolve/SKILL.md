---
name: resolve
description: Work inside DaVinci Resolve (free or Studio) through its scripting API: projects, timelines, cuts, color and LUTs, Fusion titles and effects, subtitles, markers, sound effects (sfx-kit), hearing sound (earshot: judge, compare or measure audio you cannot hear), colour correction LUTs (color-grade-ai), cutting talk by word times, renders. Use when the user wants anything done in DaVinci Resolve or one of their Resolve projects.
---

# Resolve

Harv works in DaVinci Resolve through a small **bridge**: a Lua script running inside Resolve's Console that runs the Lua Harv sends and returns the result. It works in the free version, where Resolve 21.1 allows no outside scripts and no Scripts-menu scripts, but its Console still runs Lua with the whole scripting API. Harv sees what the user sees in Resolve: the same open project, live.

`<this skill>` is the folder this file is in (`~/.claude/skills/resolve`).

**Only free Resolve 21.1 (21.1.0) works, and Studio.** From 21.1.1 on, the free version's Console Lua lost `dofile`, `io` and `ffi`: the bridge can neither load nor answer (checked on 21.1.2 and 21.2, 2026-11-05). So never install or accept a Resolve update for the user (the update check is off on the user's computers: `Update.AutoCheck.Enabled = 0` in Resolve's `config.dat`; if the offer shows up again, write that line back while Resolve is closed), and when `start` fails on a newer version, say this plainly: going back to 21.1 (Blackmagic's support page lists it) or Studio are the ways back.

## 1. Connect

`node <this skill>/scripts/resolve.mjs start`

- It starts Resolve if it's closed, opens the Console (F6) and types the bridge's start line there (one keystroke burst in Resolve's window; tell the user it's you). **Done when** it prints `bridge: running`.
- `Resolve shows its Project Manager`: no project is open and the Console exists only inside one. Ask the user which project (or let them open it), then `start` again.
- On Linux (Fedora KDE, Resolve in the `davincibox` container) it does the same through KWin and a virtual keyboard. There Resolve can't read phone video or write MP4 itself: convert with ffmpeg on the way in and out (the reference's Linux section).
- `status` says whether the bridge runs; `stop` ends it. It also ends by itself after 2 hours without requests, and keeps running when a project is switched (`pm:LoadProject(name)`).

## 2. Look before you change

Read the state first: `node <this skill>/scripts/resolve.mjs run <file.lua>` (or `run -e "<lua>"` for one line). Write request files in `~/.harv/workspace/resolve/`. Inside a request these names are ready: `resolve`, `pm` (project manager), `project`, `timeline` (the current one), `mediaPool`; `return` a value (tables come back as JSON, Resolve objects as `"<…>"` strings) and `print` goes to `output`. Lua 5.1 syntax: methods with `:`, lists 1-based, settings as `{ Key = value }`. Harv's safety gate reads every request before it runs: login secrets and wiping are refused, and deleting or moving files from inside a request (no backup there) or code built at runtime (`loadstring`, `dofile`) waits for the user's yes. Do file work with your own tools instead; everything else in a request just runs.

Get the project, the timeline, its tracks and clips (names, start frames, durations), the frame rate and resolution: whatever the task touches. Times on the API are **frames** counted from the timeline's start (`timeline:GetStartFrame()`, usually 01:00:00:00).

## 3. Do the work

The API, with what's tested on free 21.1 and the traps: [references/api.md](references/api.md). Read it before your first change in a chat; it also says where Resolve's own full reference lies (grep that for a call's exact name instead of guessing). Check visual work by eye: export the frame as a still and read it.

The user's projects are their work, so:

- Before changing a timeline, duplicate it (`timeline:DuplicateTimeline(name .. " (before Harv)")`) and work on the original; the copy is the undo. Tell the user it's there.
- Delete projects, timelines, clips or files only when the user asked for that exact deletion.
- Render to a new file name; a render never overwrites an existing file.
- One small request at a time, each checked, beats one long script: a failure then says which step failed.

### Colour correction (LUTs)

The API sets no colour wheels or curves, so corrections go in as a `.cube` LUT made by **color-grade-ai** (MIT, measures and fits, no model): `python <this skill>/scripts/grade.py …` (`install` once if missing; on Linux `python3`).

1. A still of the shot (`ffmpeg -ss <t> -i <clip> -frames:v 1 frame.png`, or Resolve's still export). `grade.py type frame.png` first: log footage needs its camera's conversion LUT before any correction; when it can't tell (a misty or flat scene), ask the user or pass `--log`.
2. The fix: `grade.py match <reference.png> <shot.png> -o <out.cube>` to make shots look alike (the dependable one: tested 2026-11-16, a 4200 K shot back to the reference's look), or `grade.py fix <frame.png|clip> -o <out.cube>` for a plain correction (`report` shows what it measured). Automatic white balance assumes a scene averages to grey: on a scene that's meant to be blue, golden or misty it pushes the wrong way, so use `match` against a shot the user likes, or tell the user what it found and let them choose.
3. Look before applying: `ffmpeg -i frame.png -vf lut3d=<out.cube> after.png`, view both. Then in Resolve the LUT on the clip (the reference has the tested LUT route), on the timeline copy as always.

### Cutting talk (filler, retakes, dead air)

The method from video-use (browser-use, MIT), with Harv's own Whisper instead of its paid transcription:

1. Words first: your `transcribe` tool with `format: words` on each clip. Its lines are phrases with `[start-end]` seconds (broken on pauses); `<clip>.words.json` has every word's start and end. Read the lines; the picture only at decision points (a frame with ffmpeg, or watch.py's sheet).
2. Plan in plain words (what goes, what stays, the target length, which take of a repeated line) and get the user's yes before touching the timeline.
3. Cut only at a word's edge, never inside a word, with 30 to 200 ms of padding (Whisper's times drift a little): about 50 ms before the first kept word and 80 ms after the last. Silences of 400 ms or more are the clean cuts; under 150 ms is mid-phrase. Keep laughs and reactions after a punchline. Every cut works for picture and sound together.
4. In Resolve: one `AppendToTimeline` clip-info per kept piece (`startFrame`/`endFrame` from the times × the clip's frame rate, `recordFrame` back to back), on a new timeline next to the user's. Without Resolve (a quick MP4): ffmpeg extracts each piece with a 30 ms audio fade in and out (`afade`), joins them with the concat demuxer, and burns subtitles last, after any overlay.
5. Check your own cuts before showing them: a still a moment before and after every cut (a jump, a flash, a cut-off word) and the loudness (`ebur128`). Fix and check again, at most three rounds; then say what's left.
6. Subtitles for the cut: an `.srt` from the words, times shifted to the new timeline (`new = word start - piece start + piece's place`).

### Sound effects

For whooshes, pops, impacts, clicks, risers and the like, use **sfx-kit** (CC0, free for any use, no credit needed): 320 sounds with timing data, in `~/.harv/tools/sfx-kit` (`python <this skill>/scripts/sfx.py install` once if missing; on Linux `python3`).

1. Pick: read the kit's `GUIDE.md` table "On screen → Sounds" for the moment (it's short), then `sfx.py find <words> [--fits <move seconds>] [--voice]` for its siblings. `--voice` when speech plays at that moment (soft sounds, the kit's quieter level).
2. Place: `sfx.py place <id> --at <moment seconds> --fps <timeline rate> --start-frame <timeline:GetStartFrame()> [--voice]` gives `recordFrame` (the sound's sync point, e.g. a whoosh's peak or a riser's arrival, lands on the moment), the file and `AudioVolume`.
3. Put it in: `ImportMedia({ file })`, then `AppendToTimeline({ { mediaPoolItem = item, mediaType = 2, trackIndex = n, recordFrame = f } })` on an audio track of its own (`timeline:AddTrack("audio")`; keep the user's dialogue and music tracks untouched), then `SetProperty("AudioVolume", dB)` on the new item. Read the track back to check.

**Real recordings** (rain, traffic, a crowd, a particular car door: what a synthesised kit doesn't have): `sfx.py real <words> [--cc0] [--max-seconds 10]` searches Openverse (Freesound and others; CC0 and CC BY only, no key, ~200 searches a day), `sfx.py get <id>` downloads one into `~/.harv/workspace/sounds/` and adds its credit to `credits.txt` there. A CC BY sound needs that credit in the video's description: tell the user. They have no sync point: line up their loudest moment by ear or a waveform still. Prefer the kit for UI-style effects and `--cc0` when the user doesn't want credits.

Fewer sounds land better than many: one per real moment, none on top of every cut. A newer kit than the pinned one gets reviewed before use (`sfx.py install` refuses it).

**Hearing a sound (earshot)**: you can't hear, so never say a sound or a mix "fits" or "sounds good" from its name alone. When it matters (choosing between real recordings or music, finding the clean moment in a take, checking a finished video's sound, sync to the picture, loudness), listen with earshot (MIT, on the CPU, nothing leaves the computer): `python <this skill>/scripts/ears.py <command>` (`install` once if missing, ~2.5 GB; on Linux `python3`). The ones you need: `rank "<what you want>" <folder> --top 5`, `find <file> "<moment>" --top 3` (clean trims in seconds), `describe <file> [--start s --end s]`, `ab <a> <b> --query "<what you want>"`, `measure <file>` (LUFS, true peak), `timeline <video> [--cues cues.json]` and `sheet <video> -o sheet.png` (open the PNG) for a finished edit. Each call loads its models first (~40 s), so batch questions into few calls. Quote its numbers when you report ("snare-like hit, z +3.7; -29 LUFS"). `ears.py` refuses `llm` (uploads to Google with a key) and `mcp`. Its full guide: `~/.harv/tools/earshot/src/skills/earshot/SKILL.md`.

**Done when** a read-back request shows the change in Resolve (the clip's grade, the subtitle items, the render job `Complete` and its file on disk), not when a call returned `true`.

## 4. When Resolve stops answering

- Calls suddenly return nothing (`nil`, missing keys) while the bridge runs: a dialog in Resolve is blocking, most often **"You have reached a limitation"** (a Studio-only feature was asked for in the free version). Take a screenshot of the screen; with desktop control on, click **Not Yet** yourself, otherwise ask the user to. Then use a free route (see the Studio list in the reference).
- `DaVinci Resolve closed or crashed`: say so, check the last request for a known crash pattern (reference), and restart with `start` once the user agrees; Resolve's own crash recovery may ask about the project.
- No answer within the timeout while Resolve runs: the request is still going (a long import or render). `status` shows `busy`; wait, then ask again.
- Resolve hung and has to go: find it by process name (`ps -eo pid,comm | awk '$2=="resolve"'`, or `pgrep -x resolve`); `pkill -f` with its path matches your own shell's command line too and ends your command. The bridge doesn't survive a night: after sleep, `status` then `start` again.

Report in plain words what changed in which project and timeline, where the "(before Harv)" copy and any render are, and anything that needs Studio.
