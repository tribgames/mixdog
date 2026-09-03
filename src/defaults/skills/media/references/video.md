# Video (media tool · kind:'video')

Read only for a video request. Everything in `SKILL.md` still applies — call order, reference roles, saving, provenance; this file adds what a moving picture needs. Controls (`durations` / `durationRange`, `resolution`, `aspectRatio`, `maxReferences`) come from `list kind:'video' model:<id>`.

## 1. Which route
| Situation | Route |
|---|---|
| a still is enough to carry the meaning | no video; the user did not ask for motion |
| a scene with one or more subjects and an environment | **image first**: generate a still with `kind:'image'` at the video's aspect, with every subject and the environment composed in that one image; inspect it; then `kind:'video'` with that file as the single reference. The video model animates a concrete anchor far better than it invents one |
| several separately supplied subjects that must stay recognizable | references-to-video with each identity as its own reference (index + role, identity first), duration at the short end of the range |
| continuing an earlier clip | a new job with the previous clip's last frame as the reference; only the pose carries over — motion, trajectory, and camera do not |

## 2. Prompt — an active shot, not a list of elements
**Hard rule — the prompt names, in this order**: → manual
1. *Shot design*: the opening frame, one motivated reveal or change, and a settling final frame.
2. *Camera intent*: the move that serves the scene — macro push-in for a product, orbit for space, handheld for documentary, crane for scale, static when nothing needs to move. Never a default "slow dolly in".
3. *Production*: concrete material and texture, a motivated light source, depth layers (foreground / mid / background), lens framing.
4. *Sound*: music style, no music, room tone, or effects only.
5. *Dialogue*: the exact line in its original language, or "no dialogue".
6. *Ending frame*: final pose, camera state, last sound cue — clear enough to be the first frame of a next clip.
**Hard rule — pacing follows duration**: 1-4 s one action; 5-7 s setup, turn, hold; 8-10 s two connected beats; 11-15 s a three-beat arc. Pick the duration from the model's list to fit the beats, not the other way round. → manual
**Hard rule — no slop words**: "cinematic", "volumetric lighting", "neon glow", "AAA trailer", "shot on RED", and unmotivated dark or moody defaults are rejected; write what the camera actually sees. → manual
The labeled-line form and the specificity policy of `SKILL.md` §3 apply; a video prompt is one focused paragraph per numbered item, not keywords.

## 3. Controls
- `aspect` from the destination (`SKILL.md` §6): a feed clip `9:16`, an embed `16:9`, a tile `1:1`.
- `resolution`: the highest the model lists for delivery, the lowest for a draft to check motion and pacing before spending on the final.
- `duration`: from the pacing rule; when a model lists a range, stay inside it.
- References beyond one cut the allowed duration on most models — check the model's controls before promising a length.

## 4. Running and checking
- Always `wait:false`; poll `status` with `path:` when the file is needed; `cancel` when the user moves on. Minutes are normal.
- Inspect before use: play or frame-sample the file; check the opening frame, that the one change happens, the ending frame, and that no text, logo, or extra subject appeared. One corrected retry with a single changed variable, as in `SKILL.md` §2.
- Report path, lane/model, options, and the prompt; when the runtime reports a different model than requested, name the one that ran.
