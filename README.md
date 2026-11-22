# RC-Rehab

A Duolingo-style daily practice of head and face exercises, built for people with cerebral palsy and fun for anyone. It's a demo, so there are no accounts. The first screen (`/`) asks which of the three modes you want:

- **Arcade** (`/arcade`): type a name, do the quick face setup and race the **Grand Prix** (head steers, a face move drives). Everyone races with **no driving help**, so times compare. The real RC car drives along through an ESP32 when it's connected. Times go on one **shared, saved leaderboard** (fastest and most improved) that anyone with the link sees, live. "Next player" clears everything for the next person, so it works on the event laptop and on anyone's own phone.
- **Practice path** (`/path`, on anyone's own phone or computer): a **roadmap** of 24 stops: four units (head steady, left and right, jaw, lips) of five lessons and a boss race each, plus the Grand Prix. Every lesson is its own little **course**: the car drives itself to a gate, you do the exercise to open it, and the lesson ends when the car crosses the finish line. Progress is saved **in that browser only**, so coming back on the same phone picks up where you left off. Everything is open from day one; the path only suggests an order.
- **Arm path** (`/arms`): the same kind of roadmap for the **biceps**, from two EMG muscle sensors on an ESP32 that only report whether each arm is flexing. Four units (wake up, hold strong, curls, left and right) of five lessons and a boss race on the real car. No camera. See [Arm path](#arm-path) below.

```
Online:  Laptop / phones / big screen --HTTPS--> Vercel (static pages + WebSocket functions) <--wss:// from any WiFi-- ESP32 --> controller buttons
                                                    |  Redis: leaderboard, practice log, and the live link between instances
Laptop:  Phones --HTTPS--> Cloudflare quick tunnel --> Laptop (node server.js, JSON files) <--ws:// on WiFi-- ESP32
```

The game logic (queue, races, leaderboards, practice log) lives in `server/arena.js` and is the same in both setups. Only the hosting and storage differ.

## Run it online (Vercel)

The app is a Vercel project: static pages from `public/`, plus functions in `api/`. On Vercel the phones, the laptop and the car can each land on a different server instance, so they talk through **Redis** pub/sub (`server/relay.js`). Exactly one instance at a time runs the game; it holds a lock in Redis. If that instance goes away, another one takes over at once and carries on from a saved snapshot: the waiting line, someone's turn, and a race in progress all survive, and messages sent during the switch are held and delivered afterwards. Race results and the practice log are saved in the same Redis.

Set up once (needs a Vercel account; the free Hobby plan works):

```bash
npm install
npx vercel link                                # create/link the project
npx vercel integration add upstash/upstash-kv  # free Redis, connected to the project (adds REDIS_URL / KV_URL)
npx vercel env add ADMIN_KEY production        # a long random string: host controls + practice CSV
npx vercel env add CAR_TOKEN production        # another one: the ESP32 must send it to drive
npx vercel deploy --prod                       # prints the app's link
```

After a code change, run `npx vercel deploy --prod` again. The saved data stays. Connections that were already open stay on the old version until they reconnect (at most 5 minutes), so for a minute or two the old version may still be running the game.

Live: **https://rc-rehab.vercel.app** (the old https://head-racer.vercel.app link still works). The first screen offers every mode.

- **Arcade:** `<link>/arcade` skips the choice (handy on the event laptop). Anyone you share the link with can race; there is one line for the one real car, so racers take turns.
- **Practice path:** `<link>/path` skips the choice.
- **Arm path:** `<link>/arms` skips the choice.
- **Arm sensors ESP32:** `firmware/emg_arms/emg_arms.ino`, block A, with `EMG_PATH "/api/emg?token=<CAR_TOKEN>"` (the same token as the car).
- **Big screen:** `<link>/screen?admin=<ADMIN_KEY>`. Without the key it is view-only.
- **ESP32:** in the firmware use block A: `SERVER_HOST` = the link's host name without `https://`, port 443, and `CAR_PATH "/api/car?token=<CAR_TOKEN>"`. It connects from any WiFi with internet.
- **Practice CSV:** the link on the big screen when it has the admin key.
- **Fresh start for a demo:** the big screen's host panel has **Clear leaderboard and practice log** (asks to confirm).
- **Connection time limit:** Vercel's Hobby plan closes each WebSocket after 5 minutes. Pages and the car reconnect by themselves within a second. When a turn starts, a phone or big screen whose connection is too old to last the turn opens a new one and switches over without a gap, and the car is asked to reconnect, so a race is never cut off.
- **Connection drops mid-race:** the real car stops at once, and the driver has 6 seconds to come back (the phone reconnects by itself). If it does, the race carries on; if not, the run ends. A finish that doesn't get through is sent again.
- **Test the cloud build locally:** start Redis (`docker run -d --name hr-redis -p 6390:6379 redis:7-alpine`), then run two "instances" sharing it: `REDIS_URL=redis://localhost:6390 CAR_TOKEN=letsgo ADMIN_KEY=testkey PORT=4001 node test/cloud-dev.js` (and again with `PORT=4002`). `SIM_URL=http://localhost:4001 SIM_URL2=http://localhost:4002 npm test` then runs every server check with the phones on one instance and the car and big screen on the other. Flush Redis first.
- "Today's practice" on the big screen resets at midnight in `TIME_ZONE` (env var, default `America/Toronto`).
- Free-plan limits: the Upstash free tier covers a good few demo days of racing. Each race streams about 40 Redis messages a second while it runs.

## Run it on a laptop (offline / no account)

```bash
brew install cloudflared   # once: gives phones an HTTPS link (needed for the camera)
npm install                # once
npm start
```

`npm start` prints:
- **Big screen URL** (`http://localhost:3000/screen?admin=…`): open it on the laptop or projector. The `admin` key shows the STOP button. Without the key the page is view-only.
- **Laptop IP**: put it in the firmware (block B) as `SERVER_HOST`.
- **Public HTTPS link**: the big screen turns it into a QR code automatically.

The quick-tunnel link changes every time you restart, but the QR code updates by itself. Laptop data is saved in `data/`.

Test without hardware: `npm test` (74 checks: physics, jumps, head calibration, steering feel, every practice lesson, difficulty changes, gold, streaks, achievements, every race course and all 20 lesson courses driven to the finish, full races through the server with a fake phone and a fake car, and races carrying on when the connection blips or the game moves to another server).
Test without a camera: on the phone, tap "Use touch controls instead". In lessons, slide sideways for left/right and drag up for face moves. On a laptop, the arrow keys / WASD also work.
Demo without a face: open `<link>/?autopilot` (or `<link>/arcade?autopilot`) and pick touch controls. A stand-in player does every lesson rep and drives every race, and the real car mirrors the races. It only drives while nobody else is: as soon as it sees a calibrated face, or a finger or key is down, you are driving. The HUD says "autopilot" while the link has it.
No real car? In the practice path, boss races and the Grand Prix have **Play on this phone**: the same race without the line or the car. It counts for practice and XP and is marked "(phone)" in the CSV, but stays off the leaderboard. Arcade races always go through the line, so they always count, with or without the car.

## ESP32 setup

1. Arduino IDE → Library Manager → install **"WebSockets" by Markus Sattler**.
2. Open `firmware/rc_car/rc_car.ino` and set `WIFI_SSID`, `WIFI_PASS`, the server block (A = online app, B = laptop), and the four `PIN_*` GPIOs.
3. `DIRECT_WIRING = true` if GPIOs go straight to the active-low button lines. Released = high-impedance, so the controller's own pull-up holds 3.2 V. Use `false` if you drive transistors or optocouplers.
4. Flash it and open the Serial Monitor at 115200:
   - `f`, `b`, `l`, `r`: press one button for 1 s (check your wiring)
   - `d 0 500`: half throttle straight for 3 s
   - `x`: release everything
5. The big screen should say **Car connected** (the Serial Monitor prints the address it is trying).

**How speed is mirrored with on/off buttons:** the forward button is pulsed (every 120 ms). 50% speed on screen means pressed 50% of the time. Tune `SPEED_SCALE` (start around 0.5 indoors), `PULSE_PERIOD_MS` and `MIN_DUTY`. Steering is on/off past `STEER_THRESHOLD` (0.35). Head steering on screen is deliberately gentle, so the phone sends any clear turn (0.15 or more, about 40% of your calibrated head movement) as at least a 0.53 press, and tiny wobbles as 0. Set `STEER_PULSE = true` to try partial turns.

**Safety:** all buttons are released if no command arrives for 300 ms, if the driver's phone disconnects, if the driver hits STOP, or if the host hits STOP on the big screen.

**Power:** keep the controller on its own 2×AA batteries and just share ground with the ESP32. That's the safest option. Only run it from the ESP32's 3.3 V pin after checking the controller's chip is rated for 3.3 V.

## Practice path

The home screen has an **Up next** card (the suggested stop, today's minutes and the week's goal days) and the **roadmap**: every unit as a trail of six stops, with each stop's course name, level and last score, and tabs that jump to a unit. Tap any stop to see its course map, level, last score and gold progress, then start it. Nothing is locked.

| Unit | Exercise | Boss race (real car) |
|---|---|---|
| 1 Hold steady | Head centred and still (head turn/tilt plus a rough nod estimate) | **Steady Run**: drives while your head stays in the middle; steers itself |
| 2 Left and right | Turn or tilt to each side (whichever head setup picked) | **Curvy Road**: you steer; it drives itself |
| 3 Open and close | Jaw | **Mouth Pedal**: wider mouth = faster; steers itself |
| 4 Lips | Pucker and smile | **Kiss Boost**: pucker to boost; steers itself |
| Together | Head + GO move | **Grand Prix**: your head steers and your GO move (mouth, eyebrows, smile, pucker or cheeks, picked in head setup) drives. The original race and leaderboard, open any time from the home screen |

Only the Grand Prix and Curvy Road are steered by your head. The other boss races and all lessons practise one move, so the car steers itself; each race's card lists its steering and GO controls.

**Lessons are courses.** Each of the 20 lessons has its own course (Calm Bay, Long Pier, Lily Pads… Pine Avenue, Red Rock Rise, Shell Shore, Wave Hop and so on), shaped for its exercise: Hold courses have long straights, Aim courses are S-bends, Quick courses are tight turns, and Mix courses are the longest. The car drives itself and stops at each of the 10 gates. The rep you do there opens the gate: a good rep lifts the arm with a green light and a burst of speed, and a miss lifts it too, so you always reach the finish. The drive between gates is the rest between reps. If the camera loses your face, the car waits. The bar at the top shows the course, each gate's result and where the car is.

**The lesson ladder** (10 reps, about two minutes each):
1. **Find it**: reach the edge of your range and hold for a moment. Four good reps in a row push that side's target out 5%.
2. **Hold it**: keep the dot in the green. Holds grow from 2 s to 10 s. Leaving the zone pauses the clock; it doesn't reset it.
3. **Aim it**: stop in a small zone at 30%, 60% or 90% of your range (the skill head arrays and proportional controls need).
4. **Quick**: move when the cue appears, then relax. Moving early just restarts the wait.
5. **Mix**: random reps from the unit, plus two review reps from the unit before.

**How it adapts.** Everything is a share of the player's own range: head left/right from head setup, and face moves from a 2-second "show us" the first time a face lesson starts. Face ranges grow slowly toward what the player actually shows. After each lesson: 90%+ makes it one step harder next time, under 60% one step easier, anything else stays the same. Only one knob moves at a time. The first rep of every lesson is an easier warm-up. A lesson turns **gold** after 80%+ on two different days.

**Feedback.** The live meter shows on every rep at first. Once a lesson is going well, every third rep hides the meter ("feel it") and shows the result afterwards. Players can hide the meter themselves at any time. Good reps make the car burst forward. A miss just says "Keep going".

**Fatigue and rest.** "I'm tired" is always on screen. It ends the lesson with credit and never raises difficulty. The lesson flags likely fatigue when two signs show up at once: slower reactions, smaller moves, more wobble, good reps turning into misses, or the face keeps leaving the camera. Losing the face pauses the clock. A 30-second breathing rest follows every lesson.

**Motivation.** XP comes from good reps. There's a daily goal in minutes (5, 10, 15 or 20). The **weekly** streak counts goal days per week (3, 4 or 5) with rest days built in, and one missed week a month is frozen automatically. There are no lives to lose, and nothing is locked: the roadmap suggests an order ("start here", "next!") but every stop can be played. XP also gives a player level. 13 **achievements** (first gate, perfect ten, "good call" for stopping when tired, 100 gates, 2-week streak, all bosses, whole map…) each have a progress bar and pop up as a toast when earned. The progress line compares the player only with their own day 1 (for example "Your left tilt reached 21°, up from 15° on day 1").

**Menu** (top-right button or tap your name): **Progress** has tiles for level, minutes, gates opened, stops done, streak and bosses, a 14-day minutes chart against the goal, each measured range against day 1, and every lesson's level. **Awards** lists the achievements. **Settings** has the daily goal, goal days per week, **Bigger targets** (wider zones and longer dwell, for people with extra involuntary movement), driving help for races, redo head setup, switch between camera and touch, and change name.

**Saved data.** Roadmap progress is saved only in the browser it was made in. There are no accounts and nothing personal on the server. Every lesson and race is logged to the practice log. The big screen shows "Today's practice" (good reps, minutes, top XP, recent activity). The host (with `?admin=`) can download **practice.csv** for a therapist. It has date, name, unit, activity, good reps, XP, minutes, average reaction time, fatigue signs, and whether they stopped tired.

**Safety and honesty.** This is a practice tool to use alongside therapy, not a medical device. Practise seated with good support, and stop for pain or dizziness. A therapist should pick which units fit the person. Targets never go past the player's own measured range, and there are no strobe effects. The mouth units are presented as control practice, not as a treatment for speech, drooling or eating, because the evidence for oral-motor exercises is weak. The nod estimate and face scores are approximate. Evidence for head-control games in CP comes from small studies; see the sources below.

**Sources behind the design:** head-mouse games for CP ([Velasco 2017](https://pmc.ncbi.nlm.nih.gov/articles/PMC5568605)), biofeedback dose and faded, self-chosen feedback ([MacIntosh 2019 review](https://www.em-consulte.com/article/1227431/article/biofeedback-intervention-effects-for-people-with-c)), goal-directed training ([Novak 2020](https://pmc.ncbi.nlm.nih.gov/articles/PMC7035308/)), feedback in motor learning ([JSLHR 2023](https://pubs.asha.org/doi/10.1044/2022_JSLHR-22-00375)), oral-motor evidence ([Arvedson 2010](https://onlinelibrary.wiley.com/doi/10.1111/j.1469-8749.2010.03707.x)), gamification and autonomy ([JMIR Serious Games 2024](https://games.jmir.org/2024/1/e49029)), fatigue and rest ([PMC4942358](https://pmc.ncbi.nlm.nih.gov/articles/PMC4942358)), head arrays and switches ([Sunrise Medical](https://SunriseMedical.com/education-in-motion/blog/january-2024/prescribing-wireless-power-wheelchair-head-control)).

## Arm path

Biceps exercises for when the only input is two yes/no signals: **is the left biceps flexing?** and **is the right?** The full design, the research behind it and what a yes/no signal can and can't measure are in [docs/arm-path.md](docs/arm-path.md).

| Unit | Lessons (10 reps each, the drive between gates is the rest) | Boss race (real car) |
|---|---|---|
| 1 Wake up | Squeeze · Let go · Hold · Quick · Mix | **Flex Sprint**: squeeze either arm to drive |
| 2 Hold strong | Long hold · Hold, then let go · Both arms hold · Stay loose · Mix | **Long Haul**: moves while you hold; a boost every 3 s held |
| 3 Curls | Up and down · Pause at the top · Both arms · Fast up · Mix | **Pump Track**: rolls by itself; every new squeeze boosts |
| 4 Left and right | Just one · Switch · Together · Which arm? · Mix | **Arm Grand Prix**: left arm turns right, right arm turns left (each arm drives its own side's wheels), both = full speed |

- Relaxing on cue counts as much as squeezing (in CP the biceps are often over-active), and nothing ever asks you to squeeze harder: the sensors can't tell.
- Difficulty adapts per lesson like the head path (longer holds, shorter reaction windows, less help from the other arm).
- **Sensor check** after your name: both arms light up live; squeeze left, squeeze right, relax. "Swap left and right" fixes crossed wires. The menu has it too.
- **Real car over Bluetooth (MuscleCar):** on **Sensors and car**, press **Connect MuscleCar** (Chrome or Edge, on the Vercel link or `localhost`), then calibrate: relax both arms, squeeze left, squeeze right (2 s each). The real car then follows the game car in lessons and races. It copies what the game car *actually* does, so a game car pushing into a wall stops the real car too. **Speed** sets the real car's power at the game's top speed. **Turning** (100% = the car's measured geometry: 1 m/s at full power, 12.5 cm track, 9 cm wheelbase) and the **Quarter turn** tests make it turn as much as the game. A one-arm turn is a gentle arc (about 70% / 40% power), not a spin. While the game car is moving, no wheel gets less than 40% power (below about 20% the wheels don't turn), so slow moves still move the real car; both wheels are lifted together, so turns keep their turn rate. **Both-arms window** (250 ms): one arm starting or letting go up to this long before the other still counts as straight on.
- **Lessons with the real car:** between gates the car only moves while your arms give the direction the road needs (both = straight, left arm = right, right arm = left). The wrong arm or none, and both cars wait.
- **No sensor?** Hold **A** / **D** (or ← / →), or press and hold the on-screen Left / Right lights. `/arms?autopilot` plays lessons and races by itself while the sensor is offline.
- **Hardware:** two EMG sensors (e.g. MyoWare 2.0, ENV output) on GPIO 34 and 35 of an ESP32 running `firmware/emg_arms/emg_arms.ino`. At power-up keep both arms relaxed for 3 s while it calibrates; type `l` or `r` in the Serial Monitor to set a gentler threshold from a comfortable squeeze. It sends `f <left> <right>` on every change and every 0.5 s; 2 s of silence = offline, so lessons pause and the car waits. The car's own ESP32 may send the same lines instead.
- One sensor rig per game: everyone in the Arm path sees the same arms, which is fine for a demo.

## Head control

Calibration takes about 10 seconds: relax → steer left → steer right → GO movement. It automatically picks:
- **Steering:** head *tilt* or head *turn*, whichever the player actually did more clearly.
- **GO:** open mouth, raise eyebrows, smile, pucker or puff cheeks, whichever moved most.

Movements are scaled to each player's own range: 70% of their calibrated movement counts as full input. If the camera loses the face, GO drops to zero and the car stops. Video never leaves the phone.

## Steering feel

Small head movements give small turns: the first 20% of a movement is ignored, and a curve keeps the middle range gentle. Players choose **Gentle / Normal / Sharp** on the waiting screen (Normal is the default; Sharp is close to the original, twitchier feel). The car also turns a little less at top speed.

## Look

A light, soft-lit toy world in Three.js, laid out like bruno-simon.com but in its own colours: each course is a bevelled island with a glowing rim floating over a pale grid, with rounded trees, paved road, red-and-white curbs, chevron boost pads, gates with lifting arms, 3D course lettering and a rounded coral car. Each unit has a theme (lake, forest, canyon, beach, park). Menus show the next course from above, a stop shows its island, lessons and races use a chase camera, and the big screen shows the course being raced. The interface is framed paper panels and square icon buttons with toasts for achievements. Titles are Amatic SC and everything you read is Nunito. Unit colours are sky, mint, coral and sun, with violet for the Grand Prix. Three.js and the fonts load from CDNs, so phones need internet.

## Race rules

- One driver at a time, for boss races and the Grand Prix alike. Everyone else waits in the queue and can practise with live meters. Lessons run on each phone at the same time and don't need the car.
- Each race has its own course: the Grand Prix park, Mirror Lake (Steady Run), Curvy Road, Red Canyon (Mouth Pedal) and Kiss Beach (Kiss Boost).
- Each star collected takes 2 s off your time. Some stars float above the jumps. Wall hits slow you down.
- **Jumps and boosts:** chevron pads give a speed burst, and ramps launch the car, with a boost pad before them for a big jump. Jumps never punish: a slow car just rolls off the lip. While the virtual car is in the air it can't steer, so the real car's steering is released too.
- Wooden crates by the road can be knocked flying. They're just for fun and cost nothing.
- Driving help (practice path only, in Settings): *No help* / *Some help* (slower, steering assist) / *Lots of help* (drives forward by itself). The arcade is always *No help*.
- Leaderboards: **Fastest Grand Prix** (best time per name) and **Most improved** (first run vs best run), counting only Grand Prix runs with no help. Races with help still count for your own bests and practice; boss races use different controls, so their times stay off too.
- The results screen shows exercise stats: head moves, GO reps, GO hold time, jumps, wall bumps.
- Online, race results and the practice log are saved in Redis. On a laptop they're in `data/results.json` and `data/practice.json`; delete the `data` folder to reset.

## Troubleshooting

| Problem | Fix |
|---|---|
| ESP32 can't connect to WiFi | The ESP32 can't get through a WiFi login page or enterprise WiFi. Put the laptop and ESP32 on a phone hotspot. |
| "Car offline" but ESP32 is on WiFi | Online: check `SERVER_HOST` has no `https://`, port is 443, `USE_TLS = true`, and the token matches the `CAR_TOKEN` secret. Laptop: check `SERVER_HOST`. Some guest WiFi blocks device-to-device traffic, so use a hotspot. Check the macOS firewall allows node. |
| Camera doesn't start on the phone | The page must be opened from an `https://` link (the app's link, or the `…trycloudflare.com` one on a laptop). On iPhone: Settings → Safari → Camera → Allow. |
| Face tracking slow on an old phone | Use touch controls, or lend a newer phone. |
| Real car too fast or drifts too much | Lower `SPEED_SCALE` in the firmware. |

## Two-bicep car demo and game replay

Flash the ESP32-S3 with [MuscleCar](firmware/MuscleCar/MuscleCar.ino). The same board drives the
real car from the game's Arm path over Bluetooth (see [Arm path](#arm-path)): the game writes power
for each side (characteristic `…0c54`, two bytes) and the board pulses the buttons to run slower than
full speed. Free Flex's one-byte on/off command still works.
Left and right MyoWare ENV use GPIO2 and GPIO8 respectively. Run
`python3 arm-lab/serve.py` and open [Free Flex](http://127.0.0.1:8741/blind.html)
in a Web Bluetooth capable browser. Connect both biceps, capture rest and flex
for each side, then enable the wheels while relaxed.

Use **Start game recording**, **Finish recording**, and **Download game JSON**
to capture timestamped sensor readings and wheel commands for playback.
See the [game replay format](docs/game-replay-guide.txt) for the movement mapping.
