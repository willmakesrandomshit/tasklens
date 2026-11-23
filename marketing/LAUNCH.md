# Launch video — TaskLens

**Not published anywhere.** Do not post until the owners have reviewed it (see "Review before posting").

## Files
| | |
|---|---|
| Video | `marketing/video/output/tasklens-launch-tiktok.mp4` — 1080×1920, 60 fps, H.264 (High, yuv420p, BT.709) + AAC 192 kbps/48 kHz, 37.1 s, ≈ 6.5 MB |
| Thumbnail | `marketing/video/output/thumbnail.jpg` |
| Editable "project" | The scripts: `marketing/video/capture.mjs` (records real footage), `marketing/video/render.mjs` (ffmpeg filter graph, scenes, captions, original soundtrack). Edit the `scenes` array / text and re-run. The generated `filtergraph.txt` is the full edit decision list. There is no GUI project file (Premiere/DaVinci). |
| Rebuild | `node marketing/video/capture.mjs src-tauri/target/release/tasklens.exe` then `node marketing/video/render.mjs` (needs ffmpeg) |

Large generated files (`frames/`, `output/`) are git-ignored; attach the MP4 to a release or share it directly.

## How it was made (honest notes)
- **Footage is real**: screenshots of the running release build taken over the WebView2 debugging protocol at ≈ 25 fps
  (1920×1200), driven by a script. A small cursor and click ripple are drawn into the page so scripted clicks are
  visible; the app UI itself is unmodified.
- **60 fps** is the output frame rate. App motion is ≈ 25 fps real capture (the app updates once per second), duplicated
  to 60; captions, zooms and transitions are rendered at true 60 fps.
- **Performance claims** on the "Dark. Light. Fast." card are from `docs/PERFORMANCE_BENCHMARKS.md` (0.72 s warm start,
  7.4 ms median search, 0 of 119 scroll frames over 33 ms) on one AMD Ryzen 5 9600X machine, and say so on screen.
  No comparison with Windows Task Manager is claimed.

## Storyboard (as rendered)
| Time | Scene | On-screen text |
|---|---|---|
| 0:00–0:03 | Hook — live process list, slow push-in | "Windows Task Manager / deserves competition." |
| 0:03–0:09 | Search "edge", sort by memory then CPU | "Live processes. Instant search. Real sorting. 25 columns." |
| 0:09–0:16 | Performance: CPU → Memory → Disk → GPU | "Every resource. CPU, memory, disk and GPU from real Windows counters." |
| 0:16–0:25 | Inspector (live graphs), Resource Monitor, Services, Startup | "Inspect. Manage. Investigate." |
| 0:25–0:31 | Dark → light theme, measured stats | "Dark. Light. Fast." + measured numbers |
| 0:31–0:37 | End card | "TASKLENS · Open Source. Built with Rust. Made by Wil & Elq. Available on GitHub. · github.com/willmakesrandomshit/tasklens" |

## Voiceover script (optional — the video has music only)
> Windows Task Manager deserves competition. This is TaskLens: live processes with instant search and real sorting.
> CPU, memory, disk and GPU straight from Windows' own counters. Inspect any process, see its services and startup
> apps, and find out what is really slowing your PC. Dark or light, and fast. TaskLens — open source, built with Rust,
> made by Wil and Elq. Find it on GitHub.

## Caption (draft)
Windows Task Manager deserves competition 👀 TaskLens is an open-source Windows task manager written in Rust: live
processes, per-process graphs, GPU/disk/memory counters, services, startup apps and more. Free on GitHub — link in bio.
Early pre-release (unsigned), feedback welcome!

## Hashtags
#TaskLens #Windows11 #Windows #TaskManager #Rust #RustLang #OpenSource #Tauri #DevTools #SysAdmin #PCTips #Programming

## Shot list / assets
Footage scenes: `s1-hook`, `s2-processes`, `s3-performance`, `s4-advanced`, `s5-design` (folders of JPEG frames +
`frames.txt` with true per-frame durations). End card: `src-tauri/icons/icon.png` + generated text.

## Attribution
- **Music / sound effects:** original, synthesised in `render.mjs` with ffmpeg's `aevalsrc` and `anoisesrc` generators
  (sine pad, kick, hats, whooshes, impact). No third-party audio.
- **Logo/icon:** original TaskLens artwork (`docs/assets/logo.svg`, generated `icon.png`).
- **Typeface in the video:** Segoe UI (Windows system font) rendered into the video with ffmpeg `drawtext`. Segoe UI is
  Microsoft's; replace with an open font (e.g. Inter, SIL OFL) in `render.mjs` if you want a fully open asset chain.
- **Software shown:** TaskLens (MIT).

## Review before posting
The footage shows the maker's **real running processes** (for example Discord, ChatGPT, Claude, iCloud, Steam helpers),
the CPU model and live resource numbers. The Windows account column and file paths were hidden, and the Network and
System pages (which show IP addresses and the device name) were left out. Re-record on a clean machine or crop further
if you want zero personal context. It also happens to show a genuinely runaway `find.exe` (7.5 million handles) that was
running on the capture machine.
