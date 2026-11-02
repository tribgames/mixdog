# Video prompting

## Before prompt construction

Name these, in this order, each as one focused labeled sentence or two:

1. *Shot design*: the opening frame, one motivated reveal or change, and a settling final frame.
2. *Camera intent*: the move that serves the scene — macro push-in for a product, orbit for space, handheld for documentary, crane for scale, static when nothing needs to move. Never a default "slow dolly in".
3. *Production*: concrete material and texture, a motivated light source, depth layers (foreground / mid / background), lens framing.
4. *Sound*: music style, no music, room tone, or effects only.
5. *Dialogue*: the exact line in its original language, or "no dialogue".
6. *Ending frame*: final pose, camera state, last sound cue — clear enough to be the first frame of a next clip.

Pacing follows duration:

| Duration | Beats |
|---|---|
| 1-4 s | one action |
| 5-7 s | setup, turn, hold |
| 8-10 s | two connected beats |
| 11-15 s | a three-beat arc |

Pick the duration from the model's list to fit the beats.

Rejected slop words: "cinematic", "volumetric lighting", "neon glow", "AAA trailer", "shot on RED", and unmotivated dark or moody defaults. Write what the camera actually sees.

Normalize a detailed user prompt into these items without adding to it. Reference images are named in the prompt by index and role, e.g. `Image 1: the scene to animate. Image 2: subject identity.`, followed by the relationship.

## When extending a clip

Start a new job; do not stretch the old one. Use the previous clip's last frame as the reference (index and role in the prompt, e.g. `Image 1: the opening frame, continuing the previous clip`). Only the pose carries over: motion, trajectory, and camera do not, so restate the camera intent and the motion from that pose. The previous clip's ending frame item is the opening frame of this one; write the new ending frame so it can seed a further clip.
