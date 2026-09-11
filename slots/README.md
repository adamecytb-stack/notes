# Gumball Slot Machine — Build Plan

A countertop slot machine. You feed it fake coins, pull a real lever, three
mechanical reels spin and stop one at a time, and when you win it drops real
gumballs into a cup.

Roughly 240 × 220 × 380 mm, plus a gumball globe on top (~530 mm total).
Budget €170–230, about 25–35 hours of work across four to six weekends.

---

## 1. The machine in one picture

```
            ┌──────────────┐
            │   ( globe )  │   ~300 gumballs, gutted from a cheap
            │  ░░░░░░░░░░  │   toy gumball bank
            └──────┬───────┘
     ┌─────────────┴─────────────┐
     │  ★  L U C K Y  7 s  ★     │  marquee, NeoPixel backlit
     ├───────────────────────────┤
     │   ┌─────┬─────┬─────┐     │
     │   │ 🍋  │ 🔔  │ 🍒  │     │  window shows 3 rows,
     │   ├─────┼─────┼─────┤     │  centre row is the payline
     │   │ 🍒  │ 🍒  │ 🍒  │ ←── │
     │   ├─────┼─────┼─────┤     │
     │   │ 7️⃣  │ 🍉  │ 🍊  │     │        ╭───╮
     │   └─────┴─────┴─────┘     │        │   │ lever
     ├───────────────────────────┤       ╭┴───┴╮
     │  CREDITS 12   WON 4       │  OLED │     │
     ├───────────────────────────┤       ╰──┬──╯
     │  🍒🍒 = 2    3×7️⃣ = 20    │  paytable │
     │  3🍒 = 5     3🔔 = 10     │  card     │
     ├──────────┬────────────────┤
     │ coin ▭   │                │
     ├──────────┴────────────────┤
     │      ╭──────────╮         │
     │      │ gumballs │         │  delivery cup + flap
     │      ╰──────────╯         │
     └───────────────────────────┘
```

---

## 2. The rules

One token buys one spin. Only the centre row pays.

| Result | Pays |
|---|---|
| 7️⃣ 7️⃣ 7️⃣ — **JACKPOT** | **20 gumballs** |
| 🔔 🔔 🔔 | 10 |
| 🍉 🍉 🍉 | 8 |
| 🍊 🍊 🍊 | 6 |
| 🍋 🍋 🍋 | 5 |
| 🍒 🍒 🍒 | 5 |
| 🍒 🍒 — any two cherries | 2 |
| anything else | nothing |

**Only cherries pay on a pair.** This matters more than it looks — see §3.

---

## 3. The odds, and why they need tuning

This is the part that will bite you if you skip it. You are paying out in real
candy that you bought. Naive rules pay out an absurd amount.

### The reel strips

Each reel is a drum with **12 symbols** around it. The three drums are not
identical — real slot machines stagger them, and so should you:

| Symbol | Reel 1 | Reel 2 | Reel 3 |
|---|---|---|---|
| 🍒 cherry | 2 | 2 | 2 |
| 🍋 lemon | 2 | 2 | 2 |
| 🍊 orange | 2 | 2 | 2 |
| 🍉 melon | 2 | 2 | 2 |
| 🔔 bell | 1 | 1 | 2 |
| 7️⃣ seven | 2 | 2 | **1** |
| ⬜ blank | 1 | 1 | 1 |
| **total** | **12** | **12** | **12** |

Reel 3 carries only one 7. That single asymmetry is the whole trick: you will
see two 7s land about **once every 21 spins**, and the third reel will refuse
you most of those times. That near-miss is what makes the machine feel alive.

### What it actually pays

Exact probabilities, not simulated:

| Event | Chance | Pays | Gumballs per spin |
|---|---|---|---|
| 3× 7️⃣ | 1 in 432 | 20 | 0.046 |
| 3× 🔔 | 1 in 864 | 10 | 0.012 |
| 3× 🍉 | 1 in 216 | 8 | 0.037 |
| 3× 🍊 | 1 in 216 | 6 | 0.028 |
| 3× 🍋 | 1 in 216 | 5 | 0.023 |
| 3× 🍒 | 1 in 216 | 5 | 0.023 |
| 🍒🍒 exactly | 1 in 14 | 2 | 0.139 |
| | | **total** | **0.31** |

- **You win on about 1 spin in 11.**
- **About 31 gumballs per 100 spins.**
- A 40-token bank yields **~12 gumballs** per full session.
- A 600-gumball hopper lasts **~1,950 spins** before a refill.

### Three presets — pick one, it's one line of config

| Preset | 🍒🍒 pays | pairs that pay | you win | gumballs / 100 spins |
|---|---|---|---|---|
| Stingy | 1 | cherry only | 1 spin in 11 | **17.6** |
| **Balanced** ✅ | 2 | cherry only | 1 spin in 11 | **30.8** |
| Party | 2 | **any** pair | 1 spin in 2.6 | **88.4** |

(Stingy also trims the three-of-a-kinds: 7s pay 15, bell 6, melon/orange 4,
lemon/cherry 3.)

"Any pair pays 2" is the instinct everyone has — and it triples your candy
burn. Try Balanced first; it is easy to loosen later and miserable to tighten
after someone has got used to the payouts.

---

## 4. The four subsystems

| | Job | Built from |
|---|---|---|
| **Brain** | game logic, timing, ledger | Raspberry Pi Pico 2, MicroPython |
| **Reels** | 3 spinning drums that stop where told | NEMA 17 steppers + A4988 drivers + opto homing |
| **Money in** | accept a token, add a credit | CH-926 coin acceptor + token drawer |
| **Candy out** | drop exactly N gumballs | motorised gumball dial + IR counter |

Plus: lever, OLED, NeoPixels, speaker, cabinet.

---

## 5. Bill of materials

| Part | Qty | ~€ | Notes |
|---|---|---|---|
| Raspberry Pi Pico 2 | 1 | 8 | MicroPython. Pico W if you ever want stats over wifi |
| NEMA 17 stepper, 40mm | 3 | 30 | pancake (20mm) if depth is tight |
| A4988 driver + heatsink | 3 | 9 | DRV8825 also fine |
| Slotted opto interrupter (ITR9608 module) | 3 | 4 | reel homing |
| CH-926 programmable coin acceptor | 1 | 14 | learns your token, rejects everything else |
| 25mm arcade tokens | 40 | 10 | this *is* your economy — see §7 |
| Cheap toy gumball bank | 1 | 12 | you are buying it to gut it |
| MG996R servo (or continuous-rotation FS90R) | 1 | 6 | turns the dispenser dial |
| IR break-beam pair | 1 | 3 | counts gumballs leaving the chute |
| SSD1306 OLED 128×64 I2C | 1 | 4 | credits display |
| DFPlayer Mini + 8GB microSD + 3W speaker | 1 | 9 | reel clicks, win jingle, jackpot fanfare |
| WS2812B strip, 60 LED/m | 1m | 7 | marquee + window backlight |
| Snap-action microswitch | 2 | 2 | lever, coin-door |
| Extension spring + lever hardware | 1 | 8 | or print the arm, buy the spring |
| 12V 4A PSU + barrel jack | 1 | 13 | |
| LM2596 buck converter 12V→5V 3A | 1 | 4 | powers Pico, servo, LEDs |
| Capacitors: 1000µF ×1, 100µF ×3 | — | 3 | **the 100µF across each A4988 VMOT is mandatory** |
| Perfboard, JST connectors, screw terminals, wire | — | 14 | |
| 6mm plywood 600×600 | 1 | 15 | or 3D print the panels |
| 3mm clear acrylic offcut | 1 | 6 | reel window |
| Gumballs, ½" (12.7mm) | ~600 | 15 | ½" not 1" — half-inch is much kinder to a small build |
| Screws, standoffs, hot glue, filament | — | 15 | |
| | | **~€211** | |

Drop to the 28BYJ-48 budget path (§8) and it's about €175, but read the warning
there first.

**Tools:** soldering iron, multimeter, drill, saw or laser-cutter access, 3D
printer (or an online print service), calipers, hot glue.

---

## 6. Wiring

### Pin map (Raspberry Pi Pico)

| Pin | Goes to |
|---|---|
| GP2 / GP3 | Reel 1 STEP / DIR |
| GP4 / GP5 | Reel 2 STEP / DIR |
| GP6 / GP7 | Reel 3 STEP / DIR |
| GP8 | ~ENABLE, shared by all three A4988s |
| GP9 / GP10 / GP11 | Reel 1 / 2 / 3 home sensor |
| GP12 | Coin acceptor pulse (interrupt) |
| GP13 | Lever microswitch (interrupt) |
| GP14 | Dispenser servo PWM |
| GP15 | Gumball IR beam (interrupt) |
| GP16 | NeoPixel data |
| GP17 | Coin-door switch |
| GP0 / GP1 | OLED I2C — SDA / SCL |
| GP20 / GP21 | DFPlayer UART TX / RX |

20 of 26 usable pins. Room left for whatever you think of later.

### Power

```
12V 4A PSU ──┬── A4988 VMOT ×3   (100µF each, right at the pin)
             │   + 1000µF bulk across the rail
             └── LM2596 buck → 5V ──┬── Pico VSYS
                                    ├── servo
                                    ├── NeoPixels
                                    └── DFPlayer
```

Three things that will cost you an evening if you get them wrong:

1. **Every ground ties together.** One star point. Not a daisy chain.
2. **The 100µF across each A4988's VMOT is not optional.** The datasheet says so
   and the failure mode is a dead driver, not a warning.
3. **Set the A4988 current limit before the motors ever move.** Vref ≈ 0.35V
   (about 0.7A/phase) is plenty for a light plastic drum, and runs cool.

---

## 7. Mechanical design

### Reels

- **Drum:** 80mm diameter, 45mm wide, 3D printed. 12 symbols × 21mm gives a
  252mm circumference — that's exactly 80mm across.
- **Symbols:** print the strip on matte photo paper and slide it into a lip on
  the drum. **Do not print the symbols into the plastic.** Paper strips mean
  retuning the odds is a reprint, not a reprint *and* a re-mount.
- **Hub:** printed, 5mm D-bore, press fit onto the motor shaft. Grub screw if
  you don't trust the fit.
- **Homing:** a 3mm tab on the drum rim passes through the opto interrupter.
  That's position 0.
- **The click:** glue a springy plastic tab against 12 shallow notches on the
  drum rim. It ticks once per symbol as the reel passes. It costs nothing and it
  is the single best sound on the machine — better than anything the speaker
  does.

### Step maths

800 steps/rev at 1/4 microstepping. 800 ÷ 12 = 66.67 steps per symbol, which
isn't a whole number, so precompute the stops instead of accumulating:

```python
STOPS = [round(i * 800 / 12) for i in range(12)]
# [0, 67, 133, 200, 267, 333, 400, 467, 533, 600, 667, 733]
```

Worst-case error is half a step — 0.22° — invisible. And because you re-home
during every spin (§8), it never accumulates.

Target **2 revolutions/second**, which is 24 symbols/second: fast enough to blur
properly. That's 1600 step pulses/sec per motor, 4800 total, which plain
MicroPython handles at maybe 15% of one core. If you later want a faster spin,
move the pulse generation to the RP2040's PIO state machines — there are 8 of
them, one per motor, and it's the standard upgrade path.

### Gumball dispenser — the important shortcut

**Do not design a dispenser.** Buy a €12 toy gumball bank, take the globe and
the dial mechanism, throw away the rest. The dial already contains the exact
mechanism you need: a disc with one gumball-sized pocket that captures one ball
per revolution and drops it down a chute.

Couple the servo to the dial shaft. Then — and this is what makes it reliable —
**don't count revolutions, count gumballs.** An IR beam across the chute counts
each ball as it falls. To pay out 4, you turn the dial until the beam has
counted 4. Slip, jam, an oddly-shaped gumball: none of it matters, because you
are measuring the thing you actually care about.

Jam and empty handling:

```
turn dial → wait for beam
  no ball within 3s → reverse 180°, retry
  3 failed retries  → hopper empty or jammed:
                      park the unpaid gumballs in the owed ledger,
                      flash the marquee red, say so on the OLED
```

The gumballs fall through the beam in about 6ms, so read it on a pin interrupt,
not in a polling loop.

### Coin path

Token → CH-926 acceptor → falls into a drawer at the bottom of the cabinet.
No coin hopper, no payout mechanism — the machine never gives coins back.

**This is deliberate, and it's your whole economy.** Make 40 tokens. When they
are gone, they are in the drawer, and playing more means physically opening the
drawer and re-feeding them. That pause is a much better session limit than
anything you could write in software, and it's free.

### Lever

Pivoting arm on the right side, extension spring pulling it back up, snap-action
microswitch tripped at the bottom of its travel. Print the arm, or use a bike
brake lever, or a drawer handle on a bolt. The switch should only arm a spin
when credits ≥ 1 — pulling an empty machine should click and do nothing.

### Cabinet

240 W × 220 D × 380 H, 6mm plywood, butt joints with glue blocks inside. Front
panel is a separate removable piece held by four screws — you will be taking it
off constantly.

Front layout, top to bottom: marquee → reel window (145 × 65mm acrylic, 3 rows
visible) → OLED → paytable card → coin slot → delivery cup.

Everything electronic mounts to a single plywood backplate that slides out. Do
not glue the electronics to the cabinet. You will regret it.

---

## 8. Software

MicroPython on the Pico. Layout:

```
slots/firmware/
  main.py         boot, wire it together, main loop
  config.py       EVERY tunable: pins, reel strips, paytable, timings
  game.py         pure logic, zero hardware imports
  reels.py        stepper control, homing, the spin choreography
  dispenser.py    servo + beam counting + jam/empty recovery
  coins.py        acceptor pulse counting, debounce
  lever.py        switch debounce
  display.py      OLED
  lights.py       NeoPixel patterns
  sound.py        DFPlayer
  ledger.py       persistent stats + owed balance
slots/tools/
  simulate.py     run 10M spins on your laptop, print EV and hit frequency
  test_game.py    unit tests for the paytable
```

**`game.py` imports nothing hardware-specific.** It takes three reel positions
and returns a payout. That means you can run the entire game on your laptop
under normal CPython — play it in a terminal, unit-test the paytable, simulate
ten million spins to check my numbers in §3 — before a single part arrives. For
a Python-first build this is the highest-leverage decision in the whole project,
because it moves all the thinking to where you're fastest.

### The spin — where the feel comes from

| t (ms) | What happens |
|---|---|
| 0 | Lever bottoms out. Click. Credit −1. Reels release. |
| 0–300 | All three ramp up to 2 rev/s |
| 300–1500 | Full speed. Each reel passes its home flag — **re-sync here**, silently |
| 1500 | Reel 1 decelerates, stops on target. Clunk. |
| 1900 | Reel 2 stops. |
| 2500 | Reel 3 stops. |
| — | Evaluate → lights → sound → dispense |

**The anticipation rule:** if reels 1 and 2 match, reel 3 does not stop at 2500.
It drops to a slow crawl for another 800–1200ms, ticking symbol by symbol, and
*then* stops. Two 7s showing and the third reel crawling is the best three
seconds the machine has. This one `if` statement is the difference between a toy
and something people queue up to pull.

Re-syncing on the home flag mid-spin is why you never need a slow homing pass
before each spin — the reel is already turning, the flag goes by, you know
exactly where you are, and you step the remainder to the target.

### Idle power

**De-energise the stepper coils between spins** (drop ~ENABLE). Otherwise three
motors sit there holding torque, drawing current and getting warm for no reason.
The reels are light enough that they stay put on their own.

### The ledger

You said you want to track what you're owed, so the machine keeps a real ledger
in flash:

- **Owed** — wins it couldn't pay because the hopper was empty or jammed. Paid
  out automatically on the next successful dispense.
- **Lifetime** — spins, tokens in, gumballs won, gumballs actually dispensed,
  jackpots, biggest win, date of last hopper refill.

Write only on change (a coin, a win, a dispense), write to a temp file and
rename, so a power cut mid-write can't corrupt it. That's a handful of writes
per session against ~100k flash write cycles — you'll never get near the limit.

Plug a laptop into the USB port and the MicroPython REPL is right there: dump
the ledger as CSV, retune the paytable, re-run a reel, all without opening the
cabinet.

### Diagnostic mode

Hold the lever while powering on. OLED menu, lever taps to navigate:

```
1 test reel 1/2/3     spin each reel through all 12 stops
2 home all            verify every opto sensor fires
3 dispense one        the test you will run most
4 coin test           show pulses as they arrive
5 sound test          play each track
6 show ledger
7 reset ledger        (asks twice)
```

Build this in Phase 2, not at the end. You will use it hundreds of times.

---

## 9. Build order

Eight phases. Each one ends in something that works, so you're never staring at
a pile of parts wondering if any of it is right.

| # | Phase | You'll know it's done when | ~hrs |
|---|---|---|---|
| 0 | **Order parts** | Everything ordered. Steppers and coin acceptor first — longest lead times. | 1 |
| 1 | **Game on your laptop** | `game.py` + `simulate.py` run under CPython. You've played 50 terminal spins and simulated 10M to confirm the EV. **Do this while the parts ship.** | 4 |
| 2 | **One reel turns** | Pico + one A4988 + one motor on a breadboard. It homes, then stops on any of 12 positions on command. Diagnostic menu exists. | 5 |
| 3 | **Three reels spin** | All three, staggered stops, mid-spin re-sync, anticipation on a near-miss. Bare drums, no cabinet. This is the moment it starts being fun. | 5 |
| 4 | **Coins and lever** | Acceptor programmed to your token, credits increment, lever pulls a spin, empty machine refuses. | 3 |
| 5 | **Candy** | Bank gutted, servo coupled to the dial, beam counting, dispenses exactly N, survives a deliberate jam. **Budget a whole session for jams.** | 6 |
| 6 | **Lights, sound, display** | Marquee, window backlight, reel clicks, win jingle, jackpot fanfare, credits on the OLED. | 4 |
| 7 | **Cabinet** | Cut, assembled, backplate populated, front panel screwed on, paytable card printed and mounted. | 8 |
| 8 | **Tune and play** | 200 real spins. Count the gumballs. Adjust the paytable against what §3 predicted. | 3 |

Phase 1 is not filler. By the time the steppers land you'll have already decided
the paytable, and every phase after that is hardware serving a game you've
already played.

---

## 10. What will go wrong

| Risk | Severity | What to do |
|---|---|---|
| **Gumball jams** | High — this is the #1 problem | Count the output, never the motor turns. Reverse-and-retry on timeout. ½" gumballs, not 1". Keep the chute ≥18mm ID and as straight as you can. |
| Motor noise resetting the Pico | Medium | Star ground, 1000µF bulk, 100µF at each VMOT, and keep stepper wires away from the sensor runs. |
| Reels drift out of alignment | Medium | Mid-spin re-sync makes this nearly impossible. If it still happens, your home flag is bouncing — add a 10ms software debounce. |
| Coin acceptor takes random washers | Low | Program it carefully with 20+ samples of your token; set its accuracy pot tighter. |
| Gumballs go sticky | Medium | Humidity. Keep the globe closed, don't leave stock in it for months, buy smaller quantities more often. |
| A4988s run hot | Low | You set the Vref too high. 0.35V. Heatsinks on regardless. |
| ½" gumballs near small children | — | Choking hazard. Worth knowing about the machine you're building. |

One legal footnote, since the word "gambling" is in the brief: a private
amusement device that takes no real money and pays no cash prize is a toy.
Keep it that way — don't put it somewhere public taking real coins.

---

## 11. Stretch goals

Things to leave room for but not build now:

- **Hold buttons.** Three buttons letting you freeze a reel and respin the other
  two. Changes the odds substantially — re-run `simulate.py` first.
- **Nudge.** A rare "nudge" symbol that lets you step one reel by one position.
- **Progressive jackpot.** Every losing spin adds 0.02 to a pot shown on the
  OLED; three 7s pays the pot instead of a fixed 20.
- **Pico W + stats page.** Lifetime ledger on a web page on your LAN.
- **Second token slot** that takes 5 tokens for a 5× spin.
- **Printed receipt** on a tiny thermal printer. Completely unnecessary. Very
  funny.

---

## 12. Decisions still open

Answer these and the plan is fully specified:

1. **Steppers.** NEMA 17 (recommended, above) or the €18-cheaper 28BYJ-48 path?
   The 28BYJ-48 tops out near 15 RPM — your reels would *scroll* at about 3
   symbols/sec instead of spinning. It works, it's simpler wiring and a single
   5V rail, but it doesn't look like a slot machine. I'd spend the €18.
2. **Cabinet.** Plywood (needs a saw, looks warmer) or fully 3D printed (needs a
   printer bed of ~250mm, or a print service, but every mount is exact)?
3. **Paytable.** Stingy, Balanced, or Party from §3?
4. **Token count.** 40 is my suggestion — roughly a 12-gumball session.

---

## 13. Next step

Say the word and I'll write Phase 1: `game.py`, `config.py`, `simulate.py` and
`test_game.py` — the whole game as plain Python you can play in a terminal
tonight and tune before you order a single part.
