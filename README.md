# Nocturne

A private dream journal for two people. Open it, type, go back to sleep.

Every entry is encrypted on the phone before it leaves. The server stores
nothing but ciphertext — it cannot read your dreams, and neither can anyone who
gets hold of the database.

---

## Why not GitHub Pages

GitHub Pages only serves static files. It has no server and no database, so it
cannot check a password, cannot store an entry, and cannot keep two people's
journals apart. Any "login" you put on a Pages site is decoration — the data
would sit in the page for anyone to read.

This runs on **Cloudflare Workers** instead:

- Always on, no server to maintain, no cold starts.
- Free tier is far more than two people writing dreams will ever use.
- Real database (D1), real sessions, real password hashing.
- It can send push notifications on a schedule, which Pages cannot.

The app itself is still just HTML, CSS and JavaScript — no build step.

---

## How private it actually is

The threat this is built against is: *someone gets full access to the server and
the database.* Even then, they get nothing readable.

**Your passphrase never leaves your phone.** It is stretched with PBKDF2
(210,000 rounds of SHA-256) into a root secret, which HKDF then splits into two
unrelated halves:

| derived key | where it goes | what it does |
| --- | --- | --- |
| auth proof | sent to the server | proves who you are |
| vault key  | **never sent** | encrypts and decrypts your dreams |

Because the halves are independent HKDF outputs, the proof the server holds
reveals nothing about the key that opens your journal. The server then hashes
that proof *again* before storing it, so a stolen database does not even yield a
working login.

Entries are encrypted with **AES-GCM-256**. The entry's id is mixed in as
authenticated data, so a blob cannot be moved from one entry to another without
decryption failing.

Other things that follow from taking this seriously:

- **Only two accounts, ever.** Sign-up needs a setup code you choose, and the
  third registration is refused no matter what.
- **The two journals are separate.** Neither of you can read the other's
  entries — not through the app, not through the API.
- **Login throttling** backs off to 15 minutes after repeated wrong guesses,
  keyed on the username so switching networks doesn't help.
- **Usernames aren't discoverable.** Asking the server for an unknown user's
  salt returns a convincing fake one.
- **A strict Content-Security-Policy** (`script-src 'self'`, no inline script)
  means no third-party code can ever run on the page and reach the key.
- **Nothing external is loaded.** No CDNs, no analytics, no fonts from Google.
  The font is served from your own domain.
- **The vault key is stored non-extractably.** It survives app restarts so you
  are not typing a passphrase at 3am, but the raw bytes cannot be read back out
  of the browser, even by script on the page.

### The honest limits

- **Lose the passphrase and the dreams are gone.** There is no reset. That is
  what makes the rest true. Export a copy from Settings occasionally.
- **Timestamps are not encrypted.** The server can see *when* you wrote, and how
  long the entry is, just not what it says. This is what lets the list sort and
  group without decrypting everything first.
- **The phone is trusted.** Anyone holding your unlocked phone can read the
  journal. Turn on *Lock when I close the app* in Settings if that matters.

---

## Deploying from a phone

No computer needed. GitHub does the work; you just fill in three secrets in a
browser. Use a mobile *browser* rather than the GitHub app — the app can't
reach repository settings.

**1. Get a Cloudflare API token** — sign up at
[cloudflare.com](https://dash.cloudflare.com/sign-up), then go to
**My Profile → API Tokens → Create Token** and use the **Edit Cloudflare
Workers** template. Copy the token when it appears; it is shown once.

**2. Get your account ID** — on the Cloudflare dashboard home, open **Workers &
Pages**. The account ID is in the right-hand column (or in the URL after
`dash.cloudflare.com/`).

**3. Add three secrets to this repo** — go to **Settings → Secrets and variables
→ Actions → New repository secret**, and add:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | the id from step 2 |
| `SETUP_CODE` | invent one — you and your friend each use it once |

**4. Run it** — **Actions → Deploy Nocturne → Run workflow**.

It creates the database, builds the tables, deploys, and prints your URL in the
run summary. Every later push deploys again automatically.

There is no fourth secret to manage: `SALT_PEPPER` is generated on the first
run and then left alone forever.

### Then, on the iPhone

Open the URL in **Safari** → *First time here? Create your account* → your name,
a passphrase, and the setup code. Then **Share → Add to Home Screen**.

Send your friend the same link and setup code. After the second account,
sign-up closes permanently.

> Use a passphrase you will not forget — several unrelated words is both stronger
> and easier to remember than a mangled single word. There is no recovery.

---

## Deploying from a computer

If you do have a laptop, this is the shorter path. You need a free
[Cloudflare account](https://dash.cloudflare.com/sign-up) and Node installed.

```bash
npm install
npx wrangler login
```

**1. Create the database**

```bash
npx wrangler d1 create dreams
```

Copy the `database_id` it prints into `wrangler.toml`, replacing
`PASTE_YOUR_DATABASE_ID_HERE`.

**2. Create the tables**

```bash
npm run db:init
```

**3. Set the two secrets**

```bash
npx wrangler secret put SETUP_CODE    # invent one; you and your friend each use it once
npx wrangler secret put SALT_PEPPER   # random junk, set once, never changes
```

For `SALT_PEPPER`, paste the output of:

```bash
node -e "console.log(crypto.randomUUID() + crypto.randomUUID())"
```

**4. Deploy**

```bash
npm run deploy
```

Wrangler prints a URL like `https://dream-journal.<your-name>.workers.dev`. That
is the app, and it is now running 24/7. Claim the two accounts as described
above.

---

## Why Add to Home Screen matters

It is not only convenience: it drops the browser chrome, gives it
its own icon, makes it launch instantly offline, and it is the only way iOS will
allow notifications. Long-pressing the icon also gives a *Record a dream*
shortcut that opens straight into a blank entry.

---

## Notifications — yes, with one condition

**Yes, this can send notifications by itself**, including on iPhone. The
condition is that the app must be added to the Home Screen first. iOS does not
allow web push for a site open in a Safari tab — only for installed web apps
(iOS 16.4 and later). Once installed, it behaves like any other app's
notification.

Scheduling comes from **Cloudflare Cron Triggers**: the Worker wakes on a
schedule and pushes without your phone doing anything, so it works with the app
closed.

What is in place right now: the toggle in Settings, the permission request, the
reminder time, and the service worker code that receives a push and shows it.

What is not built yet: the server half — VAPID keys, storing push
subscriptions, and the cron job that signs and sends the message. That is a
contained next step, and the Settings toggle says so plainly rather than
pretending to work.

---

## What is in this version

The brief was iPhone first, then settings and design — so that is what is here,
and deliberately nothing more.

- **Lock screen** — sign in, or create one of the two accounts.
- **Journal** — dreams grouped by the night they belong to. Anything before noon
  files under the previous evening, because a dream at 3am on Tuesday was
  Monday night's.
- **Writing** — one tap from launch to a blinking cursor. No fields to fill in,
  no chrome. It saves itself, encrypted, two seconds after you stop typing, so a
  dream is never lost to a dropped phone or a closed app.
- **Works with no signal** — the app opens from cache and entries written
  offline are held on the phone and pushed when the network returns.
- **Settings** — account and passphrase, theme, text size, lock behaviour,
  reminders, export, delete.

Not built, on purpose: tags, search, mood tracking, sharing, statistics,
dream analysis.

### The design

Called **Nocturne**, and shaped by one situation: it is 3am, the dream is
already dissolving, and the screen is the only light in the room.

- **Warm ink, never blue-black.** Cold light at 3am is hostile to going back to
  sleep. There is a *Daybreak* parchment theme for reading back over coffee.
- **One typeface, [Fraunces](https://fonts.google.com/specimen/Fraunces),** run
  across its optical-size axis — 9pt for the small-caps labels, 144pt for the
  hanging hour numerals. One 118KB file covers the whole range, served from your
  own domain.
- **A ruled margin** runs the length of the journal with the times hanging off
  it, the way a bound notebook does.
- **Nothing flashes.** Motion is slow and low-contrast, and disappears entirely
  under `prefers-reduced-motion`.
- Tap targets are thumb-sized for someone half asleep, and the screen blurs the
  moment the app backgrounds so dreams aren't sitting in the app switcher.

---

## Working on it

```bash
npm run dev          # http://localhost:8787
npm run db:init:local
npm run seed         # a journal full of sample dreams: ada / correct-horse-battery
```

Local secrets go in `.dev.vars` (git-ignored):

```
SETUP_CODE=local-dev-code
SALT_PEPPER=anything-for-local
```

Tests need the dev server running in another terminal:

```bash
npm run test:api     # crypto, auth, seat limits, journal separation
npm run test:flows   # the UI: autosave, passphrase change, offline capture
npm run shots        # screenshots on an iPhone viewport → ./screenshots
```

`test:api` checks the claims above rather than trusting them — it dumps the
database and asserts the dream text is not in it.

### Layout

```
worker/index.js   API: auth, sessions, encrypted-blob storage
schema.sql        tables — note there is no column for dream text
public/
  index.html      all screens
  css/app.css     the design system
  js/crypto.js    key derivation, encrypt/decrypt
  js/store.js     offline cache, sync, retry queue
  js/app.js       screens and interactions
  sw.js           offline shell, push handling
```

Regenerate the icons after a palette change with `npm run icons`.
