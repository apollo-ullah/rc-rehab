# Head Racer

A Duolingo-style daily practice of head and face exercises, built for people with cerebral palsy and fun for anyone. Players scan a QR code, type their name and pick from a **roadmap** of 24 stops: four units (head steady, left and right, jaw, lips) of five lessons and a boss race each, plus the Grand Prix. Every lesson is its own little **course**: the car drives itself to a gate, you do the exercise to open it, and the lesson ends when the car crosses the finish line. Each **boss race** drives the real RC car through an ESP32 using only that unit's exercise, and the **Grand Prix** (head steers, face move drives) keeps its leaderboard. Everything is open from day one; the path only suggests an order.

```
Phones --HTTPS--> Cloudflare tunnel --> Laptop (node server.js) --ws:// on WiFi--> ESP32 --> controller buttons
Big screen (laptop browser): live course, QR code, queue, leaderboards, STOP button
```

## Run it

```bash
brew install cloudflared   # once: gives phones an HTTPS link (needed for the camera)
npm install                # once
npm start
```

`npm start` prints:
- **Big screen URL** (`http://localhost:3000/screen?admin=…`): open it on the laptop or projector. The `admin` key shows the STOP button. Without the key the page is view-only.
- **Laptop IP**: put it in the firmware as `SERVER_HOST`.
- **Public HTTPS link**: the big screen turns it into a QR code automatically.

The quick-tunnel link changes every time you restart, but the QR code updates by itself.

Test without hardware: `npm test` (68 checks: physics, jumps, head calibration, steering feel, every practice lesson, difficulty changes, gold, streaks, achievements, every race course and all 20 lesson courses driven to the finish, and full races through the server with a fake phone and a fake car).
Test without a camera: on the phone, tap "Use touch controls instead". In lessons, slide sideways for left/right and drag up for face moves. On a laptop, the arrow keys / WASD also work.
Demo without a face: open `<link>/?autopilot` and pick touch controls. A stand-in player does every lesson rep and drives every race, and the real car mirrors the races.
No real car? Boss races and the Grand Prix have **Play on this phone**: the same race without the line or the car. It counts for practice and XP and is marked "(phone)" in the CSV, but stays off the leaderboard.

## ESP32 setup

1. Arduino IDE → Library Manager → install **"WebSockets" by Markus Sattler**.
2. Open `firmware/rc_car/rc_car.ino` and set `WIFI_SSID`, `WIFI_PASS`, `SERVER_HOST` (laptop IP), and the four `PIN_*` GPIOs.
3. `DIRECT_WIRING = true` if GPIOs go straight to the active-low button lines. Released = high-impedance, so the controller's own pull-up holds 3.2 V. Use `false` if you drive transistors or optocouplers.
4. Flash it and open the Serial Monitor at 115200:
   - `f`, `b`, `l`, `r`: press one button for 1 s (check your wiring)
   - `d 0 500`: half throttle straight for 3 s
   - `x`: release everything
5. With `npm start` running, the big screen should say **Car connected**.

**How speed is mirrored with on/off buttons:** the forward button is pulsed (every 120 ms). 50% speed on screen means pressed 50% of the time. Tune `SPEED_SCALE` (start around 0.5 indoors), `PULSE_PERIOD_MS` and `MIN_DUTY`. Steering is on/off past `STEER_THRESHOLD`. Set `STEER_PULSE = true` to try partial turns.

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
| Together | Head + GO move | **Grand Prix**: the original race and leaderboard, open any time |

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

**Saved data.** Progress is saved on the phone and on the laptop by name in `data/profiles.json`, so a player can continue on another phone. Names are not accounts: two people typing the same name share progress. Every lesson and race is logged to `data/practice.json`. The big screen shows "Today's practice" (good reps, minutes, top XP, recent activity). The host (with `?admin=`) can download **practice.csv** for a therapist. It has date, name, unit, activity, good reps, XP, minutes, average reaction time, fatigue signs, and whether they stopped tired.

**Safety and honesty.** This is a practice tool to use alongside therapy, not a medical device. Practise seated with good support, and stop for pain or dizziness. A therapist should pick which units fit the person. Targets never go past the player's own measured range, and there are no strobe effects. The mouth units are presented as control practice, not as a treatment for speech, drooling or eating, because the evidence for oral-motor exercises is weak. The nod estimate and face scores are approximate. Evidence for head-control games in CP comes from small studies; see the sources below.

**Sources behind the design:** head-mouse games for CP ([Velasco 2017](https://pmc.ncbi.nlm.nih.gov/articles/PMC5568605)), biofeedback dose and faded, self-chosen feedback ([MacIntosh 2019 review](https://www.em-consulte.com/article/1227431/article/biofeedback-intervention-effects-for-people-with-c)), goal-directed training ([Novak 2020](https://pmc.ncbi.nlm.nih.gov/articles/PMC7035308/)), feedback in motor learning ([JSLHR 2023](https://pubs.asha.org/doi/10.1044/2022_JSLHR-22-00375)), oral-motor evidence ([Arvedson 2010](https://onlinelibrary.wiley.com/doi/10.1111/j.1469-8749.2010.03707.x)), gamification and autonomy ([JMIR Serious Games 2024](https://games.jmir.org/2024/1/e49029)), fatigue and rest ([PMC4942358](https://pmc.ncbi.nlm.nih.gov/articles/PMC4942358)), head arrays and switches ([Sunrise Medical](https://SunriseMedical.com/education-in-motion/blog/january-2024/prescribing-wireless-power-wheelchair-head-control)).

## Head control

Calibration takes about 10 seconds: relax → steer left → steer right → GO movement. It automatically picks:
- **Steering:** head *tilt* or head *turn*, whichever the player actually did more clearly.
- **GO:** open mouth, raise eyebrows, smile, pucker or puff cheeks, whichever moved most.

Movements are scaled to each player's own range: 70% of their calibrated movement counts as full input. If the camera loses the face, GO drops to zero and the car stops. Video never leaves the phone.

## Steering feel

Small head movements give small turns: the first 20% of a movement is ignored, and a curve keeps the middle range gentle. Players choose **Gentle / Normal / Sharp** on the waiting screen (Normal is the default; Sharp is close to the original, twitchier feel). The car also turns a little less at top speed.

## Look

A light, soft-lit toy world in Three.js, laid out like bruno-simon.com but in its own colours: each course is a bevelled island with a glowing rim floating over a pale grid, with rounded trees, paved road, red-and-white curbs, chevron boost pads, gates with lifting arms, 3D course lettering and a rounded coral car. Each unit has a theme (lake, forest, canyon, beach, park). Menus show the next course from above, a stop shows its island, lessons and races use a chase camera, and the big screen shows the course being raced. The interface is framed paper panels and square icon buttons with toasts for achievements. Titles are Amatic SC and everything you read is Nunito. Unit colours are sky, mint, coral and sun, with violet for the Grand Prix. Three.js and the fonts load from CDNs, so phones need internet, which the tunnel already requires.

## Race rules

- One driver at a time, for boss races and the Grand Prix alike. Everyone else waits in the queue and can practise with live meters. Lessons run on each phone at the same time and don't need the car.
- Each race has its own course: the Grand Prix park, Mirror Lake (Steady Run), Curvy Road, Red Canyon (Mouth Pedal) and Kiss Beach (Kiss Boost).
- Each star collected takes 2 s off your time. Some stars float above the jumps. Wall hits slow you down.
- **Jumps and boosts:** chevron pads give a speed burst, and ramps launch the car, with a boost pad before them for a big jump. Jumps never punish: a slow car just rolls off the lip. While the virtual car is in the air it can't steer, so the real car's steering is released too.
- Wooden crates by the road can be knocked flying. They're just for fun and cost nothing.
- Driving help: *No help* / *Some help* (slower, steering assist) / *Lots of help* (drives forward by itself). The level is shown as a tag on the leaderboard.
- Leaderboards: **Fastest Grand Prix** (best time per name) and **Most improved** (first run vs best run). Boss races use different controls, so their times stay off the leaderboard.
- The results screen shows exercise stats: head moves, GO reps, GO hold time, jumps, wall bumps.
- Results are saved in `data/results.json`, practice in `data/practice.json`, progress in `data/profiles.json`. Delete the `data` folder to reset everything.

## Troubleshooting

| Problem | Fix |
|---|---|
| ESP32 can't connect to WiFi | The ESP32 can't get through a WiFi login page or enterprise WiFi. Put the laptop and ESP32 on a phone hotspot. |
| "Car offline" but ESP32 is on WiFi | Check `SERVER_HOST`. Some guest WiFi blocks device-to-device traffic, so use a hotspot. Check the macOS firewall allows node. |
| Camera doesn't start on the phone | The page must be opened from the `https://…trycloudflare.com` link, not `http://`. On iPhone: Settings → Safari → Camera → Allow. |
| Face tracking slow on an old phone | Use touch controls, or lend a newer phone. |
| Real car too fast or drifts too much | Lower `SPEED_SCALE` in the firmware. |
